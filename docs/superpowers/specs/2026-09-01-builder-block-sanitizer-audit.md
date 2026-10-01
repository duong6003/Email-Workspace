# Kiểm kê khối builder qua sanitizer — cái gì hỏng, sửa ở đâu

**Ngày:** 2026-09-01
**Trạng thái:** kiểm kê xong. **§2.3 đã giải bằng ADR-040** (2026-09-02) — số mất giảm 16 → 11. Năm việc còn lại đều là sửa emitter, là đầu vào bắt buộc cho S4.
**Cách đo:** lấy nguyên chuỗi HTML mà emitter của prototype phát ra cho từng khối (`studio.tsx` → `exportNode`/`htmlNode`), điền giá trị thật, chạy qua `sanitizeTemplateHtml` đã build (sau ADR-038).
**Liên quan:** ADR-037, ADR-038, ADR-039, `2026-09-01-grapesjs-spike-findings.md`

---

## 1. Vì sao có tài liệu này

Spike ở mức toàn tài liệu cho biết **85% byte sống sót**. Con số đó che mất một chuyện: phần mất không rải đều. Nó **dồn vào vài khối cụ thể, và làm hỏng chức năng của chúng**, chứ không chỉ làm chúng xấu đi.

ADR-039 vừa chốt rằng emitter là của chúng ta. Vậy mọi khiếm khuyết dưới đây cũng là của chúng ta — và phần lớn **sửa được trong emitter, không cần đụng sanitizer**.

## 2. Bốn khối hỏng chức năng

Xếp theo mức độ nghiêm trọng.

### 2.1 Nút bấm mất màu nền — nghiêm trọng nhất

Emitter viết `style="…;background:${bg};…"`. `background` là shorthand, **không nằm trong allowlist**; chỉ `background-color` có.

⇒ **Nút CTA — thành phần quan trọng nhất của email marketing — render ra không có màu nền.** Chữ trắng trên nền trắng.

**Sửa ở emitter:** `background:` → `background-color:`. Một từ. Không cần đổi sanitizer.

### 2.2 Đường ngăn biến mất hoàn toàn

Emitter viết `<hr style="border:0;border-top:${h}px solid ${color};margin:${p}px 0">`.

`border` và `margin` sống sót. `border-top` **không có trong allowlist** nên bị xoá. Còn lại đúng `border:0` — tức là **lệnh xoá viền**.

⇒ Khối "Đường ngăn" render ra **không có gì cả**.

**Sửa ở emitter:** dùng kỹ thuật email cổ điển — một hàng bảng có `height` và `background-color`:
`<table role="presentation" width="100%"><tr><td style="height:2px;background-color:#173f33"></td></tr></table>`.
Cả `height` lẫn `background-color` đều đã được phép. Không cần đổi sanitizer.

### 2.3 Preheader không còn ẩn

Emitter viết `display:none!important;max-height:0;overflow:hidden;opacity:0;color:transparent`.

**Bốn trong năm thuộc tính bị xoá.** Chỉ `color:transparent` sống sót.

⇒ Đoạn text lẽ ra chỉ hiện ở dòng preview của hộp thư **vẫn chiếm chỗ trong email**, chỉ là màu trong suốt. Layout bị đẩy xuống bởi một khối vô hình.

> **✅ Đã giải (2026-09-02) — ADR-040 chọn hướng A**, cho phép `display`, `max-height`, `overflow`. Đo lại: cả ba sống sót, preheader ẩn được. `opacity` cố ý **không** cho phép (thừa, và là một cách ẩn thứ hai không thêm khả năng gì) ⇒ emitter phải thôi phát nó. **Giới hạn còn lại — đã hết hiệu lực 2026-09-10:** `mso-hide:all` từng bị xoá nên preheader không ẩn trong Outlook desktop. **ADR-045 mở thuộc tính đó**, emitter phát nó, và round-trip có test (`builder-block-sanitizer.test.ts`). UI của khối không còn phải cảnh báo gì.

**Không sửa được trong emitter.** Kỹ thuật ẩn preheader *bắt buộc* cần `display:none` hoặc bộ `max-height:0` + `overflow:hidden`. Ba lựa chọn, cần quyết định:

- **A.** Thêm `display` vào allowlist. Nó là thuộc tính bố cục, không phải bề mặt tấn công — `display:none` không thực thi gì. Rẻ nhất.
- **B.** Bỏ khối preheader khỏi bộ khối. Mất một tính năng có giá trị thật cho email marketing.
- **C.** Giữ khối nhưng ghi rõ giới hạn cho người dùng — tệ nhất: hiển thị một control mà kết quả sai.

Đề xuất **A**, nhưng đây là thay đổi allowlist nên phải có ADR riêng, không lồng vào S4.

### 2.4 Bảng mất nền hàng tiêu đề và sọc xen kẽ

Cùng nguyên nhân §2.1: ô bảng dùng `background:${bg}` shorthand.

⇒ Hàng tiêu đề, màu sọc xen kẽ, màu nền ô tuỳ chỉnh — **mất sạch**. Bảng render ra trắng trơn.

**Sửa ở emitter:** `background:` → `background-color:`.

## 3. Một hồi quy khả năng tiếp cận

`aria-label` trên link mạng xã hội **bị xoá** — `emailAttributes` chỉ cho `class`, `style`, `title` trên mọi thẻ.

Ở dạng hiện tại link có cả text lẫn `title` nên chưa mù hoàn toàn. Nhưng spec §2 yêu cầu *"mọi hành động chỉ có icon phải có tên tiếp cận được"*, nên **khối icon-only trong tương lai sẽ vi phạm**. `title` sống sót và là phương án thay thế dùng được.

⇒ Quy tắc cho S4: **không dựa vào `aria-label`; dùng `title` cộng text ẩn.**

## 4. Mất mát chấp nhận được — đúng thiết kế, không sửa

| Thuộc tính | Khối | Ghi chú |
|---|---|---|
| `box-shadow` | section, column | Nhiều hộp thư không hỗ trợ; bỏ là đúng |
| ~~`display`~~ | ~~button, image~~ | **Không còn mất** — ADR-040 cho phép |
| `background-image` | section, column (chế độ gradient) | `url(` bị chặn; gradient không phải email-safe |
| `letter-spacing`, `text-transform` | heading, text | Hỗ trợ kém trong email client |
| `opacity` | preheader | ADR-040 cố ý loại; emitter phải thôi phát (việc #7) |
| `font` (shorthand) | logo dạng chữ | Tách thành `font-size`/`font-weight`/`font-family` là sửa được ở emitter |

## 5. Việc phải làm, phân loại theo nơi sửa

| # | Việc | Sửa ở đâu | Trạng thái |
|---|---|---|---|
| 1 | `background:` → `background-color:` (nút, ô bảng) | Emitter | ✅ S2 Task 5 |
| 2 | Đường ngăn dùng hàng bảng thay `border-top` | Emitter | ✅ S2 Task 6 |
| 3 | `font` shorthand → tách thuộc tính (logo) | Emitter | ✅ S2 Task 5 |
| 4 | Không dùng `aria-label`; dùng `title` | Emitter | ✅ S2 Task 5 |
| 5 | Xếp chồng mobile fluid/hybrid thay `@media` | Emitter | ✅ S2 Task 6 |
| 6 | ~~Preheader: chọn A/B/C~~ | ADR-040 | ✅ Xong |
| 7 | Emitter thôi phát `opacity:0` ở preheader | Emitter | ✅ S2 Task 6 |

**Cả bảy đã xong ở S2** (2026-09-02), không dồn sang S4 — port một emitter đã biết là hỏng rồi sửa sau là làm hai lần và có nguy cơ bản hỏng bị dùng thật.

Từ nay các mục này **được canh tự động**, không còn dựa vào việc ai đó nhớ kiểm: `packages/architecture-tests/src/builder-block-sanitizer.test.ts` chạy từng khối qua sanitizer thật và fail nếu có khai báo nào biến mất ngoài danh sách loại trừ ở §4. Danh sách kind là mảng runtime (`KINDS` trong `document.ts`) mà union `Kind` suy ra từ đó, nên **thêm một khối mới mà quên mẫu sẽ đỏ**, không im lặng.

## 6. Điều tài liệu này chứng minh về quy trình

Con số 85% ở mức toàn tài liệu **trông như đã đạt**. Nhưng nút bấm mất nền, đường ngăn biến mất, preheader thôi ẩn và bảng mất màu — bốn khối hỏng chức năng — đều nằm gọn trong 15% còn lại.

⇒ **Chỉ số tổng ở mức tài liệu không thay được kiểm kê từng khối.** Bất kỳ khối mới nào ở S4 cũng phải chạy qua đúng bài kiểm này trước khi coi là xong.

Bài kiểm đó **giờ đã tự động** (S2 Task 8) — một bài kiểm bằng tay thì sẽ không ai chạy.
