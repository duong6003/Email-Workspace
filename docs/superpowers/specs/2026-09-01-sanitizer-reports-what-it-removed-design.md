# Sanitizer phải nói ra nó đã xoá gì — Design

**Ngày:** 2026-09-01
**Trạng thái:** đã triển khai (S7 Task 44–46, 2026-09-04). §6 có một sửa đổi — đọc khung ở đó.
**Vì sao có tài liệu này:** spike §4.3 và `2026-09-01-builder-block-sanitizer-audit.md` §6
**Liên quan:** ADR-037, ADR-038, ADR-039

---

## 1. Vấn đề, nói thẳng

Hai lần liên tiếp trong tuần này, một khiếm khuyết nghiêm trọng chỉ lộ ra vì **có người ngồi đo thủ công**:

- Spike phát hiện `padding` 15→0, `border` 14→1, `margin` 9→1 — mất sạch hệ thống khoảng cách, kể cả với template `imported` đang chạy production.
- Kiểm kê khối phát hiện nút CTA mất màu nền, đường ngăn render ra không có gì, preheader thôi ẩn, bảng mất nền.

Trong **cả hai lần**, `sanitizeTemplateHtml` trả về `errors: []`, `warnings: []`, và đúng một dòng `changes` chung chung. Hệ thống biết nó vừa xoá gì và không nói.

> Nếu sanitizer báo cáo, cuộc kiểm kê khối đã **không cần tồn tại**. Nó tự sinh ra.

## 2. Ba lỗ hổng, không phải một

Đọc mã hiện hành:

| Trường | Được sinh ra khi nào | Hiển thị ở đâu |
|---|---|---|
| `errors` | Chỉ khi vượt 5 MB | Không nơi nào |
| `warnings` | Chỉ khi: khối `<style>` chứa CSS nguy hiểm, hoặc ảnh không phải https/cid | Chỉ **đếm** — `TemplatesScreen.tsx:73` hiện "đã loại bỏ N nội dung không an toàn" |
| `changes` | Một câu cố định `"Sanitized imported HTML before storage."` nếu output khác input | **Không nơi nào.** Trường chết |

Ba vấn đề độc lập:

1. **Không đo.** `sanitize-html` xoá tag/attribute/CSS không nằm trong allowlist mà không báo lại. Đây là lỗ chính.
2. **Không liệt kê.** `warnings` chỉ được đếm, người dùng không biết mất *cái gì*.
3. **`changes` chết.** Đã có sẵn trong entity, trong contract, trong response — và không ai đọc.

## 3. Quyết định thiết kế

### 3.1 Đo bằng cách so sánh kết quả, không nhân bản luật

Hai hướng:

- **A. Móc vào `sanitize-html`.** Nó không có callback cho thứ bị xoá; muốn biết thì phải tự áp lại allowlist trước khi gọi. ⇒ **Nhân bản luật ở hai nơi, và chúng sẽ trôi khỏi nhau.** Chính ADR-038 vừa sửa allowlist — bản sao thứ hai sẽ lỗi thời ngay hôm đó.
- **B. So sánh trước/sau.** Đếm khai báo trong chuỗi vào và chuỗi ra, chênh lệch chính là thứ bị xoá.

**Chọn B.** Nó đo *kết quả thật*, nên không thể lệch với allowlist dù allowlist đổi bao nhiêu lần.

### 3.2 So sánh **quanh từng lần `sanitize()`**, không so đầu-cuối pipeline

Đây là chi tiết dễ làm sai nhất. Pipeline là:

```
input → stripUnsafeStyleBlocks → sanitize(pass 1, cho phép <style>)
      → juice(inline CSS, xoá <style>)
      → sanitize(pass 2, chốt)  → html
```

`juice()` **hợp pháp** di chuyển CSS từ `<style>` vào `style=""` và xoá thẻ `<style>`. So input với output cuối sẽ báo `<style>` là "bị mất" — đúng về mặt chuỗi, **sai về mặt ý nghĩa**, và một thuộc tính nằm trong `<style>` có thể nhân lên thành nhiều lần xuất hiện inline, khiến phép đếm vô nghĩa.

⇒ Đo **ngay trước và ngay sau mỗi lần gọi `sanitize()`**, bỏ `juice` ra ngoài phép so sánh hoàn toàn. Cả hai pass đều được phủ, và không có biến đổi hợp pháp nào lọt vào báo cáo.

### 3.3 Báo cáo ba loại mất mát

| Loại | Cách đo | Ví dụ thật đã gặp |
|---|---|---|
| Thuộc tính CSS | Đếm `prop:` trong `style="…"` | `box-shadow`, `background`, `border-top`, `display` |
| Thuộc tính HTML | Đếm `attr=` | `aria-label`, `id`, `data-*` |
| Thẻ | Đếm `<tag` | `<button>`, `<svg>`, `<meta>` |

Chỉ báo khi số lượng **giảm**. Giữ nguyên hoặc tăng thì im lặng.

### 3.4 Vẫn dùng `changes: string[]`, không đổi contract

Cám dỗ là chuyển sang cấu trúc như `template-content-lint.ts` (`code`/`severity`/`count`/`field`). **Không làm**, vì hai lý do:

- Thu hẹp/đổi hình dạng một trường đã publish là thay đổi phá vỡ contract, cần ADR riêng (tiền lệ ADR-035).
- Mục đích ở đây là **nói cho người nghe hiểu**, không phải cho máy hành động. Việc "máy hành động" đã có lint lo, với mã và vị trí.

Thay vào đó, `changes` chuyển từ một câu cố định thành danh sách câu cụ thể, tiếng Việt (spec §2.6):

```
"Đã loại bỏ 4 khai báo box-shadow (không được hỗ trợ trong email)."
"Đã loại bỏ 12 khai báo background — dùng background-color."
"Đã loại bỏ thuộc tính aria-label trên 3 phần tử."
```

Câu thứ hai là ví dụ cho một nguyên tắc: **khi có cách thay thế, nói ra cách đó.** Đây chính là thông điệp lẽ ra đã cứu cả nút bấm lẫn ô bảng ở cuộc kiểm kê.

### 3.5 Chống nhiễu

Sanitizer chạy trên **mỗi lần autosave**, không chỉ lúc import. Danh sách 15 dòng hiện mỗi 2 giây sẽ bị bỏ qua ngay ngày đầu.

- Gộp theo thuộc tính, không theo lần xuất hiện — một dòng cho `box-shadow`, kèm số đếm.
- Giới hạn số dòng (đề xuất 10), thừa thì gộp thành `"và N loại khác"`.
- `changes` được persist vào `draft_validation_json`, nên UI so sánh được với lần trước và **chỉ báo khi tập thay đổi**, không báo lại mỗi lần lưu.

## 4. Nơi hiển thị

| Bề mặt | Hôm nay | Sau thay đổi |
|---|---|---|
| Import (`TemplatesScreen`) | Toast đếm `warnings` | Toast đếm + mở được danh sách `changes` |
| Editor (autosave) | Không gì cả | Chỉ báo khi tập `changes` đổi so với lần lưu trước |
| Builder (S4) | Chưa tồn tại | **Bắt buộc** — người dựng khối phải thấy ngay khối vừa kéo vào mất gì |

Bề mặt thứ ba là bề mặt quan trọng nhất, và là lý do việc này nên xong **trước** S4.

## 5. Ranh giới

**Không** đụng tới allowlist. Tài liệu này chỉ làm cho việc xoá trở nên nhìn thấy được. Câu hỏi *có nên cho phép `display` hay không* (khối preheader, kiểm kê §2.3) là một ADR riêng.

**Không** đổi hình dạng `warnings`/`errors`. Chỉ `changes` đổi từ một câu thành danh sách.

**Không** biến cảnh báo thành lỗi chặn. Mọi thứ ở đây là thông tin — nội dung vẫn lưu được.

## 6. Nghiệm thu

> **Cập nhật 2026-09-04 (S7 Task 46 — đã triển khai).** Gạch 1 dưới đây đã lỗi thời và được thay. Gạch 2, 3, 4 giữ nguyên và đều đạt. Lý do đầy đủ ở `2026-09-04-sanitizer-report-gap-analysis.md` §4.2, tóm tắt: ADR-040 cho phép lại 3 trong 16 mục, ADR-042 thêm 4 mục, S2 Task 5/6 sửa emitter phần còn lại — nên chạy trên output builder hôm nay không còn mục nào để tìm, và con số 16 không đo được gì nữa.
>
> **Thay bằng:** một tệp mẫu HTML *import* đóng băng ở `.agents/runs/2026-08-31-mailcraft-builder/evidence/s7-task43/lossy-import-sample.html`, sinh ra đúng một **tập đóng 10 dòng** phủ cả sáu loại mất mát. `ARCH-MAILCRAFT-FIDELITY` khẳng định trọn tập đó, không phải vài dòng lấy mẫu. Mẫu cố định thì phép nghiệm thu không trôi theo allowlist — đúng tính chất mà §3.1 muốn cho chính phép đo.
>
> Một sửa nữa so với §3.2: `@media` bị **`juice`** xoá chứ không phải `sanitize()` xoá, nên đo đúng theo chữ của §3.2 sẽ không bao giờ nêu được nó. Pipeline được đo ở **bốn** điểm, và điểm quanh `juice` hẹp đúng một thứ là `@media` — nên lý do thật của §3.2 (juice *di chuyển* khai báo một cách hợp pháp) vẫn nguyên vẹn. Xem gap-analysis §4.1.

- ~~Chạy `sanitizeTemplateHtml` trên đúng mẫu ở kiểm kê khối ⇒ `changes` nêu tên **cả 16** khai báo/thuộc tính mà kiểm kê tìm thủ công.~~ → thay bằng tệp mẫu đóng băng, xem khung trên.
- HTML sạch không sinh dòng `changes` nào.
- Template dùng `<style>` rồi được juice inline **không** bị báo là mất `<style>`.
- Sửa allowlist (thêm hay bớt) **không** cần sửa mã báo cáo — bằng chứng cho §3.1.
- Chi phí: đo trên HTML 512 KB, thời gian thêm không vượt 10% thời gian sanitize hiện tại.
