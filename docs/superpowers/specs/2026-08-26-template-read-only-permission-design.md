# Template `permission_denied` chỉ đọc & tách quyền `content:read` — Design

**Ngày:** 2026-08-26
**Liên quan:** `docs/frontend/mailcraft-integration-requirements.md` §5.1, `design-reference/ui-source-contract.yaml` → `required_states`, BR-AUTH-003/004

---

## 1. Vấn đề

§5.1 yêu cầu: người **không có** `content:manage` phải thấy editor template ở **chế độ chỉ đọc có giải thích** — "không phải màn hình trắng hay lỗi 403 thô".

Trạng thái đó **không thể dựng được** trước thay đổi này, vì hai lý do độc lập:

1. `AppRoutes.tsx` bọc `/templates/:templateId/edit` trong `RequirePermission('content:manage')`, nên người thiếu quyền không bao giờ tới được màn hình — họ nhận `PermissionDeniedScreen` ở tầng route.
2. Quan trọng hơn: **mọi** route template, kể cả route đọc, đều đòi `content:manage` (`GET /templates`, `GET /templates/:id`, `GET /templates/:id/versions`, `GET /template-versions/:id`, `GET /templates/:templateId/variables`). Người thiếu quyền nhận `403` ngay ở bước tải, nên **không có nội dung nào để hiển thị chỉ đọc**.

Nói cách khác: `content:manage` đang gánh cả quyền đọc lẫn quyền ghi, trong khi §5.1 mô tả nó là quyền **sửa** ("quyết định ai được sửa nội dung"). Khoảng cách đó là gốc của vấn đề, không phải thiếu một nhánh `if` trong component.

## 2. Quyết định

### 2.1 Tách `content:read` khỏi `content:manage`

`073_content_read_permission.sql` thêm `content:read` và cấp cho **cả ba vai trò** (admin, operator, viewer). Mọi route template *không thay đổi dữ liệu* nhận `content:read` **hoặc** `content:manage`; mọi route *ghi* vẫn chỉ nhận `content:manage`.

Decorator `@RequirePermission(...)` vốn đã OR nhiều khoá, và `PermissionGuard` không cần sửa — đây là dùng đúng cơ chế sẵn có, không phải cơ chế mới.

Danh sách route được nới (8): `GET /templates`, `GET /templates/:id`, `GET /templates/:id/versions`, `GET /template-versions/:id`, `GET /templates/:templateId/variables`, `POST /templates/analyze`, `POST /templates/:id/preview`, `POST /template-versions/:id/preview`. Ba route `POST` cuối là đọc trá hình — chúng nhận body nên phải là `POST`, nhưng không ghi gì.

### 2.2 Viewer nhìn thấy mục "Email template" trên sidebar

Đây là **mở rộng có chủ ý** so với câu chữ của BR-AUTH-003 ("Viewer chỉ xem lịch sử và báo cáo"). Lý do: nếu giấu điểm đến thì trạng thái chỉ đọc mà §5.1 yêu cầu trở thành không thể tới được, và cả thay đổi này thành vô nghĩa. Chính tài liệu tích hợp cũng ghi ở đầu rằng các ràng buộc §1 "có thể mở".

Hệ quả: `nav.ts` và `routePermissions['/templates']` chuyển sang `content:read`; assertion sidebar của viewer trong `e2e/rbac.spec.ts` được cập nhật theo.

### 2.3 Quyền được kiểm **trong** màn hình, không phải ở route

Route chỉ cần `content:read`. Việc thiếu `content:manage` được xử lý bên trong `TemplateEditorScreen` — nếu chặn ở route thì kết quả lại là màn hình trắng, đúng thứ §5.1 loại trừ.

`templateContentIsReadOnly(permissions)` sống trong `template-editor.ts` cùng các helper thuần khác, nên test được bằng suite unit hiện có (web không có test render component).

### 2.4 Chỉ đọc nghĩa là gì

Nội dung **hiện đầy đủ**: tên, tiêu đề, HTML, văn bản thuần, preview, lint, danh mục biến, lịch sử phiên bản. Bị vô hiệu hoá: autosave (chặn tại `change()` — một chốt duy nhất mà mọi đường sửa đều đi qua), xuất bản, lưu trữ, khôi phục phiên bản, tạo/sửa/xoá biến, chèn biến, import, gửi thử.

`TemplateCodeView` dùng prop `disabled` **sẵn có** (`EditorView.editable.of(false)`), không thêm nhánh thứ hai.

Chỉ báo lưu ở shell chuyển về `idle` ("Đã đồng bộ"); giữ nguyên "Đã tự động lưu" sẽ hứa một hành vi mà chế độ này không bao giờ thực hiện.

### 2.5 `403` khi tải khác `404`/lỗi mạng

`403` ở bước tải nghĩa là quyền vừa bị đổi phía máy chủ trong khi `GET /auth/me` đã cache vẫn cho qua route guard. Thử lại là vô ích, nên nhánh này có copy về quyền và **không có** nút "Thử lại". Mọi lỗi khác giữ nguyên thẻ lỗi cũ kèm nút thử lại.

### 2.6 Màn thư viện cũng chỉ đọc

`TemplatesScreen` giờ viewer tới được, nên Import HTML, drop zone, "Lưu trữ template" và "Gửi thử email này" bị ẩn khi thiếu `content:manage` — nếu không sẽ là một màn hình đầy nút chỉ dẫn tới `403`.

## 3. Ranh giới thật vẫn ở máy chủ

Toàn bộ mục 2.4 và 2.6 là **trình bày**. `PermissionGuard` kiểm độc lập, đúng BR-AUTH-004 ("API kiểm quyền phía server, không dựa vào việc ẩn nút trên UI"). Bật lại một nút trong devtools chỉ nhận `403`. Ma trận `rbac-matrix.test.ts` và `e2e/rbac.spec.ts` đều có case chứng minh điều đó cho template.

## 4. Không làm

- Không đụng `GET /global-variables` (vẫn `content:manage`): biến dùng chung là cấu hình cấp hệ thống, không phải nội dung của một template.
- Không thêm vai trò mới. Không thêm khoá quyền nào ngoài `content:read`.
- Không đổi `contracts/openapi.yaml`: `Me.permissions` là `array<string>` không enum, và spec không ghi khoá quyền cho từng route template.
