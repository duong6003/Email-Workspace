# ADR-045: Tầng tương thích Outlook và ba thẻ `<head>` — ghost table đi qua thẻ trung gian, không đi qua comment

Status: Accepted

Mở rộng allowlist do ADR-037 §1 lập, đã nới bởi ADR-038 (shorthand nhiều giá trị), ADR-040
(`display`/`max-height`/`overflow`) và ADR-042 (`box-shadow`/`letter-spacing`/
`text-transform`/gradient). Không thay thế ADR nào. Gỡ giới hạn mà ADR-040 §Consequences đã
ghi nhận cho preheader, và ghi sổ một hệ quả lớn hơn nhiều mà **chưa tài liệu nào ghi**.

## Context

### ADR-037 §2 chọn fluid/hybrid, nhưng chỉ một nửa được dựng

ADR-037 §2 chốt: bố cục responsive đi theo Option B — fluid/hybrid, không `@media`. Kỹ thuật
đó có **hai nửa**:

1. Bảng phần trăm + `max-width` + `display:inline-block` cho client hiện đại.
2. **Ghost table trong comment điều kiện MSO** cho Outlook desktop trên Windows.

`emitter.ts:226` dựng cột bằng `display:inline-block`. Bộ máy render của Outlook desktop là
Word, và nó **không hỗ trợ `inline-block` để dàn cột**. Nửa thứ hai chưa bao giờ được dựng,
nên **cả sáu preset bố cục** (`ROW_LAYOUT_PRESETS`: hai cột đều, 35/65, ba cột…) đều sập
thành một cột chồng dọc trong Outlook desktop.

ADR-040 §Consequences có ghi *"The preheader works in most clients, but not Outlook
desktop"*. Đó là giới hạn duy nhất về Outlook được ghi trong repo. Hệ quả với bố cục nhiều
cột — lớn hơn nhiều lần — **không nằm trong ADR, spec, hay comment nào**.

### Đo trước khi quyết — sanitizer hôm nay làm gì (probe 2026-09-10)

Chạy trực tiếp qua `sanitizeTemplateHtml`, không qua `dist/`:

| Đưa vào | Nhận lại |
|---|---|
| `<!--[if mso]><table role="presentation" width="600"><tr><td width="300"><![endif]-->` | **mất sạch** |
| `mso-line-height-rule:exactly;line-height:20px` | `line-height:20px` — mất vế MSO |
| `<!-- comment thường -->` | mất |
| `<meta charset="utf-8">` | mất |
| `<meta name="color-scheme" content="light dark">` | mất |
| `<html lang="vi">` | `<html>` — mất `lang` |
| `<title>T</title>` | `<head>T</head>` — **mất thẻ, chữ rơi vãi lại trong `<head>`** |
| `<v:roundrect>` (VML) | mất sạch |

Hệ quả kèm theo: `emitDoc` xuất `<meta name="viewport">`, nhưng `meta` không có trong
`emailTags`, nên thẻ đó **chưa bao giờ sống sót** — một dòng code không có tác dụng kể từ
khi được viết.

### Đo tiếp — cơ chế nào mở được, và mở ra thì lọt thêm cái gì

| Thử | Kết quả |
|---|---|
| Giữ comment: mặc định | vẫn xoá |
| Giữ comment: thêm `'!--'` vào `allowedTags` | **vẫn xoá** |
| Giữ comment: `parser.recognizeCDATA` | **vẫn xoá** |
| Thẻ tự đặt `<mso-ghost>` có trong allowlist | **sống sót nguyên vẹn** |
| Thẻ `<mso-ghost>` *không* có trong allowlist | bị bỏ — chứng minh mặc định vẫn là từ chối |
| `mso-line-height-rule` khai trong `allowedStyles` | **sống sót** |
| `meta` + `title` + `html[lang]` khai trong allowlist | **sống sót** |
| `<meta http-equiv="refresh" content="0;url=…">`, `http-equiv` **không** trong danh sách thuộc tính | `http-equiv` bị bỏ, chỉ còn xác `<meta content="…">` vô hại |
| `<meta http-equiv="refresh" …>`, `http-equiv` **có** trong danh sách | **chuyển hướng sống sót** ← đây là thứ tuyệt đối không được làm |

Kết luận bắt buộc từ ba dòng đầu: **`sanitize-html` không có cách nào giữ comment.** Phương
án "cho comment điều kiện đi thẳng qua allowlist" là bất khả thi với thư viện đang dùng —
không phải lựa chọn, mà là ràng buộc đo được. Thiết kế dưới đây là hệ quả của nó.

### Tiền lệ chi phối

Kế hoạch vertical-slice, mục *"Hai thứ chặn thật, không phải sở thích"*, viết rõ:

> Cách xử **không phải** bỏ control khỏi inspector — mà là **mở allowlist**… để không có
> control nào cho ra kết quả rỗng.

ADR-042 đã áp đúng nguyên tắc đó cho bốn thuộc tính CSS. Đây là lần thứ hai, với một tầng
lớn hơn: lần này thứ "cho ra kết quả rỗng" không phải một control, mà là **toàn bộ bố cục
nhiều cột ở một trong ba client phổ biến nhất**.

## Decision

### 1. Ghost table đi qua thẻ trung gian `<mso-ghost>`, với từ vựng đóng

Emitter phát `<mso-ghost>` thay vì comment. `sanitize-html` duyệt nó như mọi thẻ khác —
đúng mô hình allowlist, không có ngoại lệ nào cho nó. **Sau khi** `sanitize-html` chạy xong,
một bước cuối trong `sanitizeTemplateHtml` đổi mỗi thẻ còn sống thành comment điều kiện
tương ứng.

Từ vựng **đóng**, đúng bốn giá trị, tra bảng chứ không nội suy chuỗi:

| `data-mso` | Nở thành |
|---|---|
| `row-open` | `<!--[if mso]><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><![endif]-->` |
| `col-open` | `<!--[if mso]><td width="{W}" valign="top"><![endif]-->` |
| `col-close` | `<!--[if mso]></td><![endif]-->` |
| `row-close` | `<!--[if mso]></tr></table><![endif]-->` |

`{W}` là thuộc tính `data-w`, **chỉ nhận số nguyên 1–1000**, được ép qua `Number.isInteger`
rồi in lại bằng `String(n)` — không phải nội suy giá trị thô. Giá trị `data-mso` nào không
nằm trong bốn khoá trên thì thẻ bị **bỏ**, không phải bỏ qua bước nở.

Đây là ranh giới an toàn thật của quyết định này: tác giả **không có đường nào** viết được
một ký tự tuỳ ý vào bên trong comment. Nội dung comment là hằng số trong mã nguồn, tham số
duy nhất là một số nguyên đã kiểm.

### 2. Bốn thuộc tính `mso-*`, mỗi cái một văn phạm riêng

Thêm vào `allowedStyles['*']`, không dùng chung `safeStyleValues`:

| Thuộc tính | Văn phạm | Để làm gì |
|---|---|---|
| `mso-line-height-rule` | `^(?:exactly\|at-least)$` | Outlook bỏ qua `line-height` nếu thiếu nó |
| `mso-hide` | `^all$` | **Gỡ đúng giới hạn ADR-040 đã ghi** — preheader ẩn được cả ở Outlook |
| `mso-table-lspace` / `mso-table-rspace` | `^0(?:pt\|px)?$` | Xoá khoảng đệm Word tự thêm quanh bảng |

Cả bốn đều trơ ở mọi client không phải Outlook, không tham chiếu URL, không thực thi gì.
Danh sách là **đóng** — `mso-*` không được mở theo tiền tố.

### 3. `<meta>` được phép, nhưng `http-equiv` thì không

Thêm `meta` vào `emailTags`, và `meta: ['charset', 'name', 'content']` vào `emailAttributes`.

**`http-equiv` bị loại có chủ ý và phải nằm trong test hồi quy.** Bảng đo ở trên cho thấy
đúng một dòng khác biệt giữa "thêm ba thẻ head" và "mở một kênh chuyển hướng": nếu ai đó
thêm `http-equiv` vào danh sách vì thấy `<meta http-equiv="Content-Type">` quen mắt, thì
`refresh` đi kèm ngay lập tức. Test phải khoá điều này lại, không phải comment.

**Siết thêm khi dựng (2026-09-10), do đo mà ra.** Bỏ `http-equiv` khỏi danh sách thuộc
tính vẫn để lại cái xác `<meta content="0;url=https://attacker.test">` — trơ về hành vi,
nhưng một URL của kẻ tấn công nằm trong HTML đã lưu là thứ không nên bắt người review phải
tự phán đoán. Nên `transformTags.meta` **bỏ hẳn thẻ `<meta>` nào không mang `charset` hoặc
`name`**. Đây là siết chặt theo đúng tinh thần default-deny của allowlist, không phải nới.

Mutation test phát hiện hai lớp này **che nhau**: thêm lại `http-equiv` vào danh sách mà
mọi test vẫn xanh, vì `transformTags` đã bỏ thẻ trước. Nên phải có test riêng cho từng lớp
— một thẻ `<meta name="viewport" http-equiv="refresh">` đi lọt lớp đầu, để chỉ còn danh
sách thuộc tính chặn được nó.

Ba thẻ được mở đường nhờ quyết định này:

- `<meta charset="utf-8">` — neo mã hoá cho bản "xem trên trình duyệt", bản lưu `.html` và
  bản forward. Thư gửi qua SMTP vốn đã có `charset=utf-8` trong MIME nên đây **không phải**
  lỗi làm hỏng dấu tiếng Việt trong hộp thư; nó vá các đường còn lại.
- `<meta name="color-scheme" content="light dark">` — không có nó, Apple Mail và
  Outlook.com tự đảo màu. Nền `#173F33` chữ trắng sẽ thành thứ không ai duyệt.
- `<meta name="viewport">` — thẻ `emitDoc` vẫn xuất mà chưa bao giờ sống sót.

### 4. `<title>` và `html[lang]`

Thêm `title` vào `emailTags`, `lang` vào `emailAttributes['html']`.

`<title>` không chỉ là chuyện lịch sự: hiện tại thẻ bị bỏ nhưng **phần chữ được giữ lại**,
nên một template import có `<title>` sẽ nhả chữ đó ra thành text trần trong `<head>`. Cho
thẻ đi qua vừa sửa lỗi rơi vãi này, vừa trả lại thứ trình đọc màn hình dùng để đặt tên tài
liệu.

`lang="vi"` để trình đọc màn hình đọc tiếng Việt bằng giọng tiếng Việt.

### Cái gì **không** đổi

- **VML (`<v:roundrect>`, `<w:anchorlock>`) vẫn bị xoá.** Nút bo góc "bulletproof" cho
  Outlook là một quyết định riêng, với bề mặt lớn hơn hẳn (một không gian tên XML, không
  phải bốn chuỗi hằng). Nếu sau này cần thì viết ADR của nó, đừng nới cái này.
- **Comment thường vẫn bị xoá.** Quyết định 1 không mở comment; nó tránh comment.
- **`@media` vẫn bị xoá.** ADR-037 §2 giữ nguyên. Quyết định này làm fluid-hybrid chạy
  đúng như đã chốt, không đổi sang Option A.
- **`id` vẫn bị loại** (ADR-037 §3).
- **`mso-*` không mở theo tiền tố** — chỉ bốn tên trên.

## Consequences

- **Bố cục nhiều cột chạy được ở Outlook desktop.** Sáu preset thôi sập thành cột đơn. Đây
  là lý do tồn tại của ADR này; mọi thứ khác là đi kèm.
- **Giới hạn preheader mà ADR-040 tự ghi nhận được gỡ**, bằng `mso-hide:all` ở quyết định 2.
  Câu *"UI của khối phải nói rõ điều đó"* trong spec sanitizer-audit hết hiệu lực và phải
  được sửa trong cùng commit dựng.
- **Dark mode trở thành thứ kiểm soát được**, thay vì phó mặc cho client tự đảo màu. Bản
  thân việc *chọn* màu dark mode là việc khác, cần thiết kế riêng — ADR này chỉ mở đường.
- **Round-trip an toàn, đã kiểm.** `templates.service.ts:217` chỉ gọi sanitizer khi client
  gửi `body.html`; HTML đã lưu không bao giờ được sanitize lại. Nên comment đã nở không có
  đường bị một lượt sanitize thứ hai xoá mất. Nếu về sau có đường ghi nào sanitize lại HTML
  đã lưu, quyết định 1 **phải** được xem lại trước.
- **Không sửa gì cho HTML import sẵn có comment MSO.** Template import mang
  `<!--[if mso]>` vẫn bị xoá như hôm nay, vì không có gì đổi nó thành `<mso-ghost>`. Đây là
  giới hạn có chủ ý: cho comment tuỳ ý từ nguồn ngoài đi qua đúng là thứ quyết định 1 tránh.
- **ADR này không dựng gì cả.** Emitter phải được sửa để phát ghost table quanh mỗi
  `emitRow`/`emitColumn`, và `emitDoc` phải xuất bốn thẻ head. Đó là task riêng. Cho tới khi
  làm, allowlist rộng hơn mà đầu ra không đổi — giống hệt tình trạng ADR-042 đang mắc, và
  **đó chính là lỗi cần tránh lặp lại**: ADR-042 mở allowlist từ lâu, phần inspector chưa
  bao giờ dựng, và `inspector-fields.ts` tới hôm nay vẫn ghi lý do ngược lại
  (*"the sanitizer strips every one of them"*). Commit dựng phải sửa cả chú thích đó.
- **Bộ đếm "đã xoá cái gì" thay đổi.** `measureSanitize` đếm thẻ/thuộc tính bị bỏ; thêm bốn
  thẻ và bốn thuộc tính làm số liệu lệch so với trước. `SANITIZE_PASS_2_TAG_EXEMPTIONS` cần
  xem lại cùng lúc.
- **Cần một cổng, không chỉ test đơn vị.** Ít nhất ba khẳng định phải khoá được:
  (a) `data-mso` ngoài bốn khoá thì thẻ bị bỏ; (b) `data-w` không phải số nguyên 1–1000 thì
  thẻ bị bỏ; (c) `http-equiv` không bao giờ sống sót. Cả ba phải **mutation-test được** —
  sửa hỏng code thì test phải đỏ, đúng tinh thần `fidelity-needs-a-gate`.

## Phương án đã cân nhắc và loại

1. **Cho comment điều kiện đi thẳng qua allowlist.** Loại vì **bất khả thi**, không phải vì
   không thích: ba cấu hình khác nhau của `sanitize-html` đều xoá comment (bảng đo ở trên).
2. **Chèn lại ghost table ở API sau khi sanitize.** Loại vì API sẽ phải hiểu đâu là hàng,
   đâu là cột — trái thẳng ADR-037 §3, vốn buộc mọi ánh xạ cây phải nằm trong `project_data`
   và không bao giờ được suy ngược từ HTML.
3. **Nở `<mso-ghost>` ở lúc gửi thay vì lúc lưu.** Loại vì worker gửi từ ảnh chụp đông cứng
   (`email_snapshot.html`, BR-SEND-012) và hash nội dung trên đúng chuỗi đó; thêm một bước
   biến đổi sau khi chụp sẽ phá hợp đồng hash.
4. **Đổi cột từ `inline-block` sang bảng thật.** Loại vì mất khả năng xuống dòng trên
   mobile — đó đúng là lý do fluid-hybrid tồn tại, và ADR-037 §2 đã chốt.
