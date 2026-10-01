# Template Editor Base (S0) — Design

**Ngày:** 2026-08-25
**Trạng thái:** đã được người dùng phê duyệt qua đối thoại thiết kế
**Liên quan:** ADR-019, FE-013 (`catalog/library-decisions.json`), `docs/frontend/mailcraft-design-direction.md`

---

## 1. Mục tiêu

Làm cho luồng soạn thảo template từ HTML import chạy chuẩn và ổn định, đồng thời dựng sẵn seam dữ liệu để hệ thống thứ hai (**Mailcraft**, đang được dựng prototype ở nơi khác) cắm vào sau mà không phải phá contract.

Hai kết quả phải đạt:

1. Người dùng có một trình soạn thảo template thật — route riêng, xem trước sống, kiểm lỗi tại chỗ, tự động lưu an toàn.
2. Mô hình dữ liệu và contract đã sẵn sàng cho template do builder dựng, dù builder chưa tồn tại.

## 2. Bối cảnh — hiện trạng được xác minh

| Điều | Bằng chứng |
|---|---|
| Trình soạn thảo trong composer là placeholder chết | `ComposeDraftScreen.tsx:368` — nút `</> HTML` để `disabled`, canvas in chuỗi tĩnh *"tích hợp ở các bước campaign tiếp theo"* |
| Campaign không có trường nội dung nào | `apps/web/src/api/campaigns.ts:25-36` — chỉ `templateId`/`templateVersionId` |
| Editor thật là một `<textarea>` trong modal | `TemplatesScreen.tsx` — 397 dòng chứa 5 overlay, trong đó có `TemplateActionsOverlay` |
| CSS toolbar soạn thảo đã tồn tại nhưng chưa từng được render | `globals.css` — `.editor-toolbar`, `.insert-variable`, `.code-editor` |
| `PATCH /templates/:id` không có optimistic concurrency | `templates.controller.ts:45`, `templates.service.ts:173` |
| Backend phân tích nội dung đã đầy đủ | `/templates/analyze` trả `variables`, `unknownVariables`, `catalogue`, `lint` |
| Handoff v2 đặt WYSIWYG trong composer | `design-reference/ui-handoff-v2/source/app/page.tsx:127-142` |

## 3. Quyết định đã chốt

### 3.1 Vai trò hai bề mặt — đây là một redesign so với handoff

Handoff v2 đặt trình soạn thảo WYSIWYG và tab HTML **trong composer**. Thiết kế này chuyển việc soạn nội dung về **template**, còn composer chỉ xem trước.

Lý do: `CampaignDraft` không có trường nội dung, nên composer về mặt dữ liệu không thể là editor. Muốn giữ đúng handoff thì phải thêm nội dung ad-hoc cho campaign — một thay đổi entity, migration, contract và quy tắc đóng băng khi gửi, nằm ngoài phạm vi này.

`design-reference/ui-source-contract.yaml` quy định `do_not_redesign_without_explicit_approval` và `record_irreducible_rule_ui_conflict_as_stop_gate`. **Người dùng đã phê duyệt thay đổi này trong phiên thiết kế ngày 2026-08-25.** Ghi nhận tại đây chính là bản ghi stop-gate đó.

Ngược lại, tab `Xem trước` trong panel phải của composer **khôi phục** đúng handoff (`page.tsx:135`), vốn đã bị rơi mất trong bản production hiện tại.

### 3.2 Hai nguồn gốc template

| `origin` | Tạo bằng | Sửa bằng | Nguồn sự thật |
|---|---|---|---|
| `imported` | Import HTML / dán code | Code editor (bản này) | HTML canonical |
| `builder` | Mailcraft | Mailcraft | `project_data` → **sinh ra** HTML canonical |

**Bất biến (ADR-019):** HTML canonical là bản ghi duy nhất được dùng để gửi email. `project_data` không bao giờ tham gia vào việc render email gửi đi. EOW chỉ giữ hộ, không đọc.

Chuyển `imported` → `builder` là cửa một chiều và lossy, chỉ thực hiện khi người dùng chủ động xác nhận. **Không nằm trong phạm vi bản này** — chỉ cột dữ liệu được chuẩn bị.

### 3.3 `If-Match` bắt buộc, không có giai đoạn tương thích ngược

Người dùng đã chọn dứt điểm. Web là client duy nhất và được sửa cùng lúc.

### 3.4 Chế độ visual không sửa trực tiếp HTML import

Tab `Trình soạn thảo` là xem trước sống, không phải contenteditable. HTML của designer không bị bất kỳ thứ gì viết lại. Mọi chỉnh sửa diễn ra ở tab HTML.

---

## 4. Kiến trúc — Backend

### 4.1 Migration `071_template_origin_and_draft_revision.sql`

```sql
ALTER TABLE email_template
  ADD COLUMN origin text NOT NULL DEFAULT 'imported',
  ADD COLUMN project_data jsonb NULL,
  ADD COLUMN draft_revision integer NOT NULL DEFAULT 1;

ALTER TABLE email_template
  ADD CONSTRAINT email_template_origin_check CHECK (origin IN ('imported', 'builder'));
```

Cập nhật `database/migrations.lock.json` với hash của tệp mới.

**Tên cột `draft_revision`, không phải `version`.** Trong module templates, `version` **đã có nghĩa khác**: `EmailTemplateVersionEntity.version` là số thứ tự bản đã xuất bản (`templates.service.ts:220,250`). Dùng lại tên đó cho optimistic concurrency sẽ tạo ra hai khái niệm cùng tên trong cùng một module. `campaign` không gặp vấn đề này vì nó không có khái niệm bản xuất bản.

### 4.2 Entity

`apps/api/src/database/entities/email-template.entity.ts` — thêm ba trường tương ứng: `origin: EmailTemplateOrigin`, `projectData: Record<string, unknown> | null`, `draftRevision: number`.

### 4.3 Optimistic concurrency

`PATCH /templates/:id` nhận header `If-Match`, theo **đúng khuôn** `campaigns.controller.ts:24-27`:

| Trường hợp | Kết quả |
|---|---|
| Thiếu header | `428 Precondition Required` |
| Sai định dạng (không phải `"?\d+"?`) | `400 Bad Request` |
| Lệch `draft_revision` | `412 Precondition Failed` |
| Khớp | Ghi, `draft_revision += 1`, trả `ETag` mới |

`draftRevision` xuất hiện trong body phản hồi và trong header `ETag`. Web đọc từ body — như ghi chú sẵn có ở `campaigns.ts:69`, đọc ETag trong trình duyệt là không cần thiết.

Điểm cần cẩn thận trong `templates.service.ts:173`: hàm `update` hiện nhận `body` rồi ghi thẳng. Việc kiểm tra `draft_revision` phải nằm **trong cùng transaction** với thao tác ghi, không kiểm trước rồi ghi sau.

`publish` cũng ghi vào bản nháp (`templates.service.ts:219+`) nên phải bump `draft_revision` — nếu không, autosave ngay sau khi xuất bản sẽ báo xung đột giả.

### 4.4 Contract

`contracts/openapi.yaml`:

- `/templates/{templateId}` — thêm tham số header `If-Match` (bắt buộc), phản hồi `412` và `428`.
- Schema template — thêm `origin` và `draftRevision`.

`project_data` **chỉ tồn tại ở tầng cơ sở dữ liệu, không xuất hiện trong contract ở bản này.** Lý do nhất quán với §5.6: bản này không đọc cũng không ghi nó, và thêm một trường vào phản hồi sau này là thay đổi cộng thêm, không phá contract. Cột thì ngược lại — thêm cột sau nghĩa là migration trên bảng đã có dữ liệu, nên cột được chuẩn bị ngay còn phần lộ ra API thì chờ Mailcraft.

Chạy `pnpm contracts:compat-check`. Đây là breaking change có chủ đích; báo cáo phải nêu đúng nó và không được có thay đổi ngoài dự kiến nào khác.

---

## 5. Kiến trúc — Frontend

### 5.1 Route mới

`apps/web/src/app/AppRoutes.tsx` — thêm `/templates/:templateId/edit` bên trong layout đã được bảo vệ, cùng nhóm với các route hiện có.

`apps/web/src/app/page-meta.ts` — thêm mẫu `[/^\/templates\/[^/]+\/edit$/, TEMPLATE_EDITOR]`. Tệp này **đã** khớp theo mẫu chứ không theo pathname chính xác (được sửa trong đợt restructure Chiến dịch), nên route có đoạn động sẽ có tiêu đề thật thay vì `<h1>` rỗng.

`isComposeRoute` trong `page-meta.ts` quyết định AppShell có hiện chỉ báo tự động lưu hay không. Route editor mới cũng cần chỉ báo đó → đổi tên thành `isAutosaveRoute` và cho khớp cả hai họ route. Đây là đổi tên có ý nghĩa, không phải đổi cho đẹp: hàm này không còn nói riêng về composer nữa.

### 5.2 Tách màn hình

**Tạo:** `apps/web/src/screens/templates/TemplateEditorScreen.tsx` — nhận `templateId` từ route, tải template, dựng bề mặt soạn thảo.

**Sửa:** `TemplatesScreen.tsx` — bỏ `TemplateActionsOverlay`, hành động "Chỉnh sửa template" chuyển thành điều hướng tới route mới. Bốn overlay còn lại (import, preview, sendTest, archive) giữ nguyên tại chỗ.

Đây là dọn dẹp đúng chỗ đang sửa: một tệp 397 dòng chứa 5 overlay là quá tải, và overlay bị gỡ chính là cái đang được thay thế.

### 5.3 Bề mặt soạn thảo

Hai tab dùng lại đúng lớp CSS `.view-switch` đã có sẵn:

**`Trình soạn thảo`** — xem trước sống trong `<iframe>`:
- Render kết quả từ `PreviewService` với người nhận mẫu, có chuyển desktop/mobile.
- Hiển thị `missingKeys` khi dữ liệu mẫu không đủ.
- Bấm vào một khối trong xem trước → chuyển sang tab HTML và đưa con trỏ tới đúng vị trí nguồn.
- **Không** chỉnh sửa trực tiếp.

**`</> HTML`** — CodeMirror 6:
- Highlight HTML, tô riêng token `{{bien}}`.
- Gạch chân cảnh báo lint đúng dòng/cột từ `/templates/analyze`.
- Chèn biến tại vị trí con trỏ.
- Nạp bằng `import()` động. `ARCH-NO-ORPHANS` có đi theo dynamic import (`structure.test.ts:57`) nên module vẫn được coi là reachable, và CodeMirror không vào bundle chính.

Panel biến bên phải giữ nguyên hành vi hiện có: bốn nhóm scope, ô tìm kiếm, tạo/sửa/xóa biến riêng của template. Phần này đang chạy đúng, không có lý do dựng lại.

### 5.4 Ánh xạ vị trí lint → dòng/cột

`/templates/analyze` trả `start`/`end` theo **offset ký tự**. CodeMirror cần vị trí trong tài liệu của nó. Đây là một hàm thuần, tách riêng và test riêng:

`apps/web/src/screens/templates/lint-positions.ts` — chuyển offset thành khoảng đánh dấu, xử lý đúng các trường hợp biên: offset vượt độ dài (nội dung đã đổi kể từ lần phân tích trước), khoảng rỗng, khoảng chồng nhau.

### 5.5 Tự động lưu

`autosaveReducer` của composer đã giải đúng bài toán: tối đa một request in-flight, sửa tiếp thì xếp hàng chờ, `409` → trạng thái `conflict` kèm màn so sánh. Nhưng nó đang buộc cứng vào `CampaignDraft`/`CampaignPatch`.

**Tổng quát hóa thành `autosaveReducer<TDraft, TPatch>`**, đặt tại `apps/web/src/api/autosave-reducer.ts`, dùng chung cho composer và template editor.

Điều kiện an toàn: `apps/web/src/screens/compose/autosave-reducer.test.ts` phải xanh **không sửa một dòng nào** ngoài đường dẫn import. Nếu phải sửa nội dung test, việc tổng quát hóa đã làm đổi hành vi và phải dừng lại xem xét.

### 5.6 Cổng tích hợp

Chỉ định nghĩa bốn cổng mà bản này **thực sự dùng**, để chúng được kiểm chứng bằng người dùng thật thay vì thiết kế trên giấy. Đặt tại `apps/web/src/screens/templates/editor-ports.ts`, với bản cài đặt thật nối vào `apps/web/src/api/templates.ts`:

`VariableProvider` · `PreviewService` · `LintService` · `ContentStore`

Chưa tách thành package riêng ở bản này: `apps/web` là bên tiêu thụ duy nhất, và hình thái đóng gói cuối cùng phụ thuộc vào việc Mailcraft sẽ tích hợp theo cách nào — điều còn chưa chốt.

`AssetProvider` và `BlockLibrary` **không** được dựng trước. Khi Mailcraft chốt xong hình dung về quản lý ảnh và thư viện khối, ta dựng theo đúng hình dung đó.

### 5.7 Composer — gỡ placeholder

`ComposeDraftScreen.tsx:368` — khối `.editor-shell` (switch inert + canvas chữ tĩnh) được thay bằng tab `Xem trước` trong `.panel-switch` bên phải, dùng chính `PreviewService`.

Composer vẫn **không** sửa nội dung. Nội dung thuộc về template.

---

## 6. Luồng dữ liệu

**Mở editor:** route → `GET /templates/:id` → dựng trạng thái autosave với `draftRevision` làm mốc → `POST /templates/analyze` (debounce) → danh mục biến + lint.

**Gõ phím:** cập nhật trạng thái cục bộ → debounce → `PATCH` kèm `If-Match: draftRevision` → phản hồi mang `draftRevision` mới → cập nhật mốc. Tối đa một request in-flight; chỉnh sửa trong lúc chờ được xếp hàng.

**Xung đột:** `409` → trạng thái `conflict` → tải bản máy chủ → hiện so sánh → người dùng chọn giữ bản của mình hoặc lấy bản máy chủ. Không bao giờ ghi đè âm thầm.

**Xuất bản:** phân tích lại → nếu còn `unknownVariables` thì chặn kèm danh sách biến cần tạo → `PATCH` → `POST /templates/:id/publish` → tạo bản bất biến.

## 7. Xử lý lỗi

`template-errors.ts` đã có bản dịch tiếng Việt cho bộ mã hiện hành. Thêm:

| Tình huống | Xử lý |
|---|---|
| `412` lệch `draft_revision` | Màn so sánh cục bộ ↔ máy chủ, người dùng quyết định |
| `428` thiếu `If-Match` | Lỗi lập trình, không phải lỗi người dùng — thông báo tải lại trang |
| `400` sai định dạng `If-Match` | Như trên |
| Phân tích thất bại giữa lúc gõ | Giữ nguyên kết quả lint gần nhất kèm dấu hiệu đã cũ; **không** xóa trắng cảnh báo |
| CodeMirror nạp thất bại | Hạ cấp về `<textarea>` trần, vẫn sửa và lưu được |

Trường hợp cuối là bắt buộc: một dependency nạp động thất bại không được phép biến màn hình soạn thảo thành màn hình trắng.

## 8. Kiểm thử

**Unit thuần (Vitest):**
- `autosaveReducer` sau khi tổng quát hóa — test cũ của composer chạy không sửa.
- `lint-positions.ts` — offset → dòng/cột, gồm các trường hợp biên.
- Chèn biến tại caret — `insertTemplateVariable` đã có test, mở rộng cho ngữ cảnh CodeMirror.
- Phân nhánh theo `origin`.

**API:**
- Bốn nhánh `If-Match`: thiếu → `428`, sai dạng → `400`, lệch → `412`, khớp → `200` và `draft_revision` tăng đúng 1.
- `publish` bump `draft_revision`, autosave ngay sau đó không báo xung đột giả.
- Mặc định `origin = 'imported'` cho template đã tồn tại trước migration.

**Contract:** `pnpm contracts:compat-check` — báo cáo nêu đúng breaking change đã dự kiến, không có thay đổi ngoài dự kiến.

**Kiến trúc:** `ARCH-NO-ORPHANS` và `ARCH-WEB-STRUCTURE` sau khi thêm tệp mới.

**E2E:** repo **chưa có** spec e2e riêng cho templates. `visual-capture.spec.ts:561-598` chụp màn hình `/templates` (chỉ trạng thái loading và empty), `rbac.spec.ts` có tham chiếu templates — cả hai phải kiểm lại sau khi đổi route. Bổ sung ảnh chụp cho route editor mới ở ba khổ màn hình.

**Thủ công:** chạy thật trên trình duyệt ở 1440×900, 768×1024, 390×844 theo `design-reference/visual-acceptance.md`, phủ đủ sáu trạng thái bắt buộc gồm `permission_denied`.

**Lệnh kiểm chứng:** `pnpm check` (typecheck + build + test). Không dùng `pnpm test` trần — hai test khởi động của API sẽ hỏng nếu chưa build.

## 9. Cấu trúc tệp

**Tạo:**
- `database/migrations/071_template_origin_and_draft_revision.sql`
- `apps/web/src/screens/templates/TemplateEditorScreen.tsx`
- `apps/web/src/screens/templates/lint-positions.ts` + test
- `apps/web/src/screens/templates/template-code-editor.tsx` — bọc CodeMirror, nạp động
- `apps/web/src/api/autosave-reducer.ts` — bản tổng quát hóa

**Sửa:**
- `apps/api/src/database/entities/email-template.entity.ts`
- `apps/api/src/templates/templates.controller.ts` — `If-Match` cho `PATCH`
- `apps/api/src/templates/templates.service.ts` — kiểm và bump `draft_revision` trong transaction; `publish` cũng bump
- `apps/api/src/templates/dto/` — schema cập nhật
- `contracts/openapi.yaml`
- `database/migrations.lock.json`
- `apps/web/src/app/AppRoutes.tsx`, `page-meta.ts` (+ đổi tên `isComposeRoute` → `isAutosaveRoute`), `AppShell.tsx`
- `apps/web/src/api/templates.ts` — `If-Match`, `origin`, `draftRevision`
- `apps/web/src/screens/templates/TemplatesScreen.tsx` — gỡ `TemplateActionsOverlay`, điều hướng sang route
- `apps/web/src/screens/compose/ComposeDraftScreen.tsx` — gỡ `.editor-shell`, thêm tab xem trước
- `apps/web/src/screens/compose/autosave-reducer.ts` → tái xuất từ bản tổng quát hóa
- `apps/web/package.json` — CodeMirror 6

**Xóa:** không xóa tệp nào. CSS `.editor-toolbar` / `.code-editor` trong `globals.css` chuyển từ trạng thái chết sang được dùng thật.

## 10. Ngoài phạm vi

Builder / WYSIWYG · assets API · reusable blocks · liệt kê và khôi phục version · chuyển `imported` → `builder` · nội dung ad-hoc cho campaign.

**Mở rộng sanitizer** (`border-radius`, `@media`, `id`) — chờ phản hồi từ đội Mailcraft, xem `docs/frontend/mailcraft-design-direction.md` §5.2. Quyết định này không chặn bản S0.

## 11. Rủi ro

| Rủi ro | Giảm thiểu |
|---|---|
| Tổng quát hóa reducer làm đổi hành vi composer | Test composer phải xanh không sửa; nếu phải sửa thì dừng xem xét |
| `If-Match` bắt buộc phá client cũ | Web là client duy nhất, sửa cùng lúc; contract check bắt được |
| Kích thước bundle CodeMirror | Nạp động, đo lại sau khi build |
| `publish` quên bump revision → xung đột giả | Có test riêng cho đúng tình huống này |
| Ánh xạ offset lệch khi nội dung đổi giữa hai lần phân tích | Hàm thuần có test biên; lint cũ được đánh dấu là cũ thay vì hiện sai vị trí |
