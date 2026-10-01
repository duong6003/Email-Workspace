# S2 Spike — Output builder qua sanitizer EOW: kết quả

**Ngày:** 2026-09-01
**Trạng thái:** spike đã chạy trên output thật; phát hiện chặn ở §4 **đã được chốt và sửa** — xem §8
**Bằng chứng:** `.agents/runs/2026-08-31-mailcraft-builder/evidence/s2-spike/`
**Liên quan:** `docs/adr/adr-037-builder-template-allowlist-and-editor-placement.md`, FE-013, ADR-019

---

## 1. Spike đã làm gì

Câu hỏi FE-013 để treo: *"GrapesJS + newsletter preset có xuất ra đúng tập tag cho phép không?"*

Cách trả lời: lấy HTML **xuất thật** từ prototype Mailcraft (transpile `app/studio.tsx` bằng esbuild, gọi trực tiếp `exportHtml(initial)` — không chép tay), rồi chạy qua **chính** `sanitizeTemplateHtml` và `lintTemplateContent` đã build trong `apps/api/dist`.

Input: 5.145 bytes. Output sau sanitizer: 3.528 bytes — **giữ lại 69%**.

## 2. Phát hiện 0 — câu hỏi FE-013 đặt sai tiền đề

Prototype **không dùng `grapesjs-preset-newsletter`**. `package.json` chỉ có `grapesjs@^0.22.13` trần. GrapesJS được dùng làm **canvas chỉnh sửa**, còn HTML xuất ra do **bộ emitter riêng của prototype** sinh (`exportHtml`/`exportNode`, `studio.tsx:378-444`), từ một model `Doc` tự định nghĩa (`section`/`row`/`column`/`heading`/`text`/`button`/`table`/...).

⇒ Không có "newsletter preset" nào để đánh giá. Câu hỏi đúng là: **emitter của prototype có sống sót sanitizer không.** Phần còn lại của tài liệu trả lời câu đó.

## 3. Tin tốt — cấu trúc sống sót nguyên vẹn

| Hạng mục | in → out | |
|---|---|---|
| `table` / `td` / `th` / `tr` | 8→8 / 12→12 / 3→3 / 9→9 | ✅ |
| `a` / `img` / `h1` / `h2` / `p` / `caption` | 7→7 / 1→1 / 1→1 / 1→1 / 4→4 / 1→1 | ✅ |
| `border-radius` | 5→5 | ✅ **ADR-037 hoạt động trên output thật** |
| Biến `{{...}}` | 3→3 | ✅ |
| `color` / `font-size` / `text-align` / `background-color` | giữ 100% | ✅ |
| `meta` / `style` | 1→0 / 1→0 | ⚠️ đúng như dự kiến |

Sanitizer báo `errors: []`. Không có tag cấm nào bị sinh ra — emitter đã tự tránh `<button>`, `<svg>`, `<form>`.

## 4. Phát hiện chặn — **toàn bộ hệ thống khoảng cách bị xoá âm thầm**

| Thuộc tính | in → out | Mất |
|---|---|---|
| `padding` | **15 → 0** | **100%** |
| `border` | **14 → 1** | **93%** |
| `margin` | **9 → 1** | **89%** |
| `background` (shorthand) | 12 → 0 | 100% (dự kiến — không có trong allowlist) |
| `display` | 3 → 0 | dự kiến |
| `box-shadow` / `letter-spacing` / `text-transform` | 4→0 mỗi cái | dự kiến |

`padding`, `margin`, `border` **đều nằm trong allowlist**. Chúng vẫn bị xoá.

### 4.1 Nguyên nhân gốc

`safeStyleValues` (`template-html-sanitizer.ts:27-33`) có 5 regex, **không regex nào khớp giá trị nhiều thành phần cách nhau bằng khoảng trắng.** Kết quả đo trực tiếp (`evidence/s2-spike/css-value-probe.mjs`):

| Khai báo | Kết quả |
|---|---|
| `padding:24px` | **KEPT** |
| `padding:12px 20px` | **DROPPED** |
| `padding:42px 42px 42px 42px` | **DROPPED** |
| `margin:0` | **KEPT** |
| `margin:0 0 18px 0` | **DROPPED** |
| `border:0` | **KEPT** |
| `border:1px solid #ccc` | **DROPPED** |
| `border-radius:8px` | **KEPT** |
| `border-radius:8px 8px 0 0` | **DROPPED** |
| `background-color:#fff` | **KEPT** |
| `font-family:Arial, Helvetica, sans-serif` | **KEPT** (dấu phẩy, không phải khoảng trắng) |

### 4.2 Vì sao đây là phát hiện lớn hơn ADR-037 tưởng

ADR-037 §1 ghi nhận đúng giới hạn này nhưng **đóng khung nó như một điều lạ riêng của `border-radius`**: *"No existing regex parses space-separated multi-value CSS, so four-corner shorthand is not accepted."*

Thực tế cùng một nguyên nhân đó xoá luôn:

- **`padding` nhiều giá trị** — cơ chế tạo khoảng cách chính của email dạng bảng;
- **`margin` nhiều giá trị**;
- **`border: 1px solid #ccc`** — cú pháp viền email tiêu chuẩn, và **không có dạng một-giá-trị nào thay thế được** (`border:1px` không cho ra viền nhìn thấy vì thiếu `style`/`color`).

`border-radius` là trang trí. `padding` là cấu trúc. Email mất sạch padding không phải "hơi khác thiết kế" — nó là chữ dính sát mép, không đọc được.

### 4.3 Điều tệ nhất: hoàn toàn im lặng

```
errors  : []
warnings: []
changes : ["Sanitized imported HTML before storage."]
```

Không cảnh báo nào nói rằng 15 khai báo `padding` vừa bị xoá. Người soạn bấm Lưu, thấy "Đã lưu", và email đã hỏng.

### 4.4 Không chỉ là vấn đề của builder

`sanitizeTemplateHtml` là đường duy nhất, không có nhánh riêng cho `origin`. Nên **template `imported` hôm nay cũng đang mất padding/border y hệt** — bất kỳ ai dán một email HTML bình thường vào EOW. Đây là hành vi đang chạy trên production, không phải rủi ro tương lai.

Seed hiện tại không có template nào dùng CSS nhiều giá trị nên chưa có test nào chạm tới; không có tài liệu nào ngoài ADR-037 ghi nhận giới hạn này.

## 5. Phát hiện thứ hai — responsive chết đúng như ADR-037 §2 dự đoán

`@media` 1 → 0. Nhưng class `mc-stack` và `mc-column` **vẫn sống sót** trong HTML đã lưu.

⇒ HTML mang theo hai class không còn quy tắc nào dùng đến. Cột không bao giờ xếp chồng trên mobile. Đây là bằng chứng thực nghiệm cho quyết định hướng B ở ADR-037 §2: emitter hiện tại của prototype **đang dựa vào `@media`** và phải viết lại theo fluid/hybrid.

## 6. Quyết định cần chốt

**Hai đường, phải chọn trước khi viết block nào ở S4.**

### Đường A — nới `safeStyleValues` để nhận giá trị nhiều thành phần

Cách an toàn: **tách theo khoảng trắng, mỗi token vẫn phải khớp một trong 5 regex sẵn có** — không nới lỏng bằng một regex lỏng hơn. Tư thế bảo mật không đổi (mọi token vẫn được kiểm), `unsafeCss` vẫn chặn `url(`/`expression(`/`javascript:` ở tầng trên.

Mở được: `padding`, `margin`, `border`, `border-radius` 4 góc.
Chi phí: sửa sanitizer — code security-adjacent, cần test kỹ và có thể cần review bảo mật.

### Đường B — giữ nguyên sanitizer, ép block chỉ dùng một giá trị

Mọi block chỉ phát `padding` đều bốn cạnh; khoảng cách bất đối xứng làm bằng ô bảng lồng nhau và hàng spacer (kỹ thuật email cổ điển); viền làm bằng thuộc tính `border` của `<table>` (đã được phép) thay vì CSS.

Chi phí: emitter phức tạp hơn đáng kể, HTML dài hơn, và **không giải quyết được** vấn đề template `imported` đang mất padding.

### Khuyến nghị

**Đường A.** Lý do: đường B không sửa được lỗi đang tồn tại ở luồng `imported`, mà lỗi đó im lặng và ảnh hưởng người dùng thật ngay bây giờ. Đường A sửa cả hai luồng bằng một thay đổi, và giữ nguyên nguyên tắc "mỗi token phải hợp lệ".

Dù chọn đường nào, nên thêm: khi sanitizer xoá một khai báo, **ghi vào `changes` cụ thể cái gì bị xoá** thay vì một câu chung chung — sự im lặng ở §4.3 mới là thứ biến một giới hạn thành một cái bẫy.

## 7. Trạng thái FE-013 / ADR-019 sau spike

> **Cập nhật 2026-09-01 — cả hai đã đóng.** FE-013 chuyển sang **`Rejected`** (không phải `Accepted`): thư viện chưa từng gánh việc gì, xem **ADR-039**. ADR-019 chuyển sang **`Accepted`** sau khi có một lần kiểm chứng xanh trọn vẹn — 235 file test, 1517 test, không lỗi. Đoạn dưới là nhận định tại thời điểm spike, giữ nguyên làm bản ghi.

**Chưa đóng được.** Spike trả lời xong câu hỏi tag (đạt) nhưng phát hiện một chặn ở tầng CSS chưa có quyết định. Đề nghị giữ FE-013 ở `"Spike required"` cho tới khi §6 được chốt và có test chứng minh, rồi mới chuyển sang `Accepted` cùng ADR-019.

---

## 8. Kết quả sau khi chốt đường A (ADR-038)

Đã chọn **đường A** và triển khai trong `docs/adr/adr-038-multi-value-css-in-the-template-sanitizer.md`. Đo lại trên **cùng file input** (`evidence/s2-spike/prototype-export.html`):

| Thuộc tính | Trước ADR-038 | Sau ADR-038 |
|---|---|---|
| `padding` | 15 → **0** | 15 → **15** ✅ |
| `margin` | 9 → **1** | 9 → **9** ✅ |
| `border` | 14 → **1** | 14 → **14** ✅ |
| `border-radius` | 5 → 5 | 5 → 5 ✅ |
| Bytes giữ lại | **69%** | **85%** |

Bằng chứng: `evidence/s2-spike/after-eow-sanitizer.html` (trước) và `after-eow-sanitizer-adr038.html` (sau).

### 8.1 Một chi tiết suýt làm hỏng bản sửa

Danh sách từ khoá của sanitizer **không có `transparent`**, trong khi emitter thật phát ra `border:${width}px solid ${color || "transparent"}`. Nếu token chỉ nhận đúng danh sách từ khoá cũ thì `border:0px solid transparent` — dạng phổ biến nhất trong output thật — **vẫn bị xoá**, và bản sửa sẽ trông xanh trên unit test mà vô dụng trên dữ liệu thật.

Vì vậy token nhận cả từ trần (`[a-z][a-z-]*`). Đây không phải nới lỏng mới: pattern nguyên bản `/^[a-z][a-z\s,-]*$/` vốn đã cho phép chuỗi chữ bất kỳ làm **cả giá trị**. Có test riêng cho đúng chuỗi `border:0px solid transparent`.

### 8.2 Những gì vẫn mất — và đều đúng thiết kế

`display` 3→0, `box-shadow` 4→0, `letter-spacing` 4→0, `text-transform` 4→0, `background` (shorthand) 12→0 — không nằm trong allowlist, không đổi. `meta`/`style` 1→0 và `@media` 1→0 cũng vậy (ADR-037 §2, hướng B).

⇒ **Block ở S4 vẫn phải xếp chồng mobile bằng fluid/hybrid**, và vẫn không được dựa vào `display`. Phần này ADR-038 không đụng tới.
