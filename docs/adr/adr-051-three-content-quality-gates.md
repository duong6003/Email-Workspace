# ADR-051: Ba cổng chất lượng nội dung — Gmail 102KB, thứ tự tiêu đề, tương phản WCAG

Status: Accepted

Đóng nửa mục #7 trong thứ tự đề nghị của sổ nợ (§10): §5 "cổng chất lượng nội dung". Sáu cổng
được nêu; ADR này dựng **ba** cổng mở rộng cơ chế `template-content-lint.ts` sẵn có một cách cơ
học, đo và mutation-test đầy đủ. Ba cổng còn lại — độ dài preheader/subject, tỉ lệ ảnh/chữ +
từ khoá spam, xem trước dark mode/Outlook — bị hoãn có địa chỉ, xem §Phương án đã cân nhắc.

## Context

### Sáu mã lint hiện có, và lỗ hổng drift đã đo được

`apps/api/src/templates/template-content-lint.ts` nhận đúng `{ html: string; textBody: string }`
— không có `subject`, không có trường `preheader` riêng, không đọc cây `Doc`. Sáu mã hiện có đều
đọc chuỗi HTML đã dựng bằng regex (`<img>`, `<a href>`), không đọc cây builder — nên chạy được
cả trên template `origin: 'imported'` (dán HTML thô, chưa từng có cây).

Đo được: `TemplateLintIssue['code']` là một union chữ, chép tay ở **bốn** chỗ (file này,
`apps/web/src/api/templates.ts`, `contracts/openapi.yaml`, và `publish-readiness.ts`'s
`LINT_ORDER`) — không có gì kiểm chúng khớp nhau. `LINT_MESSAGE` (`lint-messages.ts`) là ngoại
lệ: kiểu `Record` ánh xạ trên chính union đó nên trình biên dịch bắt buộc phải có bản dịch cho
mọi mã. `LINT_ORDER` thì không — một mã mới thêm vào file gốc mà quên thêm vào `LINT_ORDER` vẫn
biên dịch sạch, chỉ đơn giản không bao giờ hiện trong sheet xuất bản. Đây đúng hình dạng lỗi
sổ nợ §0 đã ghi cho `ARCH-MAILCRAFT-DOM`/kind mới: một danh sách tự chép tay không có gì buộc
phải đồng bộ.

### Gmail 102KB — chưa neo vào đâu

`HTML_SIZE_LARGE` có ngưỡng `512 * 1024` bytes, riêng file này, không liên quan tới ngưỡng cứng
5MB của `template-html-sanitizer.ts`. Số 102KB Gmail cắt cụt — và **ẩn luôn phần sau điểm cắt,
kể cả nút hủy đăng ký nếu nó nằm ở chân thư** — không tồn tại ở đâu trong repo trước ADR này.

### Thứ tự tiêu đề — mô hình đã có, cổng thì chưa

`Node.headingLevel?: 1|2|3|4` (`document.ts`), mặc định 2 khi bỏ trống (`emitText`:
`` `h${n.headingLevel ?? 2}` ``) — nghĩa là **không khối nào tự nhiên ra `<h1>`** trừ khi tác
giả tự đặt. Không có gì kiểm có H1 chưa, có nhảy cấp không (H2 → H4, bỏ qua H3).

### Tương phản WCAG — công thức đã tồn tại, nhưng ở sai chỗ

Công thức luminance/contrast WCAG 2.1 §1.4.3 đã có **ba bản sao** trong repo — nhưng cả ba nằm
trong `apps/web/e2e/mailcraft-contrast-both-themes.spec.ts` và
`mailcraft-dark-mode-completion.spec.ts`, chạy bên trong `page.evaluate()` của Playwright, kiểm
**giao diện chính ứng dụng** (rail, header khi người dùng bật dark mode) — hoàn toàn khác câu
hỏi "màu tác giả chọn cho nội dung email có đọc được không". Không hàm nào trong số đó import
được từ module khác (chạy trong sandbox trình duyệt), và ADR-047's bảng số đo tương phản
(13.91:1, 15.43:1, 10.15:1) tự nhận là "probe" một lần, không phải mã tái dùng.

Đo thêm: màu chữ/nền của một khối phụ thuộc **cây tổ tiên** — `emitColumn`/`emitSection` ghi
`background-color` trên container, `emitText`/`emitContact`/`emitFooter`/`emitList` chỉ ghi
`color` trên khối lá — nên việc phân giải "nền hiệu lực" của một khối cần đi theo chuỗi cha,
đúng lý lẽ ADR-050 đã dùng cho `hasPostalAddress`: cây làm được việc này đáng tin hơn regex trên
HTML đã dựng nhiều.

## Decision

### 1. `LINT_CODES` — mảng runtime, union được suy ra

```ts
export const LINT_CODES = ['HTML_SIZE_LARGE', 'HTML_SIZE_GMAIL_CLIP', 'TEXT_BODY_EMPTY',
  'IMAGE_ALT_MISSING', 'LINK_TARGET_MISSING', 'LINK_PLACEHOLDER', 'LINK_INVALID',
  'HEADING_ORDER_INVALID'] as const;
export type TemplateLintCode = (typeof LINT_CODES)[number];
```

Đúng khuôn `document.ts`'s `KINDS`. `ARCH-LINT-CODES` (`mailcraft-fidelity.test.ts`) đọc mảng
này và khớp với `LINT_ORDER` (`publish-readiness.ts`, nay `export`) — hai bài test: một khớp
tập hợp, một khớp `LINT_MESSAGE` có bản dịch cho từng mã (dự phòng, vì trình biên dịch đã ép
buộc điều đó rồi).

### 2. `HTML_SIZE_GMAIL_CLIP` — loại trừ lẫn nhau với `HTML_SIZE_LARGE`

Ngưỡng `102 * 1024` bytes, tính cùng lượt `Buffer.byteLength` đã có sẵn cho `HTML_SIZE_LARGE`.
**Không phát cả hai cùng lúc**: qua 512KB chỉ báo `HTML_SIZE_LARGE` (đã là sự thật nặng hơn);
giữa 102KB–512KB báo riêng `HTML_SIZE_GMAIL_CLIP`. Hai cảnh báo cùng nói "email quá to" với hai
con số khác nhau là nhiễu, không phải hai sự thật. Câu tiếng Việt nói rõ hệ quả — ẩn cả nút hủy
đăng ký — để tác giả hiểu tại sao con số này quan trọng hơn con số 512KB.

Đo bằng test biên byte chính xác (không phải ký tự): một ký tự đa byte (`п`, U+043F) làm
`.length` và `Buffer.byteLength` lệch nhau — test dựng chuỗi mà phép đếm ký tự nói "chưa tới
ngưỡng" còn phép đếm byte nói "đã qua", để chốt hàm dùng đúng phép đo.

### 3. `HEADING_ORDER_INVALID` — một mã, hai lỗi cùng loại

Đọc chuỗi thẻ `<h1>`-`<h4>` trong HTML đã dựng — route giống mọi mã khác trong file này — không
đọc cây `Doc`. Đây là điều cho phép mã này chạy trên cả template `origin: 'imported'`, chưa từng
có cây. `content-review.ts`'s `locate()` trả `null` cho mã này, giống `HTML_SIZE_LARGE`: một lỗi
thứ tự là thuộc tính của **chuỗi** khối tiêu đề, không phải của một khối riêng lẻ nào.

Một mã cho hai lỗi (thiếu H1, nhảy cấp) chứ không tách hai mã như `LINK_TARGET_MISSING`/
`LINK_PLACEHOLDER`/`LINK_INVALID` — vì cả hai cùng một cách sửa (chỉnh `headingLevel`), khác ba
mã kia (ba cách sửa khác nhau). `count` = số lỗi tìm được, không phải số tiêu đề. "Thiếu H1" chỉ
tính khi có **ít nhất một** tiêu đề khác — một email ngắn chỉ có banner và nút bấm không có gì
để cấu trúc, và báo lỗi ở đó là bắt tác giả thêm một tiêu đề thiết kế của họ không cần.

### 4. `LOW_CONTRAST_TEXT` — cảnh báo, tính từ cây, không phải mã lint server

Khác hai mã trên, đây **không** phải mã trong `template-content-lint.ts` — nó không bao giờ
xuất hiện trong `analysis.lint`. Nó là một hàng cảnh báo tính trực tiếp trong `publishReadiness`
(`apps/web/src/screens/templates/builder/publish-readiness.ts`), đọc `draft.doc` giống hệt
`hasPostalAddress` — chỉ khác `level: 'warning'` thay vì `'blocking'`: tương phản thấp làm email
khó đọc, không làm nó bất hợp pháp hay bất khả dụng như thiếu đường hủy đăng ký.

Module mới `content-contrast.ts`:

```ts
export function contrastRatio(hexA: string, hexB: string): number | null { … } // WCAG 2.1 §1.4.3
export function nodeLowContrast(node: Node, background: string): boolean { … }
export function lowContrastNodeIds(nodes: readonly Node[], defaultBackground: string, inherited?: string): string[] { … }
```

Quyết định trong đó:
- **Chỉ kiểm khi tác giả đã ghi đè `textColor`.** Không màu ghi đè nghĩa là mực mặc định — ADR-047
  đã kiểm nó khớp bảng màu này rồi.
- **Ngưỡng 3:1/4.5:1 theo đúng WCAG**, không dùng một số cho mọi cỡ chữ: `heading` mặc định
  28px/700 (chữ lớn, 3:1), `text`/`list`/`contact` mặc định 14px/400, `footer` mặc định **12px**
  (chữ nhỏ có chủ đích — đúng cỡ dễ lọt qua nếu dùng một ngưỡng thấp cho tất cả).
- **Chỉ năm kind**: `text`, `heading`, `list`, `contact`, `footer` — những khối `emit*` chỉ ghi
  `color` đơn giản trên khối lá. `button` (màu phụ thuộc `buttonVariant`), `table` (màu theo
  từng ô), `social` (màu icon), `logo` (chữ hiệu, không phải văn xuôi) bị loại có chủ ý — mỗi
  loại giải màu theo quy tắc khác, gộp vào đây cần mô hình hoá quy tắc đó, để lại cho quyết định
  sau.
- **Khối ẩn (`visible:false`) không được xét, và cây KHÔNG đi xuống con của nó** — đúng cách
  `emitNode` không bao giờ render một khối ẩn hay con của nó.
- Công thức là bản sao **thứ tư** của cùng phép toán công khai WCAG, không phải tái cấu trúc ba
  bản trong `apps/web/e2e/`: chúng chạy trong sandbox `page.evaluate()` không import được module,
  và đang trả lời câu hỏi khác (giao diện ứng dụng, không phải nội dung email).

Cũng hiện tại điểm chỉnh màu (`textColor` trong inspector) qua `BuilderScreen.tsx` — đúng bài
học ADR-042 mà `inspector-fields.ts`'s đầu file ghi: một kiểm tra chỉ có ở sheet xuất bản là
kiểm tra tác giả gặp quá muộn.

### Cái gì không đổi

- `apps/api/src/templates/dto/template.dto.ts`: không đổi. Cả hai mã lint mới dùng đúng input
  `{ html, textBody }` đã có.
- Không route mới, không migration.
- Ba e2e contrast/dark-mode hiện có (`apps/web/e2e/`): không đụng — chúng kiểm câu hỏi khác.

## Consequences

**Bảng cổng (mutation-tested, không phải checklist):**

| Gì phải giữ | Test |
|---|---|
| `LINT_ORDER` khớp `LINT_CODES` — không mã nào rơi mất | `ARCH-LINT-CODES` (`mailcraft-fidelity.test.ts`) |
| Ngưỡng Gmail đúng byte, không đúng ký tự; loại trừ lẫn nhau với `HTML_SIZE_LARGE` | `template-content-lint.test.ts` — 4 ca, kể cả ca đa byte |
| Thứ tự tiêu đề: không tiêu đề → im lặng; H1 đơn/đủ cấp → im lặng; thiếu H1 → 1; nhảy cấp → 1; lùi cấp không tính là nhảy; cả hai lỗi cùng lúc → 2; nhiều lần nhảy → đếm đủ | `template-content-lint.test.ts` — 8 ca |
| `contrastRatio`: đúng công thức WCAG (đen/trắng = 21:1), đối xứng, mở `#rgb`, tái lập đúng bảng số đo ADR-047 | `content-contrast.test.ts` |
| `LOW_CONTRAST_TEXT`: im lặng khi không ghi đè màu; cảnh báo không chặn xuất bản; nền lấy từ tổ tiên gần nhất; khối ẩn bị loại và không đi xuống con; ngưỡng 3:1 cho chữ lớn khác 4.5:1 cho chữ nhỏ; đếm đúng số khối lỗi | `publish-readiness.test.ts` `describe('ADR-051: LOW_CONTRAST_TEXT')` — 6 ca |
| Hai mã mới không định vị được node, giống `HTML_SIZE_LARGE` | `content-review.test.ts` |
| Hai mã mới chảy qua như cảnh báo, không chặn | `publish-readiness.test.ts` |

**Còn nợ lại, hoãn có địa chỉ (xem Phương án đã cân nhắc):**
- Độ dài preheader (~90-110 ký tự) và subject — **chặn bởi một lỗ hổng mới đo được**: màn hình
  builder (`BuilderScreen.tsx`) không có ô nhập `subject` nào cho template `origin: 'builder'`
  (chỉ có ở `TemplateEditorScreen.tsx`, dành cho `origin: 'imported'`). Xây cảnh báo độ dài cho
  một trường không có chỗ để hiện là vô nghĩa — cần quyết định UI riêng trước.
- Tỉ lệ ảnh/chữ + từ khoá spam — chưa có gì trong repo để dựa vào (không danh sách từ khoá,
  không công thức tỉ lệ, không quyết định trước đó). Rủi ro thiết kế cao (danh sách từ khoá dễ
  báo sai với văn phong tiếng Việt) — cần ADR riêng.
- Xem trước dark mode/Outlook — không phải một cổng lint, là một tính năng giao diện (thêm chế
  độ xem cho modal "Xem trước"). Khác loại với năm mục kia, xứng đáng một quyết định riêng.

## Phương án đã cân nhắc và loại

- **Làm cả sáu cổng trong một ADR.** Loại: ba cổng còn lại mỗi cái có một rào cản khác nhau
  (thiếu UI, thiếu dữ liệu khởi điểm, khác loại tính năng) — gộp chung sẽ làm ADR này phải tự
  bịa quyết định sản phẩm (danh sách từ khoá spam, có nên thêm ô subject) thay vì chỉ mở rộng
  cơ chế đã có.
- **Tách `HEADING_ORDER_INVALID` thành hai mã** (thiếu H1 / nhảy cấp), theo khuôn ba mã link.
  Loại: cả hai cùng một cách sửa; tách ra chỉ nhân đôi số điểm chạm (7 chỗ mỗi mã mới phải sửa,
  theo bảng đo được) mà không thêm hành động rõ ràng nào cho tác giả.
- **Kiểm tương phản bằng regex trên HTML đã dựng**, giống sáu mã cũ. Loại: cần chuỗi tổ tiên để
  biết nền hiệu lực, và regex trên `style="..."` tuỳ ý không tin cậy bằng đi theo cây — đúng lý
  lẽ ADR-050 đã dùng.
- **Một ngưỡng tương phản duy nhất (4.5:1) cho mọi cỡ chữ.** Loại: WCAG tự phân hai ngưỡng theo
  cỡ chữ; dùng một ngưỡng sẽ báo sai (chữ lớn thật ra đủ chuẩn) hoặc bỏ sót (chân thư chữ nhỏ chỉ
  cần đạt 4.5 mà lẽ ra phải đạt, tình huống ngược lại không xảy ra vì 4.5 > 3 nên dùng chung 4.5
  vẫn AN TOÀN nhưng quá khắt khe với tiêu đề — chọn đúng ngưỡng WCAG thay vì đơn giản hoá).
- **`LOW_CONTRAST_TEXT` chặn xuất bản thay vì chỉ cảnh báo.** Loại: tương phản thấp không giống
  thiếu đường hủy đăng ký hay thiếu địa chỉ bưu chính — không có yêu cầu pháp lý nào đằng sau,
  và chặn xuất bản vì một lựa chọn thẩm mỹ sẽ khiến tác giả tắt tiếng cổng thay vì sửa màu.
- **Hợp nhất ba bản công thức contrast trong `apps/web/e2e/` với `content-contrast.ts`.** Loại:
  chúng chạy trong `page.evaluate()`, một sandbox không import module ngoài; hợp nhất đòi phải
  phơi hàm ra `window` chỉ để phục vụ test, đổi kiến trúc sản phẩm để phục vụ test là bản chất
  ngược.
