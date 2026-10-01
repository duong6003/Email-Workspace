# ADR-048: Khối danh sách là một *kind* riêng, và `list-style-type` được mở

Status: Accepted

Trả nốt món nợ ADR-046 để lại có địa chỉ. Mở allowlist thêm **một** thuộc tính, theo đúng
tiền lệ ADR-042. Không đụng ADR-037 §2, không đụng ADR-047.

## Context

### ADR-046 đã đo và đã chỉ chỗ

Sổ nợ rà soát §2 xếp "không có bullet" chung nhóm với "không in đậm được một chữ" và "không
chèn link trong đoạn". ADR-046 làm hai cái sau, và **đo được rằng cái đầu không cùng loại**:

| Đưa vào | Nhận lại |
|---|---|
| `<p style="margin:0">x<ul><li>a</li></ul></p>` | `<p style="margin:0">x</p><ul><li>a</li></ul><p></p>` |
| `<h2 style="margin:0">x<ul><li>a</li></ul></h2>` | **giữ lồng bên trong `<h2>`** |

Bỏ `<ul>` vào trong `<p>` thì trình phân tích cắt đôi đoạn văn, `style` của đoạn không theo
sang danh sách, và còn lại một `<p></p>` rỗng — trong khi cùng thao tác đó ở `<h2>` lại lồng
bình thường. Một control cho ra hai kết quả khác nhau tuỳ thẻ chứa. ADR-046 §"Phương án đã
loại" mục 5 kết luận: **danh sách là KHỐI, không phải dải inline**, và giao lại cho một quyết
định riêng. Đây là quyết định đó.

### Đo lại, lần này với tư cách một khối (probe 2026-09-11)

Chạy thẳng qua `sanitizeTemplateHtml`. **Phần cấu trúc không cần mở gì cả:**

| Đưa vào | Nhận lại |
|---|---|
| `<ul><li>Mot</li><li>Hai</li></ul>` là khối riêng | **nguyên vẹn** |
| `<ol>…</ol>` | **nguyên vẹn** |
| `<ul style="margin;padding;color;font-size;line-height;text-align">` + `<li style="padding">` | **giữ đủ cả sáu thuộc tính** |
| danh sách lồng nhau | **nguyên vẹn** |
| `<strong>` và `<a href>` bên trong `<li>` (tức thành quả ADR-046) | **nguyên vẹn** |
| `mso-table-lspace:0pt` trên `<ul>` | **nguyên vẹn** |

**Nhưng mọi cách chọn ký hiệu đầu dòng đều bị tước — không sót cách nào:**

| Đưa vào | Nhận lại |
|---|---|
| `list-style-type` — cả 7 giá trị (`disc`, `circle`, `square`, `decimal`, `lower-alpha`, `upper-roman`, `none`) | **bỏ hết**, có báo *"Đã loại bỏ 1 khai báo list-style-type"* |
| `list-style` (shorthand) | bỏ, có báo |
| `list-style-position:inside` | bỏ, có báo |
| thuộc tính `type="a"` trên `<ol>` | bỏ, có báo *"Đã loại bỏ thuộc tính type"* |
| thuộc tính `start="3"` trên `<ol>` | bỏ, có báo |

Tức là: dựng khối danh sách hôm nay thì nó **chạy**, nhưng tác giả **không có cách nào** đổi
ký hiệu đầu dòng — năm đường, cụt cả năm.

### Tiền lệ chi phối, lần thứ tư

Kế hoạch vertical-slice, mục *"Hai thứ chặn thật, không phải sở thích"*:

> Cách xử **không phải** bỏ control khỏi inspector — mà là **mở allowlist**… để không có
> control nào cho ra kết quả rỗng.

ADR-042 áp cho bốn thuộc tính CSS, ADR-045 cho cả tầng Outlook, ADR-047 cho bảng màu tối. Đây
là lần thứ tư, và là lần **nhỏ nhất**: đúng một thuộc tính.

## Decision

### 1. `list` là một *kind* mới, không phải một dải inline

Thêm `list` vào `LEAF_KINDS`. `KINDS` được suy ra từ mảng runtime đó, nên
`ARCH-BUILDER-SANITIZER` **bắt buộc** phải có mẫu cho kind mới, nếu không cổng đỏ — đúng cơ
chế `document.ts` đã dựng sẵn cho chuyện này.

Emitter xuất `<ul>` hoặc `<ol>` ở **cùng cấp** với `<p>` của khối chữ, không lồng vào trong
nó. Đó là toàn bộ cách tránh hiện tượng cắt đôi đoạn văn đã đo ở trên.

### 2. Các mục dùng chính `content`, mỗi dòng một mục

**Không thêm trường mảng mới.** `Node.content` vốn đã là chuỗi, và khối danh sách đọc nó theo
quy ước **mỗi dòng là một mục**:

```
content = "Giao hàng miễn phí\nĐổi trả trong 30 ngày\nHỗ trợ 24/7"
  ⇒  <ul><li>Giao hàng miễn phí</li><li>Đổi trả trong 30 ngày</li><li>Hỗ trợ 24/7</li></ul>
```

Ba lý do, theo thứ tự quan trọng:

1. **Bảy nơi khác đang đọc `content`** (ADR-046 quyết định 1 liệt kê đủ): chèn `{{biến}}` theo
   offset caret, thước đo ký tự, `content-review`, `publish-readiness`, chip biến trên canvas,
   phần chữ thuần, cây cấu trúc. Một mảng `items: string[]` bắt cả bảy nơi học cấu trúc mới.
2. **Ô nhập đã có sẵn.** Inspector dùng đúng `textarea` của trường `content`, thêm một dòng
   gợi ý. Không có editor mới nào phải dựng.
3. **Đường nâng cấp còn để mở.** `Node.inline` của ADR-046 là các dải offset trên `content`;
   nếu sau này muốn in đậm trong một mục thì các dải đó đã sẵn sàng, chỉ cần cắt tại ranh giới
   dòng. Đo được là `<strong>`/`<a>` sống sót trong `<li>`, nên đường đó có thật — nhưng nó là
   việc khác, cần UI toolbar theo từng mục, và **ADR này không làm**.

Dòng trống bị bỏ qua, không sinh `<li>` rỗng. `content` rỗng ⇒ khối không xuất gì, giống
`emitImage` khi thiếu `src`.

### 3. Mở `list-style-type`, với từ vựng đóng — và **chỉ** thuộc tính đó

Thêm vào `allowedStyles['*']`, dùng mẫu riêng chứ không dùng chung `safeStyleValues`:

```
list-style-type: ^(?:disc|circle|square|decimal|lower-alpha|upper-alpha|lower-roman|upper-roman|none)$
```

Đúng khuôn ADR-042 quyết định 3 đã dùng cho `text-transform`: danh sách từ khoá **riêng cho
thuộc tính này**, không nhét vào danh sách từ khoá dùng chung. Nhét chung sẽ làm
`text-align:upper-roman` parse thành thứ trông hợp lệ mà vô nghĩa — đúng lỗi ADR-042 gọi tên.

Thuộc tính này trơ hoàn toàn: không tham chiếu URL, không thực thi gì, không ảnh hưởng bố cục.

**Bốn đường còn lại vẫn đóng, mỗi đường một lý do:**

| Không mở | Vì sao |
|---|---|
| `list-style` (shorthand) | Shorthand gộp cả `position` và `image`; `image` nhận `url()`, là đúng thứ ADR-042 quyết định 4 dựng cả một văn phạm để chặn. Một thuộc tính hẹp thì an toàn hơn một shorthand rộng cho cùng kết quả |
| `list-style-position` | `inside`/`outside` chỉ đổi chỗ xuống dòng của mục dài. Chưa ai xin, và mỗi thuộc tính mở ra là một thứ phải bảo trì |
| `type` trên `<ol>` | Trùng chức năng với `list-style-type` nhưng là thuộc tính HTML đã lỗi thời. Mở cả hai là hai đường làm một việc |
| `start` trên `<ol>` | Bắt đầu đánh số từ số khác 1 là một tính năng thật, nhưng nó là **thuộc tính**, không phải CSS, nên cần mở `emailAttributes.ol` — một bề mặt khác. Ghi vào sổ nợ, không lặng lẽ bỏ |

### 4. Outlook: `mso-table-lspace` và đệm trái tính bằng `px`

Word tự thêm khoảng đệm quanh danh sách như quanh bảng, nên khối xuất `MSO_TABLE_RESET` trên
`<ul>`/`<ol>` — đo được là cả hai thuộc tính `mso-*` sống sót. Thụt đầu dòng dùng
`padding-left` tính bằng `px` thay vì để client tự quyết, vì mặc định của các client lệch nhau
khá xa.

### Cái gì **không** đổi

- **ADR-037 §2 giữ nguyên**: quyết định này không thêm một `@media` nào, không đụng bố cục.
- **ADR-047 giữ nguyên**: khối danh sách nhận class `mc-dark-ink` theo đúng luật quyết định 4
  của ADR đó — chỉ khi màu chữ còn là mặc định.
- **ADR-046 giữ nguyên**: khối chữ vẫn không chứa danh sách, và `<ul>` trong `<p>` vẫn là thứ
  cần tránh. Khối mới tồn tại chính vì điều đó.
- **`list-style` shorthand, `list-style-position`, `type`, `start`** — vẫn bị tước.

## Consequences

- **Tác giả có danh sách gạch đầu dòng và danh sách đánh số**, chọn được ký hiệu, và mục có
  thể chứa `{{biến}}` như mọi trường chữ khác. Đây là lý do tồn tại của ADR này.
- **Danh sách 27 thuộc tính thành 28.** `mailcraft-integration-requirements.md` §1.3 phải sửa
  trong cùng commit — nó là tài liệu phía tích hợp đọc, và nó mở đầu bằng lời hứa mọi ràng
  buộc đều truy được về mã hiện tại. Cùng tiền lệ ADR-042 §Consequences đã lập.
- **`KINDS` dài thêm một, nên `ARCH-BUILDER-SANITIZER` đỏ cho tới khi có mẫu.** Đó là tính
  năng, không phải phiền toái: `document.ts` suy `Kind` từ mảng runtime chính vì lý do này.
- **Mục danh sách chưa có định dạng inline.** Đo được là `<strong>`/`<a>` sống sót trong
  `<li>`, và `Node.inline` của ADR-046 là offset trên `content` nên về nguyên tắc dùng lại
  được — nhưng cần cắt dải tại ranh giới dòng và cần một toolbar theo từng mục. **Chưa làm**,
  ghi ở đây chứ không giả vờ là đã xong.
- **`<ol start>` chưa có.** Danh sách đánh số luôn bắt đầu từ 1. Là thuộc tính chứ không phải
  CSS nên nó cần mở một bề mặt khác; quyết định riêng.
- **Quy ước "mỗi dòng một mục" là một quy ước, và UI phải nói ra.** Một tác giả gõ đoạn văn dài
  vào ô này sẽ nhận một danh sách một mục rất dài. Trường `content` của kind này phải có dòng
  gợi ý, và nó là một phần của commit dựng chứ không phải việc sau.
- **Cần thêm khẳng định vào cổng, mutation-test được:**

  | Cổng | Khẳng định |
  |---|---|
  | `ARCH-BUILDER-SANITIZER` | (a) mẫu `list` khai `listStyle` và giá trị đó **sống sót** qua sanitizer — nếu không hàng đó xanh rỗng, đúng lỗi chú thích `letterSpacing` trong chính tệp đó đã ghi; (b) một giá trị `listStyle` ngoài từ vựng thì **không** được xuất |
  | `emitter` | (c) mỗi dòng thành đúng một `<li>`, dòng trống bị bỏ; (d) nội dung `<li>` vẫn được escape; (e) `ordered` chọn đúng `<ol>`/`<ul>` |

## Phương án đã cân nhắc và loại

1. **Cho `<ul>` vào khối chữ như một dải inline.** Loại vì đo được (ADR-046 §Context): nó cắt
   đôi `<p>`, bỏ lại `<p></p>` rỗng, và hành xử khác hẳn trong `<h2>`. Cùng một thao tác, hai
   kết quả.
2. **Mảng `items: string[]` trên `Node`.** Loại vì tạo một cấu trúc văn bản thứ hai bên cạnh
   `content`, mà bảy nơi khác đang đọc `content` — đúng cái giá ADR-046 quyết định 1 đã đo
   được ở prototype (`parameterize` sửa `content`, bỏ quên `inline`, thao tác biến mất).
3. **Dựng khối mà không mở `list-style-type`.** Loại vì đó là control cho ra kết quả rỗng: đo
   được là cả năm đường chọn ký hiệu đều bị tước, nên inspector sẽ có một select không đổi
   được gì. Đây đúng là lỗi ADR-042 §Context gọi tên cho `border-radius`.
4. **Mở `list-style` shorthand cho gọn.** Loại vì shorthand kéo theo `list-style-image`, vốn
   nhận `url()` — ADR-042 quyết định 4 đã dựng hẳn một văn phạm gradient để `url(` không lọt
   vào `background-image`; mở cửa sau cho nó qua `list-style` sẽ vô hiệu hoá việc đó.
5. **Dựng bằng bảng (`<table>`) với ô ký hiệu riêng, như nhiều ESP làm.** Loại vì không cần:
   đo được `<ul>`/`<ol>`/`<li>` đi qua sanitizer nguyên vẹn và Outlook dựng được chúng khi có
   `MSO_TABLE_RESET`. Dựng bảng giả sẽ tốn gấp nhiều lần số byte cho cùng một kết quả, và Gmail
   cắt ở 102KB.
