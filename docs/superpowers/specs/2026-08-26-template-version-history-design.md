# Template Version History — Design

**Ngày:** 2026-08-26
**Liên quan:** `docs/superpowers/specs/2026-08-25-template-editor-base-design.md` (S0), brief Mailcraft §19

---

## 1. Vấn đề

Xuất bản template tạo ra một phiên bản bất biến, nhưng **không có cách nào xem lại chúng**. API chỉ có `GET /template-versions/{id}` — lấy một bản theo id, mà id đó không lấy được từ đâu ngoài `latestVersionId`. Không có endpoint liệt kê, không có khôi phục.

Hệ quả cho người dùng hôm nay: xuất bản xong là mất dấu. Sửa nhầm rồi xuất bản thì không quay lại được, dù dữ liệu vẫn nằm nguyên trong `email_template_version`.

Đây vừa là lỗ hổng của sản phẩm hiện tại, vừa là §19 trong brief Mailcraft. Hình dạng API không phụ thuộc vào thiết kế UI của họ, nên làm được ngay mà không cần chờ.

## 2. Quyết định

### 2.1 Khôi phục là ghi vào **bản nháp**, không đụng phiên bản

Phiên bản đã xuất bản bất biến tuyệt đối — `PATCH`/`DELETE` trên `/template-versions/{id}` trả `405`. "Khôi phục phiên bản 3" nghĩa là: chép `subject`/`html`/`textBody` của phiên bản 3 vào bản nháp hiện tại. Phiên bản 3 không đổi. Muốn nó thành bản đang gửi thì xuất bản lại, và điều đó tạo ra phiên bản mới mang số tiếp theo.

Hệ quả bắt buộc: **khôi phục ghi đè nội dung bản nháp đang có.** Nếu người dùng đang sửa dở, thao tác này xoá phần đang sửa. Phải có màn xác nhận nói thẳng điều đó, và phải đi qua `If-Match` như mọi lần ghi vào bản nháp — nếu không, khôi phục sẽ là cái cổng hậu duy nhất bỏ qua optimistic concurrency mà S0 vừa dựng.

### 2.2 Thêm `published_by` ngay bây giờ

`email_template_version` không lưu ai xuất bản. Thông tin đó chỉ có trong `audit_log`, vốn nằm trong diện retention nên sẽ bị cắt theo thời gian — không thể dựa vào để hiển thị lịch sử lâu dài.

Thêm cột `published_by uuid NULL`: điền từ lúc này trở đi, `NULL` cho các bản đã có. UI hiển thị "Không rõ" cho bản cũ. Thêm cột vào một bảng chỉ có thêm dòng theo thời gian thì càng để lâu càng đắt.

Nullable chứ không phải NOT NULL: không thể suy ngược tác giả cho dữ liệu cũ, và bịa ra một giá trị mặc định sẽ là nói dối trong đúng bảng mà cả hệ thống dựa vào để truy vết.

### 2.3 Danh sách không trả `html`

`GET /templates/{id}/versions` trả metadata: `id`, `version`, `subject`, `publishedAt`, `publishedBy`, `contentHash`. Không trả `html`/`textBody` — một template có thể tới 5 MB, nhân với số phiên bản thì danh sách sẽ khổng lồ. Muốn xem nội dung thì gọi `GET /template-versions/{id}` vốn đã có, hoặc `POST /template-versions/{id}/preview` để xem bản đã render.

Sắp xếp `version DESC` — mới nhất trước.

## 3. API

| Endpoint | Hành vi |
|---|---|
| `GET /templates/{templateId}/versions` | Liệt kê metadata phiên bản, mới nhất trước. Quyền `content:manage`. |
| `POST /templates/{templateId}/versions/{versionId}/restore` | Cần `If-Match` mang `draftRevision`. Chép nội dung phiên bản vào bản nháp, bump `draftRevision`, ghi audit log. Trả về template đã cập nhật. |

Mã lỗi của `restore` theo đúng khuôn `PATCH /templates/{id}` đã có: thiếu `If-Match` → `428`, sai dạng → `400`, lệch revision → `412`, phiên bản không thuộc template → `404`.

Template đã lưu trữ (`archived`) không khôi phục được — `requireActive` đã chặn sẵn.

## 4. Giao diện

Trong `TemplateEditorScreen`, thêm một overlay "Lịch sử phiên bản" mở từ nút ở topbar. Nội dung mỗi dòng: số phiên bản, thời điểm xuất bản, người xuất bản, tiêu đề tại thời điểm đó.

Hai hành động mỗi dòng: **Xem trước** (dùng `POST /template-versions/{id}/preview` sẵn có) và **Khôi phục**.

Khôi phục mở màn xác nhận nêu rõ: nội dung bản nháp hiện tại sẽ bị thay thế, phiên bản đã xuất bản không đổi. Sau khi khôi phục, đóng overlay và nạp lại bản nháp — `draftRevision` đã thay đổi phía server nên trạng thái autosave phải đồng bộ lại, đúng như bài học từ `publish` trong S0.

Trạng thái rỗng: template chưa xuất bản lần nào thì hiện lời nhắc xuất bản, không phải danh sách trống.

## 5. Ngoài phạm vi

So sánh khác biệt giữa hai phiên bản (diff) · đặt tên/gắn nhãn phiên bản · xoá phiên bản (không tồn tại theo thiết kế) · phân trang danh sách (một template hiếm khi có tới hàng trăm phiên bản; thêm khi có dữ liệu chứng minh cần).

## 6. Kiểm thử

- Migration `072` + hash trong `migrations.lock.json`, `ARCH-MIGRATION` xanh.
- API: danh sách sắp đúng thứ tự và không rò rỉ `html`; `publishedBy` được điền khi xuất bản; bốn nhánh `If-Match` của `restore`; khôi phục thật sự thay nội dung bản nháp và bump `draftRevision`; phiên bản của template khác trả `404`; cách ly tenant.
- Web: `pnpm check` xanh, và kiểm chứng thủ công trên ứng dụng chạy thật — xuất bản hai lần, khôi phục bản đầu, xác nhận nội dung bản nháp đổi còn hai phiên bản vẫn nguyên.
