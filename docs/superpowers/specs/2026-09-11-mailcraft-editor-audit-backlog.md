# Mailcraft editor: sổ nợ sau ba lượt rà soát (2026-09-10)

Tài liệu này tồn tại vì một lý do rất cụ thể: ba lượt đánh giá trình soạn thảo Mailcraft ngày
2026-09-10 sinh ra khoảng ba chục phát hiện, **hai** trong số đó đã được dựng và ghi thành
ADR, còn lại **chỉ nằm trong một cuộc hội thoại**. Hội thoại đó đã bị nén ngữ cảnh một lần và
sẽ đóng. Không có tệp này thì phần lớn công sức rà soát biến mất.

Mỗi mục dưới đây mang **số đo thật** và **địa chỉ tệp**, không phải cảm nhận. Chỗ nào là suy
luận chưa đo thì có ghi rõ.

## 0. Đã làm rồi — đừng làm lại

| Việc | Commit | Ghi ở đâu |
|---|---|---|
| Tầng tương thích Outlook: ghost table, 4 thuộc tính `mso-*`, 3 thẻ `<head>`, `lang` | `0c2f0d3`, `834bd4d` | ADR-045 |
| 4 control ADR-042: `letter-spacing`, `text-transform`, `box-shadow`, gradient nền | `2c23073` | ADR-042 + chú thích đầu `inspector-fields.ts` |
| Rich text inline cho khối text/heading (dải đánh dấu, 4 thẻ, toolbar trong inspector) | ADR-046 | ADR-046 + `inline.ts` |
| Bảng màu tối + đóng đầu dây `color-scheme` | ADR-047 | ADR-047 + `expandDarkMode` |
| Khối danh sách (`list`) + mở `list-style-type` | ADR-048 | ADR-048 + `emitList` |
| Đường hủy đăng ký: link ký + route công khai + trang + publish chặn | ADR-049 | ADR-049 + migration 079 |
| Padding cho khối chữ; `buttonWidth` / `linkTitle` / `caption` ảnh; nhân đôi + copy/paste + phím tắt | `f9f7bfb` | chú thích trong `emitter.ts`, `BuilderScreen.tsx` |

**Bài học đắt nhất của cả ba lượt**, đã ghi ở đầu `apps/web/src/screens/templates/builder/inspector-fields.ts`:
ADR-042 mở allowlist ngày 2026-09-02, control mãi không được dựng suốt tám ngày, và **bốn**
chỗ tiếp tục khẳng định ngược lại — trong đó có một **test xanh** tên *"never generates a
field for a property the sanitizer strips"*. Ba chỗ kia chỉ mô tả khoảng trống; cái test thì
**giữ** nó. Dựng control đồng nghĩa phải xoá chính cái test đó.

Hệ quả cho người đọc tệp này: **một lý do hết hạn nằm trong test đang xanh thì nó thành
luật**, và không có gì trong bộ test phân biệt được luật đang bảo vệ thứ gì với luật mà lý do
đã chết. Khi làm bất kỳ mục nào dưới đây, đọc lại lý do của các cổng liên quan trước.

---

## 1. Ba trường model trơ — ĐÃ XỬ LÝ (2026-09-11)

Cả ba đã có địa chỉ, đúng như mục này yêu cầu ("xoá khỏi model, hoặc cho mỗi cái một địa chỉ").

| Trường | Xử lý | Chi tiết |
|---|---|---|
| `name` | **Dựng** | `TreeRow.name` mang tên tác giả đặt; cây cấu trúc hiện `row.name ?? NODE_LABEL[kind]` — đúng nửa còn thiếu của `nodeName(n, l)` trong prototype. Bấm đúp để đổi tên, Enter/blur lưu, Escape huỷ, để trống thì về nhãn theo kind |
| `gap` | **Xoá** | Đo được: prototype chỉ dùng `node.gap` ở `Canvas` (dòng 818) và ở slider inspector (886), **không** dùng trong `exportNode`. Tức đó là control chỉ đổi canvas chứ không đổi email — đúng lỗi ADR-042 §Context gọi tên. Ở EOW thì đệm cột đã làm đúng việc đó rồi, nên giữ lại chỉ là cách thứ hai làm cùng một chuyện mà không thêm năng lực nào (tiền lệ `opacity`, ADR-040) |
| `stackMobile` | **Dựng** | Xếp dọc theo **từng hàng**, ghi đè `EmailTheme.stackColumns` của cả tài liệu. Rẻ vì `emitColumn` vốn đã có sẵn nhánh: `width:100%` co lại và xuống dòng, `width:{px}` thì không. Prototype làm bằng class `mc-stack` + `@media`, EOW không thể (ADR-037 §2), nên kỹ thuật khác nhưng kết quả giống |

**Cũng đóng luôn dòng thứ hai của §3** (`stackColumns` chỉ đặt được cho cả tài liệu).

Và một lần nữa, đúng cái bẫy quen thuộc: dựng `stackMobile` đòi phải **xoá** một test đang
xanh tên *"returns no fields for a Row (structural only — nothing on it survives to HTML)"*.
Lý do của nó hết hạn ngay lúc `stackMobile` bắt đầu quyết định đầu ra HTML. Đây là lần **thứ
ba** trong cùng một tệp test.


## 2. Soạn thảo văn bản — ĐÃ DỰNG (ADR-046, 2026-09-11)

~~Ô nhập là `<textarea>` trần; `emitText` chạy `escapeHtml(content).replace(/\n/g,'<br>')`.~~

**Đã xong.** ADR-046 được chốt và dựng cùng ngày. `Node.inline` mang các **dải đánh dấu** trên
`content` (vẫn là chuỗi thuần), `inline.ts` chuẩn hoá chúng thành đoạn không chồng, và cả
`emitter.ts` lẫn canvas đọc **cùng một hàm**. In đậm một chữ giữa câu và chèn link trong đoạn
đều làm được, qua `InlineFormatToolbar` phía trên ô nội dung trong inspector.

Ba điều đã đo, đáng giữ lại:

- `escapeHtml` **không bị bỏ** — nó chuyển từ escape cả câu sang escape từng đoạn. Thẻ xuất ra
  là hằng trong mã nguồn, chọn bằng `switch` trên union bốn giá trị.
- Sanitizer server **không phải lớp cuối**: `expandMsoGhosts` chạy *sau* `sanitize()`, nên
  `<mso-ghost data-mso="row-open">` gõ vào ô nội dung sẽ nở thành comment điều kiện thật nếu
  nội dung đi qua dưới dạng markup. Đây là lý do ranh giới an toàn nằm ở emitter, không ở server.
- **Bullet KHÔNG thuộc nhóm này, và nay ĐÃ CÓ (ADR-048).** Đo được: `<ul>` trong `<p>` cắt đôi
  đoạn văn và bỏ lại `<p></p>` rỗng, còn trong `<h2>` thì lồng bình thường — cùng một thao tác,
  hai kết quả. Nên danh sách thành một *kind* riêng với emitter riêng, cộng `list-style-type`
  được mở trong allowlist (thuộc tính thứ 32).

Hai mục nhỏ đi kèm **vẫn chưa làm**, và ADR-046 không thay thế chúng (nghiêng cả khối và
nghiêng một chữ là hai control khác nhau):
- `fontStyle` / `textDecoration` chưa có trong `Node` dù sanitizer nhận cả hai.
- Độ đậm chỉ có 400/700 (`inspector-fields.ts`, `options: [{ value: '400' … '700' }]`). Thiếu
  300/500/600.

## 3. Linh hoạt bố cục — ĐÃ ĐÓNG (ADR-052, 2026-09-14)

| Chỗ | Đo được | Hệ quả |
|---|---|---|
| ~~**Tỉ lệ cột**~~ | **ĐÃ SỬA.** `node.width` chỉ được ghi tại preset (6 tỉ lệ dựng sẵn) | → Trường `width` tự do trong inspector (tab Thiết kế). Preset vẫn là đường nhanh; gõ số retype từng cột dựng được 30/70, 20/60/20 |
| ~~**`stackColumns`**~~ | **ĐÃ SỬA 2026-09-11** | `Node.stackMobile` ghi đè theo từng hàng (§1). `EmailTheme.stackColumns` vẫn là mặc định của cả tài liệu |
| ~~**Mạng xã hội**~~ | **ĐÃ SỬA.** `SOCIAL_PLATFORMS` cứng 5 giá trị | → Mở lên 9 (thêm Zalo, TikTok, Threads, `other`). Editor dựng lại với chọn nền tảng + xoá dòng, khối mới chỉ seed 3 mặc định |
| ~~**Icon mạng xã hội**~~ | **ĐÃ SỬA.** `emitSocial` xuất chữ thô "facebook" | → Glyph chữ đã tạo kiểu (`f`, `in`, `ig`...), huy hiệu tròn/vuông/chỉ-chữ — phục hồi đúng thiết kế gốc của prototype (`socialStyle`/`socialSize`), chưa từng được dựng. Canvas và email dùng chung một hàm glyph |

Đo trước khi quyết: markup huy hiệu sống sót nguyên vẹn qua `sanitizeTemplateHtml`, không mở
thêm allowlist nào. Icon ảnh/SVG thật theo brand bị hoãn có địa chỉ — không có hạ tầng icon
nào trong repo, và `<svg>` chưa nằm trong allowlist thẻ. Xem ADR-052.

## 4. Năng lực chưa từng có trong model

Chưa chạm gì. Xếp theo mức độ chặn đường thật:

**Bắt buộc theo pháp lý — nửa opt-out ĐÃ XONG (ADR-049, 2026-09-11):**

~~`MISSING_UNSUBSCRIBE_URL` chỉ ở mức warning~~ → **chặn xuất bản**. Nhưng mục này hóa ra sâu
hơn sổ nợ ghi rất nhiều. Đo được ba chuyện, không phải một:

| Repo khẳng định | Sự thật đo được |
|---|---|
| cảnh báo nói *"sẽ bị chặn khi gửi"* | **không có cổng nào ở lúc gửi** |
| chú thích nói *"failure happens at SEND, not at publish"* | bước đó **không tồn tại** ⇒ không ai kiểm |
| `{{unsubscribe_url}}` dựng link thật | **link không có đích**: không route web, không controller API |

⇒ Đã dựng nguyên đường: link **được ký** (HMAC, khoá dẫn xuất từ `SESSION_SECRET`), route công
khai `GET` mô tả / `POST` thực hiện, trang xác nhận ngoài `RequireAuth`, migration 079 với hai
hàm `SECURITY DEFINER` hẹp (hàm ghi **chỉ biết hủy**, không bao giờ kích hoạt lại), audit row,
và publish chặn thật. Xem ADR-049.

**Còn nợ, đã ghi trong ADR-049 §Consequences:**
- **Không có header `List-Unsubscribe`** (RFC 8058) — nút hủy gốc của Gmail/Apple Mail cần nó,
  do `smtp-provider.adapter.ts` đặt.
- **Xoay `SESSION_SECRET` sẽ làm mọi link đã gửi ngừng redeem** — chưa có quy trình xoay khoá
  nào ghi điều này.

**Nửa còn lại của §4 — ĐÃ XỬ LÝ (ADR-050, 2026-09-11):**

~~**Không có khối chân thư chuyên dụng**, và **không kiểm địa chỉ bưu chính**~~ → khối `footer`
mới (`companyName` + `address`, nhiều dòng), `hasPostalAddress` đọc thẳng cây tài liệu (không
đoán trên markup đã dựng, khác cách không thể áp dụng cho một token thật như
`{{unsubscribe_url}}`), và publish chặn thật khi không có địa chỉ — kể cả khi khối `footer` bị
ẩn. Đo trước khi quyết: markup dự kiến sống sót nguyên vẹn qua `sanitizeTemplateHtml`, không mở
thêm allowlist nào (khác ADR-048). Xem ADR-050.

**Marketing:**
- Nội dung động: khối lặp cho danh sách sản phẩm, hiển thị có điều kiện, nội dung theo phân khúc
- Biến thể A/B cho tiêu đề và nội dung
- Brand kit: màu, phông, kiểu nút mặc định dùng lại; thang khoảng cách; màu link toàn cục
- Bộ gắn UTM; liên kết "xem trên trình duyệt"; kiểm link hỏng
- Tối ưu ảnh: nén, retina 2x, kiểm dung lượng từng ảnh
- Đa ngôn ngữ: bản dịch song song cho cùng một template
- Cộng tác: comment, khoá vùng cho người không phải designer, so sánh phiên bản trực quan

## 5. Cổng chất lượng nội dung — 3/6 đã dựng (ADR-051, 2026-09-14)

Lint hiện có đúng 8 mã (`apps/api/src/templates/template-content-lint.ts`, `LINT_CODES`):
`IMAGE_ALT_MISSING`, `LINK_TARGET_MISSING`, `LINK_PLACEHOLDER`, `LINK_INVALID`,
`TEXT_BODY_EMPTY`, `HTML_SIZE_LARGE`, cộng **hai mã mới** `HTML_SIZE_GMAIL_CLIP`,
`HEADING_ORDER_INVALID`; cộng một cảnh báo thứ ba tính từ cây tài liệu (không phải mã lint
server) là `LOW_CONTRAST_TEXT`. Sáu cổng ban đầu nêu ra:

| Cổng | Vì sao cần | Trạng thái |
|---|---|---|
| ~~**Tương phản màu WCAG**~~ | Inspector cho chọn màu chữ và màu nền tự do, không có gì cảnh báo chữ xám trên nền trắng | **ĐÃ XONG** — `content-contrast.ts`, cảnh báo cả lúc chỉnh màu lẫn lúc xuất bản |
| ~~**Ngưỡng 102KB của Gmail**~~ | Gmail cắt cụt email và **giấu luôn nút hủy đăng ký**. `HTML_SIZE_LARGE` có tồn tại nhưng không neo vào con số này | **ĐÃ XONG** — `HTML_SIZE_GMAIL_CLIP`, loại trừ lẫn nhau với `HTML_SIZE_LARGE` |
| ~~**Thứ tự heading**~~ | Không kiểm có H1 chưa, có nhảy cấp không | **ĐÃ XONG** — `HEADING_ORDER_INVALID` |
| **Tỉ lệ ảnh/chữ + từ khoá spam** | Ảnh hưởng trực tiếp tới việc vào hộp thư chính | Hoãn — đo được (ADR-051 Context) repo không có danh sách từ khoá hay công thức tỉ lệ nào để dựa vào; rủi ro thiết kế cao, cần ADR riêng |
| **Độ dài preheader (~90 ký tự) và subject** | | Hoãn — đo được: `BuilderScreen.tsx` (màn hình `origin: 'builder'`) **không có ô nhập `subject` nào cả**, chỉ `TemplateEditorScreen.tsx` (`origin: 'imported'`) có. Cảnh báo độ dài cho một trường chưa có chỗ hiện là vô nghĩa — cần quyết định UI trước |
| **Xem trước dark mode và Outlook** | Hiện chỉ có switch thiết bị | Hoãn — không phải một cổng lint, là một tính năng giao diện (thêm chế độ xem vào modal "Xem trước"), khác loại với năm mục kia |

Xem ADR-051 để có bảng đo, quyết định và bảng cổng mutation-tested đầy đủ.

~~**Một chỗ lệch đã đo, sửa rẻ:**~~ **ĐÃ SỬA 2026-09-11.** `imageAltMissing` nay dùng
`IMAGE_BEARING_KINDS` (danh sách trong `document.ts`, không phải bản sao) thay vì
`node.kind === 'image'`, nên `banner` và `logo` thiếu `alt` cảnh báo ngay tại ô nhập đúng như
lint server vẫn bắt chúng. Cùng một lỗi, giờ nói cùng một câu ở cả hai đường vào.

## 6. Đầu dây do chính ADR-045 để lại — ĐÃ ĐÓNG (ADR-047, 2026-09-11)

Hai nửa, cả hai đã xong.

**Nửa một (commit `7336a28`):** `<body>` khai `background-color` mà không khai `color`, trong
khi `emitText`/`emitContact` xuất `color:inherit` cho khối không đặt màu — nên chữ đó lấy màu
từ bảng kiểu của client. Nay `<body>` có `color:#30463d`, chuỗi `inherit` kết thúc trong email.

**Nửa hai (ADR-047):** có bảng màu tối thật. Ba màu, đo tương phản thật:

| Cặp | Tỉ lệ |
|---|---|
| `#e6ede9` trên `#16211d` (nền nội dung tối) | **13.91:1** |
| `#e6ede9` trên `#0f1613` (nền ngoài tối) | **15.43:1** |
| `#30463d` trên `#ffffff` (bảng sáng hôm nay) | 10.15:1 |

Cơ chế: emitter phát `<mc-dark></mc-dark>`, sanitizer nở thành một khối `<style>` có nội dung
là **hằng trong mã nguồn**, sau mọi phép đo — đúng khuôn `expandMsoGhosts` của ADR-045.

**Số đo quan trọng nhất, chưa từng ghi ở đâu:** `allowedStyles` của `sanitize-html` **chỉ soi
thuộc tính `style="..."`**, không soi CSS trong thẻ `<style>`; và CSS trong `@media` không bao
giờ được `juice` nội tuyến nên không bao giờ gặp bộ lọc. Tức "cho `<style>` sống sót" sẽ mở
một lỗ xuyên qua cả 27 thuộc tính allowlist — và `emitCustomHtml` đang xuất `<style>` từ CSS
tác giả gõ, nên lỗ đó có sẵn người dùng. Đó là lý do chọn đường thẻ đánh dấu.

**ADR-037 §2 không bị đảo.** Chuỗi `@media` duy nhất tồn tại là `prefers-color-scheme`, đổi
đúng hai thuộc tính màu, không breakpoint, không `max-width`. `@media` cho bố cục vẫn đóng.

Còn nợ lại, đã ghi trong ADR-047 §Consequences:
- Email được tác giả tô màu kỹ sẽ **không có chế độ tối** (quyết định 4 cố ý không ghi đè lựa
  chọn của tác giả), và **UI chưa nói điều đó ở đâu cả**.
- Outlook desktop không có chế độ tối theo đường này (Word không đọc `@media`); Outlook.com
  cần `[data-ogsc]`, mà đo được là `juice` không nội tuyến được nên nó mất im lặng.


## 7. Hiệu năng — hai mục đã đo

~~**`exceljs` nằm trong chunk chính.**~~ **ĐÃ SỬA 2026-09-11, đo lại sau khi sửa:**

| | Trước | Sau |
|---|---|---|
| `index-*.js` (tải ngay) | **1661 KB** | **754 KB** |
| `exceljs.min-*.js` (tải khi cần) | — | 908 KB |
| dấu vết `worksheet` trong chunk chính | 2 | **0** |
| dấu vết `xl/workbook` trong chunk chính | 4 | **0** |

**Cắt 907 KB khỏi lần tải đầu.** Nguyên nhân đúng như đã đoán: `import-samples.ts:1` import
tĩnh `exceljs` và `ImportRecipientsOverlay.tsx:7` kéo nó vào. Sửa bằng `import type` (bị xoá
lúc build) cộng `await import('exceljs')` bên trong `buildRecipientSampleWorkbook`, nên chỉ
thư viện bị hoãn — bản thân module vẫn import tĩnh vì nó chỉ là vài hằng số. Hàm thành
`async`, test đổi theo.

**Dockerfile thiếu cache mount cho pnpm store.** Phân tầng vốn tốt (package.json trước, source
sau), nhưng `RUN pnpm install --frozen-lockfile` (Dockerfile:13) không có
`--mount=type=cache`, nên mỗi lần lockfile đổi là nướng lại toàn bộ store thành một layer mới.
Đo ngày 2026-09-10: build cache **15.87GB**, 527 mục, `ACTIVE: 0` — và mục **cũ nhất chỉ 3
ngày tuổi** (247 mục 2 ngày, 178 mục 3 ngày). Tức 15.87GB sinh ra trong 3 ngày làm việc; đó
là **tốc độ sinh**, không phải rác tích tụ. Dọn theo tuổi không giải quyết được, phải chặn ở
gốc hoặc đặt trần bằng `--keep-storage`.

## 8. Bảng chấm từng khối

Chuẩn: một email marketing thật cần gì — không phải "prototype có gì". Chấm ngày 2026-09-10,
**trước** commit `f9f7bfb` (nên nút bấm và hình ảnh nay đã khá hơn một chút).

| Khối | Điểm | Thiếu gì |
|---|---|---|
| Đoạn văn | **7/10** | ~~§2~~ **đã có** rich text inline + link trong câu (ADR-046). Danh sách nay là khối riêng (ADR-048). Còn thiếu `fontStyle`/`textDecoration` cấp khối, độ đậm 300/500/600 |
| Tiêu đề | **7/10** | Như trên. H1–H4 đã có sẵn từ trước (`headingLevel`) |
| Nút bấm | 6/10 | Đã có full-width ở `f9f7bfb`. Còn thiếu icon, viền tuỳ chỉnh, đệm ngang riêng |
| Hình ảnh | 5/10 | Chỉ chỉnh rộng theo `%`, không theo `px`; không viền; không bo 4 góc riêng |
| Banner | 4/10 | Không căn lề, không chiều cao, không overlay chữ |
| Logo | 6/10 | Ổn |
| Bảng | **8/10** | Khối tốt nhất. Thiếu gộp ô, độ rộng cột (`v3-widths` — xem sổ đăng ký DOM) |
| Mạng xã hội | 4/10 | §3 — 5 nền tảng cứng, icon là chữ |
| Liên hệ | 6/10 | 5 ô cố định, không thêm bớt dòng |
| Section / Cột | 7/10 | Đã có gradient + bóng ở `2c23073`. Thiếu căn dọc, chiều cao tối thiểu, ảnh nền (ảnh nền **không làm được** — xem §9) |
| Đường ngăn | 6/10 | Không có nét đứt/chấm, không chỉnh độ rộng |
| Khoảng cách | 7/10 | Đủ |
| Preheader | 7/10 | Đủ. Đã ẩn được ở Outlook từ ADR-045 |
| HTML tùy chỉnh | 8/10 | Có cả tab CSS |

Hai khối được dùng nhiều nhất trong mọi email là hai khối yếu nhất.

## 9. Giới hạn thật của email — đừng đưa vào sổ nợ

Sòng phẳng: không phải cái gì thiếu cũng là lỗi. Những thứ sau **không làm được** và đã có
quyết định ghi sổ:

- `@media` bị strip (ADR-037 §2) ⇒ không có cỡ chữ riêng cho mobile, không ẩn-trên-mobile
- `url()` trong CSS bị chặn ⇒ **không có ảnh nền**; gradient thì được (ADR-042)
- `hover` không tồn tại trong email
- `box-shadow:inset` ngoài phạm vi ADR-042 ⇒ `elevation` có 3 giá trị, không phải 4 như prototype
- VML vẫn bị xoá (ADR-045 §"Cái gì không đổi") ⇒ chưa có nút bo góc "bulletproof" cho Outlook

## 10. Thứ tự đề nghị

| # | Việc | Công | Vì sao xếp ở đây |
|---|---|---|---|
| ~~1~~ ✅ | §1 ba trường trơ | rất thấp | Rẻ nhất, và mỗi cái là một lời nói dối nhỏ trong model |
| ~~2~~ ✅ | §5 chỗ lệch `alt` giữa canvas và lint | rất thấp | Một điều kiện `kind` |
| ~~3~~ ✅ | §7 `exceljs` | rất thấp | Một import, cắt ~1MB, đo được ngay |
| ~~4~~ ✅ | §6 đầu dây dark mode (ADR-047) | thấp | Đóng vòng lặp chính mình mở ra |
| ~~5~~ ✅ | §2 rich text (ADR-046) | **cao** | Thứ người dùng hỏi từ đầu. Chờ ADR-046 |
| ~~6a~~ ✅ | §4 pháp lý — đường hủy đăng ký (ADR-049) | trung bình | Rủi ro pháp lý, không phải tiện nghi |
| ~~6b~~ ✅ | §4 pháp lý — địa chỉ bưu chính + khối chân thư (ADR-050) | trung bình | Nửa còn lại, độc lập với 6a |
| ~~7~~ ✅ 3/6 | §5 cổng chất lượng (ADR-051) | trung bình | Nên có trước khi mở rộng năng lực ở §4. 3 cổng còn lại hoãn có địa chỉ — xem §5 |
| ~~8~~ ✅ | §3 linh hoạt bố cục (ADR-052) | trung bình | Dòng `stackColumns` đã xong ở §1; tỉ lệ cột, nền tảng social, icon social nay đã xong |
| 9 | §7 Dockerfile cache mount | trung bình | Sửa gốc chuyện 15GB |
| 10 | §4 phần marketing còn lại | cao | Cần quyết định sản phẩm, không chỉ kỹ thuật |

## 11. Cách các số đo trên được lấy

Để người sau kiểm lại được, chứ không phải tin lời:

- **Trường chết**: viết script đối chiếu tên trường trong `Node` với `n.<field>` trong
  `emitter.ts` và với `key:` trong `inspector-fields.ts` + các lệnh ghi trong `BuilderScreen.tsx`.
  Cẩn thận với dương tính giả: `align` khai qua tham số mặc định `align(key = 'align')`,
  `buttonVariant`/`decorative` có control riêng không khớp regex, và `c.name` trong emitter là
  của khối `contact` chứ không phải `node.name`. Phải kiểm từng cái, không tin regex.
- **Padding chết**: emit mỗi khối hai lần, một lần zero hết padding, rồi so chuỗi HTML. So theo
  giá trị `14px` là **sai** — cột dùng 18, đường ngăn dùng 12, và cách đó báo nhầm cả hai.
- **Sanitizer**: chạy thẳng `sanitizeTemplateHtml` trong một test tạm, ghi kết quả ra tệp
  (console.log bị vitest nuốt). Đừng đo qua `dist/`.
- **Bundle**: `ls -S dist/assets/*.js`, rồi `grep -c` dấu vết thư viện trong chunk chính.
- **Build cache**: `docker buildx du --verbose`, lọc `Last used`, nhóm theo ngày. `ACTIVE: 0`
  **không** có nghĩa là cache cũ — nó chỉ có nghĩa không mục nào đang được build nào dùng.
