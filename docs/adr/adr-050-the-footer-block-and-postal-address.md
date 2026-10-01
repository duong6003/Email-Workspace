# ADR-050: Khối chân thư và địa chỉ bưu chính — nửa còn lại của §4 đóng theo

Status: Accepted

Trả nốt nửa còn lại của món nợ CAN-SPAM mà ADR-049 để ngỏ. Không mở thêm allowlist nào (khác
ADR-048), không route mới, không migration. Một *kind* mới, một trường bắt buộc trên
`PublishDraft`, một cổng chặn xuất bản mới.

## Context

### Nửa opt-out đã xong, nửa còn lại thì chưa có gì

ADR-049 §Consequences ghi rõ: "Địa chỉ bưu chính / khối chân thư vẫn chưa có... ADR này làm
nửa opt-out; nửa kia là quyết định riêng." Sổ nợ rà soát §4 nói tương tự: "Không có khối chân
thư chuyên dụng, và không kiểm địa chỉ bưu chính — CAN-SPAM đòi địa chỉ vật lý với email
thương mại. Repo hiện không có chữ nào về việc này."

Đo lại thay vì tin lời: grep toàn repo cho `postal`/`address`/`CAN-SPAM`/`mailing address`
ngoài chính sổ nợ và ADR-049 — **không có gì**. Prototype (`studio.tsx`) cũng không có: khai
báo `type Kind` của nó liệt kê đúng mười sáu giá trị, không cái nào là chân thư hay địa chỉ.
Đây là năng lực EOW **thêm vào**, không phải một cái đã có mà bị mất — khác `contact` (ADR-044,
mất vì không ai ghi lại), giống `list` (ADR-048, chưa từng tồn tại ở đâu).

### Đo qua sanitizeTemplateHtml trước khi quyết định gì (probe 2026-09-11)

Theo đúng phương pháp §11 của sổ nợ: chạy thẳng `sanitizeTemplateHtml`, ghi kết quả ra tệp,
không đo qua `dist/`. Dựng sẵn markup dự kiến của `emitFooter` — một `<p>` dùng đúng bảy thuộc
tính `emitContact`/`emitList` đã dùng — rồi đưa qua sanitizer thật:

| Đưa vào | Nhận lại |
|---|---|
| `<p class="mc-dark-ink" style="margin;padding;color;text-align;font-family;font-size;line-height">` + hai dòng địa chỉ tiếng Việt có dấu, nối bằng `<br>` | **nguyên vẹn byte-for-byte**, `warnings: []`, `changes: []` |
| Cùng đoạn văn nhưng chèn `<script>`/`<img onerror>` chưa qua `escapeHtml` | `<script>` bị xoá, `onerror` bị xoá, `<img>` không-https bị xoá nguồn — sanitizer vẫn là lớp phòng thủ thứ hai thật, dù `emitFooter` đã escape mọi chuỗi tác giả gõ |

Kết luận đo được: **khối này không cần mở thêm thuộc tính CSS nào.** Đếm lại `allowedStyles['*']`
trong `template-html-sanitizer.ts` (không tin con số "27" đã cũ trong doc comment §6 của
`emitter.ts` — nó viết trước khi ADR-048 thêm `list-style-type`): **32 thuộc tính**, và bảy
thuộc tính `emitFooter` cần (`margin`, `padding`, `color`, `text-align`, `font-family`,
`font-size`, `line-height`) đều đã nằm trong đó. Khác ADR-048 (phải mở `list-style-type`), ADR
này không đụng sanitizer.

### Không có nơi nào để tái dùng địa chỉ mặc định cấp tenant

Kiểm `apps/web/src/screens/settings` — `sender-settings.test.ts` có chữ "address" nhưng đó là
địa chỉ SMTP người gửi (`Sender address rejected`), không phải địa chỉ bưu chính. Không có
trường "địa chỉ công ty" cấp tenant nào để kế thừa mặc định. Khối chân thư vì vậy là nơi duy
nhất, đúng như luật đòi: địa chỉ vật lý phải **nằm trong chính email thương mại**, không phải
một cài đặt tách rời có thể không bao giờ được chèn vào.

## Decision

### 1. `footer` là một leaf kind mới

Thêm vào `LEAF_KINDS` (`document.ts`), ngay sau `contact`. Vì `KINDS` là mảng runtime mà cả
`ARCH-BUILDER-SANITIZER` (mẫu sanitizer) lẫn `ARCH-MAILCRAFT-SOURCE` (khớp với prototype) đều
đọc trực tiếp, thêm kind này bắt hai cổng phải đỏ cho tới khi có mẫu — đúng cơ chế ADR-048 mô
tả trong Context của chính nó. `ARCH-MAILCRAFT-SOURCE` đặc biệt: nó so `KINDS` với
`[...prototypeKinds(), ...ADDED_KINDS]`, và vì `footer` không có trong prototype, nó phải vào
`ADDED_KINDS` trỏ về chính tệp ADR này — góc còn lại của cơ chế "độ lệch có chủ ý phải có địa
chỉ" mà ADR-044 khoản 4 đặt ra.

### 2. `FooterBlock` — hai trường, không phải một khối văn bản tự do

```ts
export type FooterBlock = {
  companyName: string;
  address: string;
};
```

Tách làm hai, theo đúng tiền lệ `ContactBlock`: cổng chặn xuất bản (mục 5 dưới đây) phải kiểm
được **đúng một trường** mà luật đòi, và không thể làm việc đó đáng tin cậy trên một khối văn
bản tự do lẫn cả tên công ty. `companyName` không bị pháp luật đòi và cổng không bao giờ đọc
nó — nó tồn tại vì một địa chỉ không có tên phía trên đọc như một mảnh vỡ, không phải một chữ
ký chân thư thật.

`address` có thể nhiều dòng (số nhà/đường · phường/quận/thành phố · quốc gia): tách theo `\n`,
mỗi dòng một đoạn, dòng trắng bị bỏ — đúng quy ước ADR-048 đã đặt cho `content` của `list`.

### 3. `emitFooter` — một `<p>`, không thuộc tính mới

```ts
function emitFooter(n: Node): string {
  const f = n.footer;
  if (!f) return '';
  const addressLines = (f.address ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
  const name = f.companyName?.trim();
  const parts = [...(name ? [escapeHtml(name)] : []), ...addressLines.map((line) => escapeHtml(line))];
  if (parts.length === 0) return '';
  // margin/padding/color/text-align/font-family/font-size/line-height —
  // bảy thuộc tính đã có trong allowlist, đo ở Context.
  return `<p${darkInkClass(n)} style="...">${parts.join('<br>')}</p>`;
}
```

Tên công ty rồi các dòng địa chỉ, nối bằng `<br>`, dòng rỗng bị bỏ hoàn toàn (không để lại
`<br>` mồ côi) — đúng cách `emitContact` bỏ một trường rỗng thay vì để lại dấu `·` trơ. Khối
trống (cả hai trường trắng) emit ra chuỗi rỗng, như một ảnh không có `src`.

### 4. Inspector: hai trường bespoke, không phải hàng generic

`inspector-fields.ts` chỉ cho `footer` các trường vô hướng (`align`, `textColor`, `fontSize`) —
đúng lý do `contact`/`table`/`social` đã nêu: `InspectorField` không có hình dạng cho một object
lồng. `companyName`/`address` có `FooterEditor` riêng trong `BuilderScreen.tsx` (input text +
textarea), sao y `ContactEditor` — `address` là **textarea**, không phải input một dòng như
`ContactEditor`'s `address`, vì `emitFooter` tách nó theo `\n` và trường phải cho tác giả gõ
được dòng mới.

Trường khởi tạo trắng cả hai (`createNode` trong `blocks.ts`), theo đúng lý do `contact` đã ghi:
một địa chỉ bịa còn tệ hơn một ô trống — `LINK_PLACEHOLDER` tồn tại chính vì dữ liệu mẫu có thể
lọt tới người nhận thật. Cái chặn một địa chỉ trắng khỏi xuất bản là mục 5, không phải giá trị
seed.

### 5. Cổng chặn xuất bản: đọc CÂY tài liệu, không đọc markup đã dựng

Khác `MISSING_UNSUBSCRIBE_URL` (ADR-049) — cái đó regex tìm token `{{unsubscribe_url}}`, một
biến thật sự tồn tại trong `html`/`textBody` — địa chỉ bưu chính không có token: nó là nội dung
tác giả gõ thật, được `emitFooter` dựng thẳng thành chữ. Không có mẫu nào để regex dò ra "đây
có phải một địa chỉ" một cách đáng tin. Nên `hasPostalAddress` đọc `draft.doc` — chính cái cây
`freezeSummary` đã nhận làm tham số — thay vì đọc `draft.html`:

```ts
function hasPostalAddress(nodes: readonly Node[]): boolean {
  return nodes.some((node) => {
    if (node.visible === false) return false;
    if (node.kind === 'footer' && node.footer?.address?.trim()) return true;
    return hasPostalAddress(node.children ?? []);
  });
}
```

`PublishDraft` (`publish-readiness.ts`) vì vậy có thêm một trường bắt buộc: `doc: Doc`. Caller
duy nhất (`BuilderScreen.tsx`) đã có sẵn state `doc` này (cùng cái `freezeSummary` đọc), nên chỉ
cần truyền thêm, không cần round-trip mới.

`node.visible === false` bị loại có chủ ý: một khối ẩn không emit gì (`emitNode`), nên địa chỉ
trong đó không bao giờ tới tay người nhận thật — thỏa mãn luật trên cây tài liệu mà không thỏa
mãn luật thật là một cổng rởm.

`MISSING_POSTAL_ADDRESS` được đẩy vào `blocking`, tính trực tiếp từ `draft.doc` giống cách
`MISSING_UNSUBSCRIBE_URL` tính trực tiếp từ `draft.html`/`draft.textBody` — không chờ round-trip
phân tích của server.

### Cái gì không đổi

- `allowedStyles` trong `template-html-sanitizer.ts`: **không đổi**, đo ở Context. Không cần
  sửa `docs/frontend/mailcraft-integration-requirements.md` §1.3 (khác ADR-048, ADR đó bắt
  buộc phải sửa vì đổi allowlist).
- ADR-037 §2 (`@media` bị strip): không bị đảo, khối này không dùng `@media`.
- Không route mới, không migration: khác ADR-049, đây không phải dữ liệu theo từng người nhận —
  địa chỉ là hằng số của một template, sống trong `Doc` JSON như mọi khối khác (`list`, `contact`
  đều không cần bảng riêng).
- `apps/api/src/templates/template-content-lint.ts`: **không thêm mã lint thứ 7**. Xem "Phương
  án đã cân nhắc và loại".

## Consequences

**Bảng cổng (đã mutation-test, không phải checklist):**

| Gì phải giữ | Test |
|---|---|
| `footer` phải có mẫu qua sanitizer thật, khai cả hai trường | `builder-block-sanitizer.test.ts` `sampleNodes.footer` (comment tự giải thích: mẫu một dòng sẽ không thử `\n`-split) |
| `footer` phải có mặt trong `ADDED_KINDS` trỏ đúng file ADR này | `mailcraft-fidelity.test.ts` `ARCH-MAILCRAFT-SOURCE` |
| Escape cả `companyName` lẫn `address`, qua cả emitter lẫn sanitizer thật | `emitter.test.ts`, `builder-block-sanitizer.test.ts` |
| Ba trường inspector (`align`/`textColor`/`fontSize`) phải thật sự đổi HTML khi khối đã có dữ liệu | `inspector-effect.test.ts` (mẫu khối trắng ban đầu bị coi là "chết" nếu không seed dữ liệu dò — cùng bẫy `contact` đã gặp) |
| Chặn xuất bản khi: không có khối `footer`; có khối nhưng `address` trắng; khối `footer` bị ẩn (`visible:false`) dù có địa chỉ; **không** chặn khi thiếu `companyName` (luật chỉ đòi địa chỉ) | `publish-readiness.test.ts` `describe('ADR-050: MISSING_POSTAL_ADDRESS ...')` — bốn ca, mutation-tested: từng ca loại một cách rubber-stamp gate có thể lọt (chỉ kiểm `kind==='footer'`, kiểm sai trường, bỏ qua `visible`) |
| Mọi `draftOf`/`readyDraft` khác trong repo (không kiểm địa chỉ) vẫn xanh | `publish-readiness.test.ts`, `mailcraft-business-rules.test.ts`, `mailcraft-fidelity.test.ts` — mỗi nơi đổi fixture mặc định sang có `footer.address` thật, đúng cách chúng đã làm cho `{{unsubscribe_url}}` |

**Còn nợ, cố ý không làm ở đây:**

- Không có địa chỉ mặc định cấp tenant để tự điền — mỗi template tự đứng, tác giả phải tự điền
  mỗi lần. Đo được (Context): không có hạ tầng nào để kế thừa từ, và xây một cái là quyết định
  UI/sản phẩm riêng, không phải điều kiện để đóng nợ CAN-SPAM này.
- Không kiểm định dạng địa chỉ (không đòi có số, có quốc gia, v.v.) — `hasPostalAddress` chỉ
  đòi chuỗi không rỗng sau khi `trim()`. Một chuỗi vô nghĩa vẫn qua được cổng; luật đòi có địa
  chỉ thật, không đòi máy xác thực địa chỉ đó tồn tại — việc đó ngoài khả năng của một trường
  văn bản.
- `apps/web/e2e/mailcraft-canvas-fidelity.spec.ts` không có mục cho `.v3-p-footer` — đúng tiền
  lệ ADR-048 cũng không có mục cho `.v3-p-list` khi nó ra đời; file đó kiểm một danh sách chọn
  tay, không suy ra từ `KINDS`.
- `docs/frontend/mailcraft-integration-requirements.md` §1.3 vẫn còn ghi "27 thuộc tính" —
  stale từ trước ADR-048, ADR này không làm nó stale hơn (không đổi con số thật), và sửa nó
  không phải việc của ADR này.

## Phương án đã cân nhắc và loại

- **Một trường văn bản tự do thay vì tách `companyName`/`address`.** Loại: cổng chặn xuất bản
  khi đó phải đoán dòng nào là "địa chỉ" trong một khối văn bản tự do — không đáng tin. Trường
  `address` tách riêng là thứ duy nhất có thể kiểm chắc chắn.
- **Regex dò "trông giống địa chỉ" trên `draft.html` đã dựng**, giống cách `MISSING_UNSUBSCRIBE_URL`
  dò token. Loại: không có mẫu — địa chỉ là văn bản tự do thật, không phải một token cố định như
  `{{unsubscribe_url}}`. Đây chính là điều ADR-049 đã tránh làm (không đoán, dùng token thật);
  áp dụng lại nguyên tắc đó ở đây nghĩa là đọc cây, không đọc markup.
- **Cảnh báo (`warning`) thay vì chặn (`blocking`).** Loại: CAN-SPAM là yêu cầu pháp lý như
  BR-TPL-008, không phải một tiện nghi. ADR-049 đã lập tiền lệ: yêu cầu pháp lý thì chặn.
- **Địa chỉ mặc định cấp tenant, tự điền vào mọi template.** Hoãn, không loại hẳn — là một quyết
  định thật với UI riêng (một trang "Cài đặt gửi thư" cần trường mới, một cách hợp nhất với
  `sender-settings`), ngoài phạm vi đóng nợ mục 6b. Khối chân thư trong tài liệu là điều kiện
  luật đòi (địa chỉ phải nằm TRONG email); một cài đặt tách rời không tự động thỏa mãn điều đó
  nếu tác giả quên chèn khối.
- **Thêm mã lint thứ 7 (`MISSING_POSTAL_ADDRESS`) vào `template-content-lint.ts`** song song với
  cổng chặn ở `publish-readiness.ts`. Loại: tiền lệ BR-TPL-008/`MISSING_UNSUBSCRIBE_URL` là một
  cổng client-side độc lập, không phải mã lint server — giữ một nguồn thẩm quyền thay vì hai cái
  có thể lệch nhau, đúng lý do `publish-readiness.ts`'s doc comment đã nêu cho quyết định đó.
