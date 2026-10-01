# ADR-047: Bảng màu tối, qua một khối `<style>` do máy sinh — `@media` mở đúng một khe, và chỉ cho `prefers-color-scheme`

Status: Accepted

Gỡ đầu dây ADR-045 tự để lại và sổ nợ rà soát §6 ghi tên. Nới **một khe hẹp** trên
ADR-037 §2 (*"không `@media`"*) và nói rõ khe đó rộng đúng bao nhiêu. Dùng lại nguyên
khuôn an toàn của ADR-045 quyết định 1.

## Context

### Đầu dây: tuyên bố có, bảng màu không

ADR-045 quyết định 3 cho `<meta name="color-scheme" content="light dark">` đi qua, với lý do
*"không có nó, Apple Mail và Outlook.com tự đảo màu"*. Thẻ đó nói với client: **đừng đảo màu,
tôi tự lo cả hai chế độ.** Nhưng không ai thiết kế chế độ tối cả. ADR-045 §Consequences tự ghi:
*"Bản thân việc chọn màu dark mode là việc khác, cần thiết kế riêng — ADR này chỉ mở đường."*
Sổ nợ §6 gọi đó đúng tên: *"mở đường rồi bỏ đó"*.

Một nửa của đầu dây đã được vá ngày 2026-09-11 (commit `7336a28`): `<body>` không khai `color`,
trong khi `emitText`/`emitContact` xuất `color:inherit` cho khối không đặt `textColor`, nên chữ
đó lấy màu từ **bảng kiểu của client**. Ở chế độ tối, client không đảo nền trắng (vì ta đã bảo
đừng), rồi tô chữ bằng màu sáng mặc định của nó — chữ sáng trên nền trắng. Nay `<body>` có
`color:#30463d` nên chuỗi `inherit` kết thúc bên trong email.

Nửa còn lại là ADR này: **thật sự có một bảng màu tối.**

### Đo trước khi quyết — không có đường nào đi được với pipeline hôm nay (probe 2026-09-11)

Chạy thẳng qua `sanitizeTemplateHtml`:

| Kỹ thuật | Nhận lại |
|---|---|
| `@media (prefers-color-scheme: dark)` trong `<style>` | **mất sạch** — có báo: *"Đã loại bỏ 1 quy tắc @media"* |
| `[data-ogsc] .c{…}` (móc dark mode của Outlook.com) | **mất sạch, và `changes` RỖNG** — mất im lặng |
| thuộc tính `class` | sống sót, nhưng không còn gì tác động lên nó |
| `<style>` thường, không `@media` | `juice` nội tuyến bình thường (nhưng đó chỉ là màu tĩnh) |
| `<meta name="color-scheme">` + `supported-color-schemes` | cả hai sống sót |

Chết ở đúng hai chỗ, đo riêng từng chỗ:

1. `juice(..., preserveMediaQueries: false)` — xoá `@media` lúc nội tuyến.
2. Lượt sanitize thứ hai (`allowStylesheet: false`) — xoá luôn thẻ `<style>`.

Bật `preserveMediaQueries: true` **và** cho `<style>` qua lượt hai thì khối về nguyên vẹn,
từng byte. Tức đường đi tồn tại, và nó chỉ là hai lá cờ.

### Nhưng hai lá cờ đó mở một lỗ xuyên qua toàn bộ allowlist — đo được

Đây là số đo quyết định thiết kế bên dưới, và nó **chưa từng được ghi ở đâu**:

| Đưa vào | Nhận lại |
|---|---|
| `<style>.x{position:absolute;top:-9999px;width:9999px;behavior:url(x.htc);font-family:Impact}</style>`, có khai `allowedStyles` | **nguyên vẹn, không sót một thuộc tính nào** |
| đúng các khai báo đó trong `style="..."` | `style="color:#ff0000"` — lọc sạch như thường lệ |

**`allowedStyles` của `sanitize-html` chỉ soi thuộc tính `style="..."`, không soi phần CSS bên
trong thẻ `<style>`.** Toàn bộ danh sách 27 thuộc tính mà ADR-037, ADR-038, ADR-040, ADR-042 và
ADR-045 dựng lên **không áp dụng** cho nội dung khối `<style>`.

Với CSS mà `juice` nội tuyến được thì vẫn an toàn — nó biến thành `style="..."` rồi mới bị lọc
(đo được: một overlay `position:fixed;inset:0;z-index:99999` của tác giả bị tước sạch). Nhưng
CSS nằm trong `@media` thì **không bao giờ được nội tuyến**, nên nó không bao giờ gặp allowlist:

| Đưa vào | Sau `juice(preserveMediaQueries:true)` |
|---|---|
| `@media (prefers-color-scheme: dark){ .x{position:absolute;behavior:url(evil.htc)} }` | **giữ nguyên cả hai thuộc tính** |

`stripUnsafeStyleBlocks` có bắt được `behavior:` và `url(` — nhưng nó là cái sàng thô, xoá cả
khối, và chỉ biết đúng danh sách của nó. `position`, `display:none`, `z-index`, `font-family`
tuỳ ý thì đi qua hết.

Và khối `<style>` **không phải giả định**: `emitCustomHtml` đang xuất `<style>${n.css}</style>`
từ khối HTML tuỳ chỉnh, tức CSS do tác giả gõ. Cho `<style>` sống sót lượt hai là cho CSS đó
vào kho lưu trữ.

**Kết luận bắt buộc: "bật hai lá cờ" bị loại vì lý do đo được, không phải vì khẩu vị.**

### Số đo mở ra đường thứ ba, rẻ hơn cả hai

| Đưa vào | Nhận lại |
|---|---|
| `<mc-dark></mc-dark>` (thẻ lạ) | bị bỏ, có báo *"Đã loại bỏ 1 thẻ `<mc-dark>`"* — tức mặc định vẫn là từ chối |
| `<div class="mc-dark-surface"><p class="mc-dark-ink">` | **cả hai class sống sót** |
| màu của bảng tối dạng hex nội tuyến | sống sót bình thường |

Ba dòng đó là toàn bộ điều kiện cần. Vì khối `<style>` sẽ được **sinh sau khi sanitize xong**,
`juice` không bao giờ nhìn thấy nó và lượt sanitize thứ hai cũng vậy — nên **không phải đổi
`preserveMediaQueries`, cũng không phải cho `<style>` qua lượt hai.** Đây chính xác là cơ chế
ADR-045 quyết định 1 đã dựng cho ghost table, áp cho một nội dung khác.

## Decision

### 1. `<mc-dark>` là thẻ đánh dấu, nở thành `<style>` hằng sau khi sanitize

`emitDoc` phát đúng một thẻ rỗng `<mc-dark></mc-dark>` trong `<head>`. Thẻ nằm trong
`emailTags` nên đi qua allowlist như mọi thẻ khác. **Sau** khi `sanitize()` và
`measureSanitize` chạy xong, một bước cuối trong `sanitizeTemplateHtml` đổi nó thành khối
`<style>` chứa quy tắc dark mode.

**Thẻ không mang thuộc tính nào.** Toàn bộ nội dung khối `<style>` là **một hằng chuỗi trong
mã nguồn** — không có tham số, không có nội suy, kể cả một số nguyên như `data-w` của ADR-045.
Đây là ranh giới an toàn của quyết định này, và nó chặt hơn ADR-045: ở đó tác giả còn ảnh
hưởng được một con số; ở đây tác giả **không ảnh hưởng được gì cả**.

**Sửa sau khi dựng, do chính cổng bắt được (2026-09-11).** Bản đầu của quyết định này viết
*"thẻ nào không phải `<mc-dark>` rỗng thì bị bỏ, không nở"*. Test mutation cho thấy điều đó
**không dựng được ở lớp này**: `mc-dark` không có thuộc tính nào trong allowlist, nên
`sanitize-html` đã tước sạch thuộc tính **trước khi** bước nở chạy — một
`<mc-dark data-x="1">` giả mạo đến nơi thì đã là thẻ rỗng, không cách nào phân biệt.

Và nó **không cần** phân biệt: bước nở không nhận tham số, nên một thẻ thừa chỉ có thể xin
đúng khối `<style>` hằng đó. Thứ nó *có thể* làm là xin năm mươi lần. Nên luật thật là:
**nở thẻ đầu tiên, xoá mọi thẻ còn lại** — đầu ra luôn có đúng một khối `<style>`, bất kể đầu
vào có bao nhiêu thẻ.

Đây là lý do cổng phải mutation-test được chứ không chỉ đọc cho xuôi: câu văn trong ADR nghe
hợp lý và sai, và chỉ có test chạy thật mới nói ra.

### 2. `@media` mở đúng một khe: chỉ `prefers-color-scheme`

ADR-037 §2 chốt bố cục responsive đi theo fluid/hybrid, **không `@media`**, và ADR-045
§"Cái gì không đổi" nhắc lại nguyên văn. Quyết định này **không đảo** điều đó:

- §2 nói về **bố cục**. Chuỗi `@media` duy nhất tồn tại sau ADR này là
  `@media (prefers-color-scheme: dark)`, và nó **không đổi một thuộc tính bố cục nào** — chỉ
  `background-color` và `color`.
- Không có `max-width`, không có `min-width`, không có breakpoint. Cột vẫn stack bằng
  fluid/hybrid đúng như ADR-037 §2 chốt và ADR-045 dựng nốt nửa Outlook.
- Khối `<style>` là hằng trong mã nguồn, nên **không có đường nào** để một `@media` khác lọt
  vào. Mở khe này không mở lại `<style>` của tác giả: `emitCustomHtml` vẫn bị lượt hai xoá thẻ
  `<style>` như hôm nay.

Nói cách khác: `@media` cho **bố cục** vẫn đóng. `@media` cho **màu sắc theo chế độ đọc** mở,
với đúng một khối do máy sinh.

### 3. Bảng màu tối — ba màu, và cách chọn chúng

| Vai trò | Sáng (hôm nay) | Tối |
|---|---|---|
| Nền ngoài (`body`) | `#f3f1ed` | `#0f1613` |
| Nền nội dung | `#ffffff` | `#16211d` |
| Chữ (ink) | `#30463d` | `#e6ede9` |

Tương phản WCAG, tính thật chứ không ước lượng (probe 2026-09-11):

| Cặp màu | Tỉ lệ | Ngưỡng |
|---|---|---|
| `#e6ede9` trên `#16211d` (chữ trên nền nội dung tối) | **13.91:1** | AAA cần 7:1 |
| `#e6ede9` trên `#0f1613` (chữ trên nền ngoài tối) | **15.43:1** | AAA |
| `#30463d` trên `#ffffff` (bảng sáng hôm nay, để đối chiếu) | 10.15:1 | AAA |
| `#ffffff` trên `#173f33` (nút solid) | 11.70:1 | AAA |
| `#e6ede9` trên `#173f33` (chữ trên section màu thương hiệu) | 9.83:1 | AAA |

Bảng tối **đọc tốt hơn** bảng sáng hiện tại (13.91 so với 10.15). Màu tối giữ sắc xanh của
thương hiệu (`#173f33`) thay vì xám trung tính, để email ở chế độ tối vẫn là email của cùng
một thương hiệu.

**Nút bấm không đổi màu, và đây là quyết định có đo.** Nút `solid` là nền `#173f33` chữ trắng,
đạt **11.70:1** — cặp đó đọc tốt trên nền tối y như trên nền sáng, nên thêm quy tắc cho nó là
thêm byte đổi lấy không gì.

### 4. Chỉ ghi đè màu MẶC ĐỊNH, không bao giờ ghi đè lựa chọn của tác giả

Đây là phần tinh tế nhất và là chỗ dễ làm hỏng nhất.

Quy tắc `@media` dùng `!important`, vì nó phải thắng `style="..."` nội tuyến. Nếu áp cho mọi
phần tử thì nó sẽ **xoá luôn màu tác giả cố ý chọn** — chữ trắng trên một section xanh đậm sẽ
bị đổi thành ink tối và biến mất.

Nên quy tắc chỉ bám vào **class**, và emitter **chỉ gắn class khi màu đang là mặc định**:

| Class | Gắn khi nào |
|---|---|
| `mc-dark-bg` | `<body>` — luôn luôn, vì nền ngoài không có control nào của tác giả |
| `mc-dark-surface` | Section/Column có `background` **chưa đặt hoặc đúng bằng `#ffffff`** |
| `mc-dark-ink` | Text/Heading/Contact có `textColor` **chưa đặt hoặc đúng bằng `#30463d`** |

Tác giả đổi màu một khối ⇒ khối đó **không có class** ⇒ chế độ tối không đụng tới nó, và nó
giữ cả nền lẫn chữ do tác giả chọn, vốn đã ăn khớp với nhau. Tác giả không đổi gì ⇒ khối theo
bảng màu tối.

Đây là lý do quyết định này **không** cần `EmailTheme` có thêm trường màu: nó không phải một
chủ đề thứ hai, nó là bảng màu mặc định có hai chế độ.

### Cái gì **không** đổi

- **`@media` cho bố cục vẫn bị xoá.** ADR-037 §2 giữ nguyên. Fluid/hybrid vẫn là cách stack.
- **`<style>` của tác giả vẫn bị xoá ở lượt hai.** `emitCustomHtml` không được lợi gì từ ADR
  này, có chủ ý.
- **`juice` vẫn chạy với `preserveMediaQueries: false`.** Không đổi một tuỳ chọn nào của nó.
- **`allowedStyles` vẫn chỉ soi `style="..."`.** ADR này không sửa điều đó; nó tránh phụ thuộc
  vào điều đó.
- **VML, comment thường, `id`** — như cũ.

## Consequences

- **Tuyên bố `color-scheme: light dark` thôi rỗng.** Email thật sự có chế độ tối, nên thẻ meta
  ADR-045 mở đường nay nói đúng sự thật. Đầu dây sổ nợ §6 đóng lại.
- **`supported-color-schemes` được thêm cùng lúc** (đo được: sống sót). Apple Mail bản cũ đọc
  thẻ này thay vì `color-scheme`; có tuyên bố mà thiếu nửa số client đọc được nó thì vẫn là
  tuyên bố rỗng ở nửa đó.
- **Đây là lần đầu một khối `<style>` tồn tại trong HTML đã lưu.** `measureSanitize` đếm thẻ,
  nên bước nở phải chạy **sau** mọi phép đo, đúng như `expandMsoGhosts` — nếu không, một
  `<style>` xuất hiện từ hư không sẽ bị báo ngược thành "đã thêm".
- **Round-trip an toàn, cùng lý do ADR-045 đã kiểm.** `templates.service.ts:217` chỉ gọi
  sanitizer khi client gửi `body.html`; HTML đã lưu không bao giờ được sanitize lại. Nếu về
  sau có đường ghi nào sanitize lại HTML đã lưu thì **cả ADR-045 quyết định 1 lẫn ADR này phải
  được xem lại trước** — khối `<style>` đã nở sẽ bị lượt hai xoá mất.
- **Chế độ tối không phủ màu tác giả tự chọn** (quyết định 4). Một section nền xanh đậm chữ
  trắng sẽ trông y hệt ở cả hai chế độ. Đó là hành vi đúng, nhưng nó có nghĩa là một email
  được tô màu kỹ sẽ *không* có chế độ tối — và UI chưa nói điều đó ở đâu cả. Ghi vào sổ nợ,
  không giả vờ là đã xong.
- **Outlook desktop không có chế độ tối theo cách này.** Word không đọc `@media`. Outlook.com
  thì dùng `[data-ogsc]`, mà đo được là `juice` không nội tuyến được nên nó biến mất im lặng —
  muốn hỗ trợ thì phải thêm vào chính khối hằng này, là một quyết định riêng.
- **Cần thêm khẳng định vào cổng, và phải mutation-test được:**

  | Cổng | Khẳng định |
  |---|---|
  | `ARCH-BUILDER-SANITIZER` | (a) `<mc-dark>` mang bất kỳ thuộc tính nào thì **không nở**; (b) một `<style>` do tác giả gõ trong `customHtml` **vẫn không** sống sót sau lượt hai, kể cả khi `<mc-dark>` có mặt; (c) chuỗi `@media` duy nhất trong đầu ra là `prefers-color-scheme`, không có breakpoint bố cục nào |
  | `emitter` | (d) class dark **chỉ** xuất hiện khi màu đang là mặc định — đổi `textColor` thì `mc-dark-ink` biến mất |

- **Hai bài học từ chính việc mutation-test ADR này, đáng ghi vì cả hai đều là cổng xanh mà
  không giữ gì:**
  1. Quyết định 1 viết một luật **không dựng được** (xem phần sửa ở trên). Chỉ test chạy thật
     mới nói ra.
  2. Cổng "CSS tác giả vẫn bị xoá" **ban đầu tự vô hiệu hoá chính nó**: payload dùng
     `behavior:x`, mà `behavior\s*:` nằm trong `unsafeCss`, nên `stripUnsafeStyleBlocks` xoá cả
     khối ngay bước một — test xanh bất kể hai lá cờ phía sau làm gì, và **ba** mutation khác
     nhau đều không đỏ. Sửa payload thành một quy tắc `@media` không chạm `unsafeCss` thì
     mutation "bật cả hai lá cờ" mới đỏ. Một cổng bị chính dữ liệu thử của nó tháo ngòi còn tệ
     hơn không có cổng, vì nó tạo cảm giác đã kiểm.

  Đo kèm: bật **một** lá cờ thì không sao (`juice` vẫn xoá thẻ `<style>` vì `removeStyleTags`),
  phải **cả hai** mới thủng — đúng như phần Context viết.

- **Bộ đếm "đã xoá cái gì" đổi lần nữa.** Thêm `mc-dark` vào `emailTags` làm `measureSanitize`
  nhìn khác đi, y như ADR-045 đã cảnh báo cho `mso-ghost`.

## Phương án đã cân nhắc và loại

1. **Bật `preserveMediaQueries: true` và cho `<style>` qua lượt hai.** Loại vì **đo được là
   mở một lỗ xuyên qua toàn bộ allowlist**: `allowedStyles` không soi nội dung `<style>`, và
   CSS trong `@media` không bao giờ được nội tuyến nên không bao giờ gặp bộ lọc —
   `position:absolute` và `behavior:url(evil.htc)` đi qua nguyên vẹn. Kèm theo: `emitCustomHtml`
   đang xuất `<style>` từ CSS tác giả gõ, nên lỗ đó có sẵn người dùng.
2. **Chỉ chọn màu tĩnh "hợp cả hai chế độ".** Loại vì nó không tồn tại: đã tuyên bố
   `color-scheme: light dark` thì client **không đảo màu**, nên nền trắng vẫn trắng ở chế độ
   tối. Một bảng màu duy nhất không thể vừa là nền trắng vừa là nền tối.
3. **Hạ `content` xuống `light only`.** Loại vì nó là rút lui, không phải giải pháp — và nó
   trả lại quyền đảo màu cho client, đúng thứ ADR-045 quyết định 3 đã tránh với lý do
   *"nền `#173F33` chữ trắng sẽ thành thứ không ai duyệt"*.
4. **Thêm màu tối vào `EmailTheme` cho tác giả chỉnh.** Loại vì đây là bảng màu mặc định có hai
   chế độ, không phải chủ đề thứ hai; và thêm trường model mà chưa có control là đúng khoản nợ
   §1 của sổ rà soát vừa được trả xong ngày 2026-09-11.
5. **Ghi đè màu bằng `!important` cho mọi phần tử.** Loại vì nó xoá lựa chọn cố ý của tác giả:
   chữ trắng trên section xanh đậm sẽ bị đổi thành ink tối và biến mất. Quyết định 4 gắn class
   theo điều kiện thay vì áp đại trà.
