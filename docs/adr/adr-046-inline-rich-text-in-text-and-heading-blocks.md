# ADR-046: Rich text inline trong khối text/heading — dải đánh dấu trên một chuỗi, không phải HTML tác giả gõ

Status: Accepted

Mở đường cho khả năng soạn thảo mà `emitText` chưa từng có. Không thay thế ADR nào.
Giữ nguyên ADR-037 §2 (không `@media`) và ADR-037 §3 (không suy ngược cây từ HTML).
Tôn trọng ADR-044: prototype là gốc thị giác — và ADR-044 tự giới hạn ở thị giác,
nên phần mô hình dữ liệu dưới đây là quyết định của ADR này, có nêu chỗ lệch.

## Context

### Rào cản nằm ở client, không ở sanitizer

`emitText` (`apps/web/src/screens/templates/builder/emitter.ts`) kết thúc bằng đúng một dòng:

```ts
const body = escapeHtml(n.content ?? '').replace(/\n/g, '<br>');
```

Ô nhập là `<textarea>` trần. Hệ quả: không in đậm được một chữ giữa câu, không chèn
link trong đoạn, không nhấn mạnh được gì. `Node.content` là `string`
(`document.ts:92`), và đó là toàn bộ mô hình văn bản.

Sanitizer phía server đã nhận `b i u a em strong span ul ol li blockquote code` từ
lâu, `allowedStyles` có cả `font-style` lẫn `text-decoration`. Sổ nợ rà soát
(`docs/superpowers/specs/2026-09-11-mailcraft-editor-audit-backlog.md` §2) ghi đúng
điều đó và giao lại cho ADR này.

### Đo trước khi quyết — probe 2026-09-11, chạy thẳng qua `sanitizeTemplateHtml`

Không qua `dist/`, đúng cách ADR-042 và ADR-045 đã làm. Mọi ô "Nhận lại" dưới đây là
chuỗi thật sanitizer trả về, không phải suy luận.

**Thẻ inline đặt trong `<p style="margin:0">` — cái `emitText` thật sự xuất:**

| Đưa vào | Nhận lại |
|---|---|
| `x<b>y</b>z`, `<i>`, `<u>`, `<em>`, `<strong>`, `<span>`, `<code>`, `<font>` | **giữ nguyên** cả 8 |
| `<sub>`, `<sup>`, `<s>`, `<strike>`, `<mark>`, `<small>`, `<big>` | **thẻ bị bỏ, chữ ở lại** — không có trong `emailTags` |
| `<a href="https://a.test/x">y</a>` | giữ nguyên |
| `<a href="https://a.test" title="t">` | giữ nguyên cả `title` |
| `<strong>a<em>b</em></strong>` | giữ nguyên, lồng đúng |
| `a<br>b` | `a<br />b` |

**Danh sách bị chặn — và đây là chỗ đáng đọc kỹ nhất:**

| Đưa vào | Nhận lại |
|---|---|
| `<script>alert(1)</script>` | mất sạch |
| `<img src="x" onerror="alert(1)">` | `<img />` — mất cả `src` lẫn `onerror` |
| `<span onclick="alert(1)">y</span>` | `<span>y</span>` |
| `<b onmouseover="alert(1)">y</b>` | `<b>y</b>` |
| `<a href="javascript:alert(1)">` | `<a>y</a>` — mất `href` |
| `<a href="data:text/html,…">`, `vbscript:`, `//evil.test/x` | `<a>y</a>` cả ba |
| `<a href="mailto:…">`, `tel:`, `{{link_xac_nhan}}` | **giữ nguyên** cả ba |
| `<a href="…" target="_blank" rel="noopener">` | mất `rel` (không có trong `emailAttributes.a`), giữ `target` |
| `<span style="color:#ff0000;position:absolute">` | `style="color:#ff0000"` — rơi `position` |
| `<span style="width:expression(alert(1))">` | mất cả `style` |
| `<svg onload>`, `<iframe>`, `<form><input>`, `<base href>` | mất sạch cả bốn |
| `<b>` lồng 150 lớp | còn 99 lớp (`nestingLimit:100`), chữ còn nguyên |
| `a<b>bold` (thiếu thẻ đóng) | `a<b>bold</b>` — tự đóng |
| `<b>a<em>b</b>c</em>` (thẻ chéo) | `<b>a<em>b</em></b>c` — **tự sắp xếp lại** |

**Danh sách — và lý do chúng không có trong quyết định này:**

| Đưa vào | Nhận lại |
|---|---|
| `<p style="margin:0">x<ul><li>a</li><li>b</li></ul></p>` | `<p style="margin:0">x</p><ul><li>a</li><li>b</li></ul><p></p>` |
| `<p …>x<ol><li>a</li></ol></p>` | `<p …>x</p><ol>…</ol><p></p>` |
| `<p …>x<blockquote>q</blockquote></p>` | `<p …>x</p><blockquote>q</blockquote><p></p>` |
| `<h2 style="margin:0">x<ul><li>a</li></ul></h2>` | **giữ lồng bên trong `<h2>`** |
| `<p>x</p><ul><li>a</li></ul>` (anh em, không lồng) | giữ nguyên |

Đây là số đo **bác bỏ một giả định trong đề bài**: "không có bullet" đúng, nhưng
bullet **không phải** một dải inline. Bỏ `<ul>` vào trong `<p>` thì trình phân tích
cắt đôi đoạn văn, `style` của đoạn không theo sang danh sách, và còn lại một `<p></p>`
rỗng. Trong `<h2>` thì lại lồng được — tức hành vi **khác nhau tuỳ thẻ chứa**, cho
cùng một thao tác của tác giả. Một control cho ra hai kết quả khác nhau là đúng thứ
ADR-042 §Context gọi tên.

**Bề mặt tấn công mà việc bỏ `escapeHtml` sẽ mở ra:**

| Đưa vào (trong nội dung `<p>`) | Nhận lại |
|---|---|
| `<mso-ghost data-mso="row-open"></mso-ghost>` | `<!--[if mso]><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><![endif]-->` |
| `<mso-ghost data-mso="col-open" data-w="600">` | `<!--[if mso]><td width="600" valign="top"><![endif]-->` |
| `<MSO-GHOST data-mso="row-open">` (viết hoa) | **nở y hệt** — regex có cờ `i` |
| `<mso-ghost data-mso="evil">` | thẻ bị bỏ (từ vựng đóng vẫn giữ đúng lời hứa của ADR-045) |

Dòng đầu là kết luận bắt buộc của cả ADR này: **sanitizer server KHÔNG phải hàng rào
cuối cùng cho nội dung văn bản.** `expandMsoGhosts` chạy *sau* `sanitize()`, đúng như
ADR-045 quyết định 1 thiết kế. Nếu `emitText` chuyển sang cho HTML tác giả đi thẳng
qua, một người gõ `<mso-ghost data-mso="row-open">` vào ô nội dung sẽ chèn được một
`<table><tr>` **không cân bằng** vào email cho Outlook — sanitizer nhìn thấy một thẻ
hợp lệ trong allowlist và cho qua, rồi chính nó nở thẻ đó thành comment điều kiện mà
không lớp nào còn soi được nữa. ADR-045 §Consequences đã ghi *"Nếu về sau có đường
ghi nào sanitize lại HTML đã lưu, quyết định 1 phải được xem lại trước"*; đây là mặt
kia của cùng câu đó, và nó chưa được ghi ở đâu.

**Nội dung cũ nếu bỏ escape — câu hỏi migrate:**

| Đưa vào | Nhận lại |
|---|---|
| `Giá 5 &lt; 10 &amp; &quot;rẻ&quot; …` (escape như hôm nay) | `Giá 5 &lt; 10 &amp; "rẻ" …` — nghĩa giữ nguyên |
| `Giá 5 < 10 & "rẻ" > mong đợi <script>alert(1)</script> <b>đậm</b>` (thô) | `Giá 5 &lt; 10 &amp; "rẻ" &gt; mong đợi  <b>đậm</b>` |

Dòng dưới là mất mát thật, đo được, trên **hai** mặt: `<script>alert(1)</script>` biến
mất **cùng với chữ bên trong** (tác giả gõ chữ đó như văn bản thì mất chữ), và
`<b>đậm</b>` **thành in đậm thật** thay vì hiện ra đúng như đã gõ. Ngược lại `5 < 10`
sống sót, vì `<` kèm khoảng trắng không mở được thẻ. Nên rủi ro **không phải** "mọi
dấu `<` thành thẻ" như đề bài phỏng đoán — nó hẹp hơn và lệch hơn thế: chỉ những `<`
theo sau là tên thẻ mới đổi nghĩa, và mức độ hỏng thì tuỳ tên thẻ đó có trong
allowlist hay không. Một tài liệu cũ viết về HTML là ví dụ hỏng nặng nhất.

### Prototype vẽ thanh công cụ soạn thảo thế nào (ADR-044)

Đọc trước khi tự nghĩ ra, đúng như ràng buộc. Đo trên
`design-reference/mailcraft-ui-handoff-v1/source/app/studio.tsx`:

- **Prototype KHÔNG có thanh công cụ định dạng.** Ô nội dung của `text` và `heading`
  là `<textarea>` trần trong một `<Field>`, kèm đúng một nút `.wide` bên dưới:
  *"◇ Chèn biến tại cuối nội dung"* (dòng 885). Không có nút B/I/U ở đâu cả.
- Điều khiển duy nhất bám theo vùng chọn là `.v3-parameter` (dòng 638): một nút nổi
  `position:fixed; left:50%; bottom:24px`, nền xanh `--v3-green`, hiện khi bôi đen chữ
  **trên canvas**, và việc nó làm là **tham số hoá** — biến đoạn chữ thành `{{biến}}`,
  không phải in đậm.
- Prototype **có** mô hình inline: `inline?: InlineNode[]` (dòng 124), sáu loại
  `text | br | link | strong | em | span`, dựng bởi `inlineHtml()` (dòng 372).
  **Không có `u`, không có `ul/ol/li`, không có `code`, không có `blockquote`.**
- Nhưng `inline` **chỉ được ghi khi import HTML** (`inlineFrom`, dòng 704). Không có
  đường soạn thảo nào tạo ra nó. Canvas dựng nó bằng `renderInline` (dòng 828) —
  React element thật, **không** `dangerouslySetInnerHTML`.
- `inlineHtml(n.inline, n.content)` lùi về `escapeHtml(fallback).replace(/\n/g,"<br>")`
  khi `inline` rỗng — **đúng dòng `emitText` đang chạy hôm nay.**

Và một lỗi đo được trong chính prototype, quan trọng cho quyết định 1 bên dưới:
`parameterize` (dòng 636) ghi lại **`content`** và không đụng tới `inline`. Sau một lần
tham số hoá, hai bản sao của cùng một đoạn chữ lệch nhau, và `inlineHtml` ưu tiên
`inline`, nên thao tác của người dùng **không hiện ra**. Prototype tự chứng minh cái
giá của việc giữ hai bản sao văn bản.

`ARCH-MAILCRAFT-DOM` đang từ chối `v3-parameter` với lý do vẫn còn hiệu lực:
*"EOW's canvas is a click-to-select structure (Task 17) and text is edited in the
inspector, not in place — there is no canvas selection for the button to read."*
Quyết định 4 dưới đây **không** làm lý do đó hết hạn, và nói rõ vì sao.

### Tiền lệ chi phối

Đây là lần thứ ba áp mục *"Hai thứ chặn thật, không phải sở thích"* của kế hoạch
vertical-slice. ADR-042 áp cho bốn thuộc tính CSS, ADR-045 cho cả tầng Outlook. Lần
này thứ "cho ra kết quả rỗng" là **khả năng nhấn mạnh một chữ** — thứ mà mọi trình
soạn email đều có và trình này thì không.

Kèm theo là bài học đắt nhất của repo, ghi ở đầu `inspector-fields.ts`: ADR-042 mở
allowlist ngày 2026-09-02, control mãi tám ngày sau mới dựng, và một **test đang xanh**
tên *"never generates a field for a property the sanitizer strips"* đã **giữ** khoảng
trống đó. Xem §Consequences: ADR này ràng buộc commit dựng phải xử lý mọi khẳng định
ngược lại, kể cả khẳng định đang xanh.

## Decision

### 1. Mô hình là DẢI ĐÁNH DẤU trên đúng một chuỗi, không phải cây, không phải chuỗi HTML

`Node.content` vẫn là `string` và vẫn là **nơi duy nhất chứa văn bản**. Thêm một
trường song song chỉ chứa **định dạng**, tham chiếu văn bản đó bằng offset:

```ts
export type InlineMarkKind = 'strong' | 'em' | 'underline' | 'link';
export type InlineMark = {
  start: number;          // offset ký tự vào `content`, đã kẹp trong [0, content.length]
  end: number;            // > start
  kind: InlineMarkKind;
  href?: string;          // chỉ khi kind === 'link'
};
export type Node = { /* … */ content?: string; inline?: InlineMark[] };
```

**Ba phương án đã cân nhắc, và vì sao chọn cái này** — xem §"Phương án đã loại" cho
bản đầy đủ; điểm quyết định là: `content` là chuỗi mà **bảy nơi khác đang đọc**
(`insertTemplateVariable` chèn `{{biến}}` theo offset caret, thước đo 110 ký tự của
preheader, `content-review.ts`, `publish-readiness.ts`, `highlightVariables` trên
canvas, phần chữ thuần, `structure-tree`). Một cây `InlineNode[]` sẽ tạo bản sao thứ
hai của văn bản và bắt cả bảy nơi học cây — hoặc lệch. Prototype đã lệch, đo được, ở
`parameterize`. Dải đánh dấu giữ **một** nguồn văn bản; định dạng là thứ chú lên trên.

Đây là chỗ **lệch có chủ ý** so với prototype. ADR-044 tự giới hạn ở thị giác —
`ARCH-MAILCRAFT-DOM` trích đúng câu đó khi từ chối `v3-widths`: *"the decision is
purely visual and does not touch the model or the emitter"*. Nên chọn mô hình khác là
trong quyền của ADR này; giấu chuyện đó đi mới là vi phạm.

### 2. Allowlist phía client: đúng bốn dấu, không thuộc tính nào ngoài `href`

Bốn `kind` ở quyết định 1 ánh xạ sang **bốn hằng chuỗi trong mã nguồn**:

| `kind` | Xuất ra | Vì sao |
|---|---|---|
| `strong` | `<strong>…</strong>` | đo được: sống sót; `<b>` cũng sống nhưng `strong` mang ngữ nghĩa |
| `em` | `<em>…</em>` | đo được: sống sót |
| `underline` | `<u>…</u>` | đo được: sống sót. **Vượt ngoài prototype** (`InlineNode` không có `u`) — nêu rõ chứ không lặng lẽ: `u` nằm trong `emailTags`, và gạch chân là nút thứ ba của mọi trình soạn thảo. Prototype thiếu nó vì importer của nó bỏ `<u>`, đó là khoảng trống của prototype, không phải một quyết định |
| `link` | `<a href="…">…</a>` | đo được: sống sót, kèm `mailto:`/`tel:`/`{{biến}}` |

**Không có thuộc tính nào khác được xuất. Không `style`, không `class`, không `title`,
không `target`, không `id`.** Danh sách này là **đóng**: thêm một dấu là sửa ADR, không
phải sửa một mảng.

**`<a href>` chịu đúng luật đang có, không luật mới:** giá trị đi qua `safeUrl()` của
`emitter.ts` — chấp nhận `https:`/`http:`/`mailto:`/`tel:`/`cid:` và đúng một dạng biến
`{{ten_bien}}` (`^\{\{\s*[a-z][a-z0-9_]{0,63}\s*\}\}$`), trả `''` cho mọi thứ khác —
rồi qua `escapeHtml()`. `safeUrl` trả rỗng thì **dấu `link` bị bỏ và chữ vẫn còn**, y
như `emitButton` đang làm: mất liên kết chứ không mất câu văn.

**`rel="noopener"` không được thêm** dù có vẻ nên: đo được là sanitizer bỏ `rel`
(không có trong `emailAttributes.a`). Xuất một thuộc tính sẽ bị tước là đúng cái lỗi
ADR-042 §Context gọi tên. Trong email nó cũng vô nghĩa — không có `window.opener`.

**Danh sách và blockquote KHÔNG nằm trong ADR này**, vì số đo ở §Context: `<ul>` trong
`<p>` cắt đôi đoạn văn, trong `<h2>` thì không. Một danh sách là **khối**, không phải
dải. Nó thuộc về một *kind* mới (`list`) với emitter riêng — quyết định khác, đo
riêng. `code` và `span` cũng không vào: `span` không mang ngữ nghĩa gì khi không có
`style` đi kèm, `code` chưa có ai xin.

### 3. Ranh giới an toàn: `escapeHtml` KHÔNG bị bỏ — nó đổi chỗ

Đây là câu trả lời cho "bỏ escape trong `emitText` thì cái gì chặn XSS": **không bỏ.**

`emitText` sẽ không còn escape *cả câu* một lần, mà escape **từng đoạn chữ** giữa các
dấu. Thẻ chèn vào là bốn hằng ở quyết định 2. Tác giả **không có đường nào** viết được
một ký tự có nghĩa cú pháp vào đầu ra:

1. Mọi ký tự trong `content` đều đi qua `escapeHtml` — `<`, `>`, `&`, `"` thành thực
   thể, y như hôm nay. Gõ `<mso-ghost data-mso="row-open">` ra `&lt;mso-ghost …&gt;`,
   hiện lên đúng như đã gõ. Đây là lý do bảng đo ghost ở §Context **không** trở thành
   lỗ hổng.
2. Tên thẻ không đến từ dữ liệu. Chúng là bốn chuỗi hằng, chọn bằng `switch` trên một
   union bốn giá trị. `kind` lạ thì **bỏ dấu**, không xuất gì — cùng khuôn default-deny
   với `expandMsoGhosts` của ADR-045.
3. Tham số duy nhất từ dữ liệu là `href`, qua `safeUrl()` rồi `escapeHtml()`.
4. Emitter **không phân tích HTML** ở bất kỳ đâu. Không `innerHTML`, không parser,
   không regex trên markup tác giả gõ. Nó *sinh* markup từ một cấu trúc đã kiểm.

**Vì sao sanitizer server là chưa đủ — hai lý do độc lập, mỗi lý do tự nó đủ:**

- **Canvas dựng nội dung TRƯỚC khi nó đi qua server.** `CanvasLeafPreview`
  (`BuilderScreen.tsx:209`) dựng ngay khi gõ; `sanitizeTemplateHtml` chỉ chạy lúc lưu,
  và `templates.service.ts:217` chỉ gọi nó khi client gửi `body.html`. Giữa hai thời
  điểm đó có autosave, có undo/redo, có preview. Một ranh giới an toàn chỉ tồn tại ở
  server thì canvas không có ranh giới nào.
- **Đo được: server không phải lớp cuối.** `expandMsoGhosts` chạy *sau* `sanitize()`,
  nên một chuỗi vượt qua allowlist còn được **nở ra** thành comment điều kiện. Nội dung
  văn bản đi thẳng qua sanitizer là nội dung có thể chạm tới bước nở đó.

Canvas dùng **cùng một cấu trúc** dựng thành **React element**, không phải chuỗi HTML —
đúng như `renderInline` của prototype. `dangerouslySetInnerHTML` không xuất hiện, nên
canvas không cần tin bất cứ thứ gì.

### 4. Thanh công cụ nằm trong inspector, trên `<textarea>`, bằng từ vựng lớp sẵn có

Theo đúng ADR-044 và đúng lý do `ARCH-MAILCRAFT-DOM` đang từ chối `v3-parameter`:
văn bản được sửa **trong inspector**, không sửa tại chỗ trên canvas. Nên thanh công cụ
là một hàng nút ngay trên ô `<textarea>` của trường `content`, dùng lớp
**`v3-segment`** — control dạng hàng nút mà prototype đã có và `Inspector` của nó đã
dùng cho `Segment values={["H1","H2","H3","H4"]}`.

**Không đặt tên lớp `v3-` mới.** Prototype không có thanh công cụ để mà port, nên chế
ra một tên `v3-*` mới sẽ là bịa ra "gốc thị giác" — ngược hẳn ADR-044. Dùng lại
`v3-segment` là mượn từ vựng đã có, và `ARCH-MAILCRAFT-DOM` không phải đổi một dòng.

`v3-parameter` **vẫn bị từ chối, lý do vẫn còn nguyên hiệu lực**: quyết định này không
làm canvas thành `contenteditable`, không tạo vùng chọn trên canvas, không đụng tới
việc tham số hoá. Vùng chọn mà thanh công cụ đọc là `selectionStart`/`selectionEnd`
của chính `<textarea>` — cùng cơ chế `insertVariable` đang dùng qua `focusedFieldRef`
(`BuilderScreen.tsx:2358`), và cùng cơ chế prototype dùng qua `variableCursor`
(dòng 502).

### 5. Chuẩn hoá trước khi xuất: dải chồng nhau phải cho ra thẻ luôn cân bằng

Dải do người dùng tạo **sẽ** chồng nhau (in đậm "abc", rồi nghiêng "bcd"). HTML không
cho thẻ chéo, và đo được là sanitizer **tự sắp xếp lại** `<b>a<em>b</b>c</em>` thành
`<b>a<em>b</em></b>c` — tức nếu emitter xuất thẻ chéo thì đầu ra đã lưu **khác** thứ
emitter viết ra, và canvas sẽ không khớp email.

Nên trước khi xuất, dải được chuẩn hoá thành các **đoạn không chồng**: cắt tại mọi mốc
đầu/cuối, mỗi đoạn mang một *tập* dấu, và thẻ được mở theo **thứ tự cố định**
`strong → em → underline → link`. Kết quả luôn cân bằng, luôn tất định, và không phụ
thuộc thứ tự người dùng bấm nút. Đây là hàm thuần, kiểm được không cần DOM
(spec §2.1: web không có test render component).

Dải rỗng (`start >= end`), dải ra ngoài `[0, content.length]`, và dải `link` có
`safeUrl` rỗng đều bị **loại lúc chuẩn hoá**, không phải lúc xuất.

### 6. Migrate: `inline` vắng mặt ⇒ đúng đường cũ, từng byte

**Phát hiện bằng sự vắng mặt của trường, tuyệt đối không dò `content` xem có `<`.**

```
inline == null hoặc rỗng  ⇒  escapeHtml(content).replace(/\n/g, '<br>')   ← y hệt hôm nay
inline có phần tử         ⇒  đường chuẩn hoá + xuất ở quyết định 5
```

Đây cũng chính là hình dạng `inlineHtml(n.inline, n.content)` của prototype, và nó là
lý do dấu `<` của tài liệu cũ **không thể** biến thành thẻ: tài liệu cũ không có
`inline`, nên nó không bao giờ chạm tới đường mới. Số đo ở §Context cho thấy cái giá
của lựa chọn ngược lại: `<script>alert(1)</script>` gõ như văn bản sẽ **mất cả chữ**,
`<b>đậm</b>` sẽ **thành in đậm thật**.

**Điểm chuyển đổi: lần đầu tác giả bấm một nút định dạng trên khối đó.** Không có
migration hàng loạt, không có script chạy trên cơ sở dữ liệu, không có bước nâng cấp
lúc đọc. `content` **không bị sửa** khi chuyển đổi — chỉ có `inline` từ `undefined`
thành một mảng. Bỏ hết định dạng thì `inline` về mảng rỗng và khối quay lại đúng đường
cũ. Chuyển đổi **thuận nghịch và không mất mát**, vì văn bản chưa bao giờ rời khỏi
`content`.

Hệ quả cho mọi nơi khác: `insertTemplateVariable`, thước 110 ký tự, `content-review`,
`publish-readiness`, phần chữ thuần **không phải sửa gì** — chúng vẫn đọc `content`, và
`content` vẫn là văn bản thuần. Đổi lại, offset trong `inline` phải được dời khi
`content` bị sửa; đó là hàm thuần thứ hai cần kiểm (§Consequences).

### Cái gì **không** đổi

- **ADR-037 §2 giữ nguyên: không `@media`.** Quyết định này không thêm một quy tắc CSS
  nào, không đụng bố cục.
- **ADR-037 §3 giữ nguyên.** Không có đường nào suy ngược `inline` từ HTML; nó chỉ
  được ghi bởi thao tác của tác giả trong inspector.
- **`escapeHtml` không bị gỡ khỏi khối nào khác.** `emitButton`, `emitLogo`,
  `emitContact`, `emitTable`, `emitPreheader`, `emitSocial` không đổi một dòng — nhãn
  nút và preheader vẫn là văn bản thuần.
- **Sanitizer server không đổi một dòng.** Đây là ADR đầu tiên trong loạt này *không*
  mở allowlist: mọi thẻ cần thiết đã ở đó từ lâu, và số đo chứng minh điều đó.
- **Canvas vẫn là bề mặt chọn khối (Task 17)**, không phải trình soạn tại chỗ.

## Consequences

- **Tác giả in đậm được một chữ giữa câu và chèn được link trong đoạn.** Đó là lý do
  tồn tại của ADR này; mọi thứ khác là đi kèm.
- **Đây là ADR đầu tiên trong loạt không cần mở allowlist server.** Rào cản đúng là ở
  client như sổ nợ §2 ghi. Cũng có nghĩa: `template-html-sanitizer.test.ts` không có
  test mới nào từ ADR này, và điều đó là đúng, không phải thiếu sót.
- **Danh sách (bullet) vẫn chưa có, và bây giờ có địa chỉ.** Không phải "chưa làm" mà
  là *"đo rồi, nó là khối chứ không phải dải"*. Sổ nợ §2 phải được sửa trong commit
  dựng để không còn xếp bullet chung nhóm với in đậm/link.
- **`fontStyle`/`textDecoration` cấp khối (sổ nợ §2, hai mục nhỏ) vẫn chưa làm và
  không bị ADR này thay thế.** Nghiêng cả khối và nghiêng một chữ là hai control khác
  nhau; prototype có `italic?: boolean` ở cấp `Node` *và* `em` ở cấp inline. ADR này
  làm cái thứ hai.
- **Rủi ro trôi giữa canvas và email tăng lên, và phải có cổng riêng.** `canvas-style.ts`
  chia sẻ helper với `emitter.ts` cho *CSS*; nội dung inline là bề mặt thứ hai có thể
  trôi, và commit `2c23073` đã trôi đúng kiểu đó một lần (thêm cho emitter, quên canvas).
  Cấu trúc chuẩn hoá ở quyết định 5 phải là **một hàm thuần dùng chung**, và
  `canvas-style.test.ts` phải có khẳng định so hai bên.
- **Cần thêm khẳng định vào hai cổng sẵn có, và cả hai phải mutation-test được**
  (phá code → test đỏ → khôi phục; một cổng chưa thử phá thì không nhận):

  | Cổng | Khẳng định phải thêm |
  |---|---|
  | `ARCH-BUILDER-SANITIZER` | (a) mẫu `text`/`heading` phải **mang `inline`** — nếu không, hàng đó xanh một cách rỗng, đúng lỗi mà chú thích `letterSpacing`/`textTransform` trong chính tệp đó đã ghi. (b) `content` chứa `<mso-ghost data-mso="row-open">` đi qua `emitNode` → `sanitizeTemplateHtml` **không được** cho ra chuỗi `[if mso]` nào. (c) `href` dạng `javascript:` trong một dấu `link` không được xuất ra `href`. |
  | `ARCH-MAILCRAFT-DOM` | không cần lớp mới (quyết định 4), nhưng **lý do từ chối `v3-parameter` phải được đọc lại và xác nhận còn hiệu lực** trong commit dựng — đây đúng là loại lý do mà repo đã để hết hạn tám ngày một lần rồi. |

- **Bốn chỗ đang khẳng định điều ngược lại phải sửa trong CÙNG commit dựng**, kể cả
  khi đang xanh — đây là ràng buộc, không phải lời khuyên, và là bài học ghi ở đầu
  `inspector-fields.ts`: (1) chú thích `emitText` về `escapeHtml`; (2) sổ nợ §2
  (*"Đừng dựng code trước khi ADR đó chốt"* — đã chốt); (3) mọi test khẳng định
  `emitText` luôn escape toàn bộ nội dung; (4) chú thích đầu `inspector-fields.ts` nếu
  nó nói khối chữ chỉ có văn bản thuần. **Một lý do hết hạn nằm trong test đang xanh
  thì nó thành luật.**
- **Chưa có gì cho HTML import.** Template import mang `<b>` trong đoạn vẫn bị
  `emitText` bỏ qua như hôm nay, vì không có đường nào dựng `inline` từ HTML —
  ADR-037 §3 cấm đúng chuyện đó. Prototype có `inlineFrom()` cho việc này; port nó là
  quyết định khác.
- **Offset là thứ dễ hỏng nhất trong quyết định này.** Sửa `content` mà không dời
  `inline` sẽ làm định dạng trượt sang chữ khác — im lặng, và chỉ thấy trên canvas.
  Hàm dời offset phải có test riêng cho chèn trước dải, chèn giữa dải, xoá đè lên
  mốc, và chèn `{{biến}}` qua `insertTemplateVariable`.
- **Gmail cắt ở 102KB.** Mỗi dấu tốn thêm byte. Đoạn không chồng nào **không mang dấu
  nào** thì không được bọc thẻ — cùng lý do `emitText` bỏ qua `letter-spacing` ở giá
  trị no-op (ADR-042, dựng 2026-09-10).

## Phương án đã cân nhắc và loại

1. **Cho `content` chứa thẳng HTML, dựa vào sanitizer server.** Loại vì **đo được là
   không an toàn**, không phải vì không thích: `<mso-ghost data-mso="row-open">` gõ vào
   ô nội dung sẽ nở thành comment điều kiện *sau* khi sanitizer chạy xong (bảng đo
   §Context). Cộng thêm: canvas dựng trước server, nên nửa thời gian không có hàng rào
   nào cả.
2. **Cây `InlineNode[]` như prototype.** Loại vì tạo bản sao thứ hai của văn bản bên
   cạnh `content`, mà bảy nơi khác đang đọc `content`. Prototype tự chứng minh cái giá:
   `parameterize` sửa `content`, bỏ quên `inline`, và thao tác của người dùng biến mất.
   Không loại vì "prototype sai" — mà vì EOW có bảy nơi phụ thuộc `content` mà prototype
   không có.
3. **`contenteditable` trên canvas, kèm thanh công cụ nổi như `.v3-parameter`.** Loại vì
   `ARCH-MAILCRAFT-DOM` đã từ chối đúng hướng này với lý do còn hiệu lực: canvas EOW là
   bề mặt click-to-select (Task 17), làm nó editable là dựng lại mô hình soạn thảo chứ
   không phải port thị giác. Thêm nữa, `contenteditable` sinh HTML của trình duyệt —
   quay lại đúng phương án 1 và bề mặt tấn công của nó.
4. **Dùng Markdown trong `content`, dịch lúc xuất.** Loại vì đổi một mô hình lấy một mô
   hình khác mà vẫn phải phân tích chuỗi tác giả gõ, và làm hỏng nội dung cũ ngay lập
   tức: một tài liệu đang có `*` hay `_` sẽ đổi nghĩa mà không ai bấm gì. Cũng không có
   cách nào nhấn mạnh nửa từ, vốn là chuyện bình thường trong tiếng Việt có dấu.
5. **Mở `ul/ol/li` như dải inline cho đủ bộ ba "đậm, link, bullet" của sổ nợ.** Loại vì
   đo được: `<ul>` trong `<p>` cắt đôi đoạn văn và bỏ lại `<p></p>` rỗng, trong `<h2>`
   thì lồng bình thường — cùng một thao tác, hai kết quả. Danh sách cần một *kind* mới
   với emitter riêng, đo riêng.
6. **Thêm `rel="noopener"` vào link cho chắc.** Loại vì đo được là sanitizer tước `rel`
   (không có trong `emailAttributes.a`), nên xuất nó là dựng một control cho ra kết quả
   rỗng — đúng lỗi ADR-042 §Context gọi tên. Trong email cũng không có `window.opener`
   để mà bảo vệ.
