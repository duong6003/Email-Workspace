# Template Editor Layout & Library Thumbnails — Design

**Ngày:** 2026-08-26
**Trạng thái:** đã được người dùng phê duyệt qua đối thoại thiết kế
**Liên quan:** `2026-08-25-template-editor-base-design.md` (S0), `2026-08-26-template-version-history-design.md`, `docs/frontend/mailcraft-design-direction.md` §5.5

---

## 1. Vấn đề

Hai vấn đề tách biệt, cùng nằm trên bề mặt template.

### 1.1 Bố cục editor hỏng — preview không hiển thị

S0 dời trình soạn thảo từ modal sang route riêng nhưng CSS đi kèm không được dời theo. Hệ quả đo được trên ứng dụng chạy thật (`/templates/:id/edit`, tenant dev, 2026-08-26):

| Viewport | `.editor-shell` | Phần preview nhìn thấy | Textarea văn bản thuần |
|---|---|---|---|
| 1440×900 | **77px** | **0px** | 360px |
| 768×1024 | **2px** | **0px** | 280px |
| 390×844 | 748px | 520px | 280px |

Ở 1440×900, khung `.editor-shell` cao 77px trong khi nội dung của nó cao 712px, và `overflow:hidden`. Iframe preview nằm ở `top:510 → bottom:1030`, hoàn toàn bên dưới đáy khung (`418`). Phần iframe lọt vào vùng nhìn thấy là **0px** — preview không bị cắt bớt mà bị cắt sạch. Phần tử chiếm đúng toạ độ đó trên màn hình là `TEXTAREA` của trường văn bản thuần.

Tab HTML cùng nguyên nhân: CodeMirror cao **29px**, chưa đầy một dòng.

Khổ duy nhất preview render đúng là 390×844 — nơi không ai dựng email.

### 1.2 Thư viện template không phân biệt được bằng mắt

`.template-preview` trong `TemplatesScreen.tsx` là một hình vẽ trang trí cứng: nhãn `HTML TEMPLATE`, chip `EMAIL`, và hai thẻ `<i>` rỗng giả làm dòng chữ. Đo trên app: sau khi bỏ `<h3>` tên và `<p>` tiêu đề, markup của mọi card **giống nhau từng byte** (`shellsIdentical: 1`), không có `iframe` cũng không có `img`.

Người dùng nhận diện template chỉ bằng cách đọc chữ, không bằng nhìn — trái với chính mục đích của một thư viện dạng lưới.

## 2. Nguyên nhân gốc của 1.1

Hai quy tắc ở `apps/web/src/app/globals.css:306` được viết cho editor **trong modal** (`.action-overlay.modal-workspace`, chiều cao xác định `min(900px, 100vh-24px)`).

**a. `height:100%` + flex column ⇒ con bị bóp, không phải cột cuộn**

```css
.template-editor-workspace{height:100%; ...}
.template-editor-fields{display:flex; flex-direction:column; overflow-y:auto; ...}
```

Trong route, `.email-workspace-body` cấp chiều cao xác định (656px ở 1440×900). Flex column có chiều cao xác định thì con **co lại** (`flex-shrink:1` mặc định) chứ không tràn ra để cột cuộn. Ý đồ "cột tự cuộn" không bao giờ xảy ra — đo được `scrollHeight === clientHeight === 656`.

**b. `:first-of-type` đổi nghĩa khi HTML editor thành CodeMirror**

```css
.template-code-field textarea{min-height:180px}
.template-code-field:first-of-type textarea{min-height:360px}
```

Trước S0 có **hai** `.template-code-field`: HTML (first-of-type → 360px) và văn bản thuần (180px). S0 chuyển HTML sang CodeMirror bên trong `.editor-shell`, nên chỉ còn **một** label — và nó là `<label>` đầu tiên của cha, nên trúng rule 360px.

**Kết hợp a + b:** trong cuộc co kéo flex, textarea có `min-height:360px` nên không co được; `.editor-shell` không có `min-height` nên co hết cỡ. Trường phụ thắng, bề mặt soạn thảo chính thua. `rows={6}` trong JSX bị CSS ghi đè hoàn toàn.

**Bốn vấn đề kèm theo:**

- **5 tầng cuộn lồng nhau** quanh preview: `mail-preview-stage` → `template-editor-fields` → `email-workspace-body` → `workspace`, cộng cuộn nội bộ của iframe.
- **iframe cao cứng `520px` inline**, không theo `device` cũng không theo viewport; `borderRadius`/`boxShadow` inline nằm ngoài hệ token.
- **CSS chết**: toàn bộ `.mail-preview-stage article{...}` (kể cả `.mobile article{max-width:360px}` và các rule dark mode) vô tác dụng vì preview nay là `<iframe>`, không phải `<article>`. Device switch mobile đang phải dựa vào `width:390` inline.
- **`<label>` không có control**: "Người nhận mẫu" bọc một `<b>`, không có input nào.

## 3. Ràng buộc dẫn đường

`ARCH-HANDOFF` cấm sửa bất kỳ dòng đã duyệt nào của `apps/web/src/app/globals.css`. Thêm rule mới thì được; nối thêm selector vào rule có sẵn thì không.

⇒ **Không sửa hai rule ở dòng 306.** Thay vào đó đổi class trong JSX để rule cũ thôi khớp, rồi viết block mới. Điều này cũng trung thực về ngữ nghĩa: editor định tuyến là một bề mặt khác với modal mà nó sinh ra, nên nó xứng đáng có tên lớp riêng.

## 4. Quyết định — Phần 1: bố cục editor

### 4.1 Văn bản thuần trở thành tab thứ ba

Ba tab ngang hàng trong `.view-switch`: `Trình soạn thảo` · `</> HTML` · `Văn bản thuần`.

Mỗi lúc chỉ một bề mặt tồn tại, chiếm toàn bộ chiều cao khung. Hết tranh chỗ, hết bóp. Đồng thời đúng tinh thần §5.5 tài liệu Mailcraft: bản text là công dân thật, không phải phụ lục bị nhét xuống chân trang.

**Rủi ro:** ẩn sau tab thì người dùng dễ quên bản text. **Giảm thiểu:** hiện huy hiệu cảnh báo trên nhãn tab khi lint trả `TEXT_BODY_EMPTY` — mã này đã có sẵn trong `/templates/analyze`, không cần thêm gì ở backend.

### 4.2 Đổi tên lớp

| Hiện tại | Mới | Lý do |
|---|---|---|
| `.template-code-field` (trên màn này) | `.template-text-panel` | Rule `:first-of-type{min-height:360px}` **không còn khớp gì cả**, thay vì bị đè |
| `.editor-shell` | `.editor-shell.template-editor-surface` | Giữ border/radius đang đúng, thêm lớp thứ hai để viết rule mới trong block riêng |

### 4.3 Grid thay cho flex

```
.template-editor-fields   grid-template-rows: auto minmax(0,1fr) auto
├─ .modal-form-grid                       tên + tiêu đề        (auto, cố định trên)
├─ .editor-shell.template-editor-surface  (minmax(0,1fr), min-height:0)
│   ├─ .view-switch  [Trình soạn thảo] [</> HTML] [Văn bản thuần]
│   └─ panel đang chọn — chiếm toàn bộ chiều cao còn lại
└─ diagnostics / lint / conflict / error  (auto, cố định dưới)
```

`minmax(0,1fr)` là mấu chốt: khung soạn thảo được phép co xuống 0 **nhưng nhận toàn bộ phần dư**, thay vì bị các anh em có `min-height` cứng bóp chết.

`.template-editor-fields` bỏ `overflow-y:auto`. Cột không còn tự cuộn — **panel đang mở sở hữu vùng cuộn duy nhất**, giảm từ 5 tầng cuộn xuống 1.

**Hàng dưới phải bị chặn trần.** Đây chính là cái bẫy vừa gây ra §1.1: một hàng `auto` không giới hạn sẽ lại bóp hàng `1fr`. Khối xung đột (`.compose-conflict`) có thể cao tuỳ số trường đang sửa, nên hàng dưới nhận `max-height: 38%` kèm `overflow-y:auto` của riêng nó. Diagnostics và lint ngắn nên không bao giờ chạm trần; chỉ khối xung đột mới cuộn, và khi nó xuất hiện thì nó đúng là thứ người dùng cần đọc.

### 4.4 Ba panel

- **Trình soạn thảo** — `.mail-preview-stage` thành vùng cuộn duy nhất (`min-height:0; overflow:auto`); iframe bỏ `height:520px` inline, dùng `height:100%`. `borderRadius`/`boxShadow` inline chuyển sang CSS theo token.
- **`</>` HTML** — CodeMirror `height:100%`.
- **Văn bản thuần** — textarea `height:100%`; bỏ `rows={6}` vì CSS đã ghi đè nó, giữ lại chỉ gây hiểu nhầm cho người đọc code sau này.

### 4.5 Dọn kèm

- Device switch mobile: từ `width:390` inline sang rule `.template-editor-surface .mail-preview-stage.mobile iframe`.
- `<label>` "Người nhận mẫu" → `<div>`, vì không có control để trỏ tới.
- Canvas email giữ nền sáng trong dark mode (đã đúng nhờ `background:#fff` trên iframe) — giữ nguyên khi chuyển sang CSS.

## 5. Quyết định — Phần 2: thumbnail thư viện

### 5.1 Projection nhẹ cho `GET /templates`

Bỏ **đúng hai trường** `html` và `textBody` khỏi phản hồi danh sách. Mọi trường còn lại giữ nguyên, kể cả `validation` (nhỏ, và `TemplatePickerOverlay` có thể cần tới sau).

Kiểu ở web tách đôi: `EmailTemplateSummary` (danh sách) và `EmailTemplate` (chi tiết, giữ nguyên hình dạng hiện tại). `listTemplates` trả `EmailTemplateSummary[]`; typecheck sẽ chỉ ra ngay bất kỳ nơi nào lỡ đọc `html` từ danh sách.

**Đã xác minh không phá client nào.** Ba nơi gọi `listTemplates` chỉ đọc `name`/`subject`/`status`/`updatedAt`:

| Nơi gọi | Dùng gì |
|---|---|
| `TemplatesScreen.tsx:214` | tên, tiêu đề, trạng thái, ngày cập nhật |
| `TemplatePickerOverlay.tsx:25` | tên để chọn |
| `ComposeDraftScreen.tsx:347,470` | tên |

Các chỗ `.html` trong `TemplatesScreen` là state cục bộ của overlay import; dòng 160 dùng `result.html` từ endpoint preview, không phải từ danh sách.

Lý do làm ngay thay vì để lại: cả ba nơi gọi đều dùng `limit: 100`, và trần HTML là 5 MB/template. Đây đã là rủi ro sẵn có, và thumbnail sẽ biến nó thành thứ chịu tải. Cùng lập luận với §2.3 của thiết kế version history.

Đây là breaking change có chủ đích. `pnpm contracts:compat-check` phát hiện được (nó kiểm required property bị gỡ); báo cáo phải nêu đúng nó và không có thay đổi ngoài dự kiến nào khác.

### 5.2 Thumbnail sống bằng iframe thu nhỏ

`.template-preview` thay mockup cứng bằng `<iframe sandbox="" srcDoc>` render HTML thật ở bề rộng cố định **640px** rồi `transform:scale()` + `transform-origin:top left` thu vào khung card. 640px là bề rộng email phổ biến nhất, và cố định nó khiến mọi thumbnail cùng tỉ lệ — hai template cạnh nhau so sánh được.

Dùng lại đúng khuôn bảo mật đã ship trong editor: `sandbox=""` không cấp lại quyền gì (không script, không same-origin, không form, không điều hướng top-level), và HTML đã qua sanitizer lúc lưu.

**Nguồn dữ liệu:** vì `html` không còn trong danh sách, mỗi card **tự nạp `GET /templates/:id` khi lọt vào tầm nhìn** qua `IntersectionObserver`, có cache theo id. Cách này tự giới hạn ở số card đang thấy và không cần thêm endpoint hay trường mới.

**Không gọi endpoint preview.** Gọi preview cho N template là quá nặng cho một trang danh sách; đổi lại biến `{{ten_bien}}` hiện nguyên văn trên thumbnail. Với mục đích nhận diện thì chấp nhận được, và ghi rõ ở đây để không ai coi đó là lỗi.

### 5.3 Chốt chặn

Hạ xuống poster nhẹ khi:

| Điều kiện | Ngưỡng |
|---|---|
| HTML quá lớn | **512 KB** — dùng lại đúng ngưỡng `HTML_SIZE_LARGE` của `template-content-lint.ts`, không bịa hằng số mới |
| Nạp `GET /templates/:id` lỗi hoặc quá hạn | **5 giây** |
| `IntersectionObserver` không khả dụng | ngay lập tức, mọi card |

Poster giữ đúng mockup hiện tại — nó là fallback tử tế, không vứt đi.

## 6. Cấu trúc tệp

**Sửa:**
- `apps/web/src/screens/templates/TemplateEditorScreen.tsx` — tab thứ ba, đổi lớp, gỡ style inline của iframe, `<label>` → `<div>`
- `apps/web/src/screens/templates/TemplatesScreen.tsx` — thay mockup bằng thumbnail
- `apps/web/src/app/globals.css` — **chỉ thêm block mới**, không sửa dòng đã duyệt
- `apps/web/src/api/templates.ts` — thêm `EmailTemplateSummary`, đổi kiểu trả của `listTemplates`
- `apps/api/src/templates/templates.service.ts` + `dto/` — projection danh sách
- `contracts/openapi.yaml` — schema phản hồi danh sách

**Tạo:**
- `apps/web/src/screens/templates/TemplateThumbnail.tsx` — mount lười + fallback poster
- `apps/web/src/screens/templates/template-thumbnail.ts` + test — hàm thuần quyết định `thumbnail | poster` theo kích thước HTML, trạng thái nạp và khả dụng của observer. Tách khỏi component để test không cần DOM.

## 7. Kiểm thử

**Unit (Vitest):** nhánh chọn tab và huy hiệu `TEXT_BODY_EMPTY` trên nhãn tab · logic chọn thumbnail ↔ poster theo ngưỡng và lỗi.

**API:** phản hồi `GET /templates` không chứa `html` và `textBody`; `GET /templates/:id` vẫn chứa đủ.

**Contract:** `pnpm contracts:compat-check` nêu đúng breaking change đã dự kiến.

**Kiến trúc:** `ARCH-HANDOFF` sau khi thêm rule vào `globals.css` — đây là cổng bắt buộc, không phải tuỳ chọn.

**Lệnh kiểm chứng:** `pnpm check`. Đọc số `Test Files` / `Tests`, không tin exit code.

**Thủ công — bắt buộc, và là phần quan trọng nhất.** Ba defect nặng nhất của S0 không test nào bắt được, kể cả defect trong chính tài liệu này: preview bị cắt sạch mà toàn bộ suite vẫn xanh. Sau khi sửa phải mở app thật và **đo lại đúng các số ở §1.1**:

| Kiểm chứng | Ngưỡng đạt |
|---|---|
| Phần iframe preview nhìn thấy ở 1440×900 | > 0, và xấp xỉ chiều cao khung |
| Chiều cao CodeMirror ở tab HTML | > 300px |
| `.editor-shell` ở 768×1024 | không còn 2px |
| Số tầng cuộn quanh preview | 1 |
| Card thư viện sau khi bỏ chữ | **không** còn giống nhau từng byte |

Phủ đủ sáu trạng thái bắt buộc gồm `permission_denied`, ở cả ba khổ 1440×900 · 768×1024 · 390×844.

## 8. Thứ tự triển khai

Hai phần độc lập. **Phần 1 ship trước** — nó là lỗi P0 đang chặn tính năng chính của S0, và không phụ thuộc gì vào phần 2.

## 9. Ngoài phạm vi

Assets API · ảnh chụp phía máy chủ · phân trang thư viện · ba quyết định sanitizer của Mailcraft (`border-radius`, `@media`, `id`) · chuyển `imported` → `builder`.

## 10. Rủi ro

| Rủi ro | Giảm thiểu |
|---|---|
| Ẩn bản text sau tab ⇒ người dùng quên | Huy hiệu `TEXT_BODY_EMPTY` trên nhãn tab |
| Nhiều iframe làm chậm thư viện | Mount lười theo tầm nhìn, cache theo id, hạ xuống poster khi HTML lớn |
| Bỏ `html` khỏi danh sách phá client ngoài dự kiến | Đã kiểm cả ba nơi gọi; compat-check là lưới thứ hai |
| Sửa `globals.css` vi phạm `ARCH-HANDOFF` | Chỉ thêm block mới; chạy architecture tests trước khi tuyên bố xong |
| Grid mới lại bóp panel ở khổ khác | Đo lại cả ba viewport theo bảng §7, không chỉ 1440 |
