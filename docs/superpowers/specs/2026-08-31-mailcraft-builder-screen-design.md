# Mailcraft Builder — Bức tranh toàn cảnh & quy ước màn hình

**Ngày:** 2026-08-31
**Trạng thái:** quy ước dẫn xuất từ ADR-037/038/039 và mã nguồn hiện hành. **S1 và spike S2 đã xong** — xem §0.
**Kế hoạch thực thi:** `docs/superpowers/plans/2026-08-31-mailcraft-builder-vertical-slice.md`
**Quyết định nền:** `docs/adr/adr-037-builder-template-allowlist-and-editor-placement.md`, `docs/adr/adr-038-multi-value-css-in-the-template-sanitizer.md`, `docs/adr/adr-039-builder-owns-its-document-model-no-grapesjs.md`, `docs/adr/adr-019-email-visual-editor.md`
**Kết quả spike:** `docs/superpowers/specs/2026-09-01-grapesjs-spike-findings.md`
**Liên quan:** `docs/frontend/mailcraft-integration-requirements.md`, `docs/frontend/mailcraft-design-direction.md`, `design-reference/ui-source-contract.yaml`

> Tài liệu này trả lời ba câu: **Mailcraft nằm ở đâu trong hệ thống**, **một màn hình mới trong EOW phải tuân quy ước gì**, và **bộ UI bên handoff được phủ tới đâu, khi nào**. Mọi ràng buộc đều dẫn nguồn tới mã nguồn hoặc tài liệu đã duyệt — không có mục nào là suy đoán.

---

## 0. Bắt đầu một phiên mới — đọc gì, theo thứ tự nào

Một người (hoặc agent) chưa từng tham gia có thể bắt đầu chỉ với mục này, không cần hỏi ai.

**Trạng thái hôm nay (2026-09-01):**

| Slice | Trạng thái |
|---|---|
| **S1** — `projectData` qua contract, `border-radius` vào allowlist | ✅ xong (`8274a52`…`39ce50c`) |
| **Spike S2** — output builder qua sanitizer | ✅ xong. Tìm ra chặn CSS → **ADR-038**; chốt không dùng GrapesJS → **ADR-039** |
| **S2** — `EmailEditorEngine` + port model/emitter | ⬜ tiếp theo |
| S3 · S4 · S5 | ⬜ chưa bắt đầu |

Chưa có dòng code UI builder nào. Phần đã làm nằm ở backend/contract và ở sanitizer.

| Thứ tự | Đọc | Để biết |
|---|---|---|
| 1 | Mục §1 và §5 của chính tài liệu này | Mailcraft là gì, phủ tới đâu |
| 2 | `docs/adr/adr-037-...md`, rồi `adr-038-...md` và `adr-039-...md` | Sáu quyết định đã chốt và lý do |
| 3 | Mục §2 của tài liệu này | Quy ước bắt buộc — **đọc hết trước khi viết UI** |
| 4 | `docs/superpowers/plans/2026-08-31-mailcraft-builder-vertical-slice.md` | Việc cụ thể, theo thứ tự |
| 5 | `docs/frontend/mailcraft-design-direction.md` | Người dùng thật là ai, thước đo thành công |

**Xem prototype Mailcraft chạy thật** (tham chiếu UI, nằm ngoài repo, chỉ đọc):

```bash
npm --prefix "../mailcraft-ui-handoff-v1/design-reference/mailcraft-ui-handoff-v1/source" run dev -- --port 5174
```

Prototype là bản độc lập: nút Xuất bản chưa gọi API, dữ liệu là state trong trình duyệt.

> **Cập nhật 2026-09-04 — ADR-044 đảo câu dưới đây.** Câu gốc là *"Dùng để xem bố cục và tương tác, **không** để chép code sang"*. Nó đã được hiểu thành "viết lại markup và CSS theo cách của mình", và sau bốn slice thì `grep -rn "v3-" apps/web/src` trả về 0 kết quả, còn khối `contact` biến mất không để lại một dòng nào trong `docs/`. Từ nay prototype là **gốc thị giác**: CSS chép nguyên văn, DOM và tên lớp port nguyên văn, sai lệch phải có `excludedReason` mang địa chỉ. Bản vendor nằm trong repo tại `design-reference/mailcraft-ui-handoff-v1/`. Phần model/emitter của ADR-039 không đổi.

**Ba câu hỏi hay bị hỏi lại, đã có đáp án — đừng hỏi lại:**

- *Mailcraft có phải site riêng không?* Không. Route trong `apps/web`. Xem §1.1.
- *Bao giờ tách thành service riêng?* Chỉ khi một trong năm tiêu chí ở §3.3 thành hiện thực. Hôm nay chưa cái nào.
- *Có tích hợp được nguyên bộ UI bên handoff không?* Không, và đó là chủ đích. Xem §5.
- *Dùng GrapesJS chứ?* Không. Prototype cũng chưa từng dùng thật — xem ADR-039.

---

## 1. Bức tranh toàn cảnh

### 1.1 Mailcraft đứng ở đâu

EOW (sản phẩm hiển thị với người dùng là **MailSpace**) là hệ thống vận hành: người nhận, biến dữ liệu, chiến dịch, gửi, lịch sử, phân quyền. Mailcraft là **nơi nội dung được tạo ra** — và chỉ vậy.

Mailcraft **không phải** một sản phẩm thứ hai, không phải một site riêng, không phải iframe. Nó là một **route trong `apps/web`** (ADR-037 §4). Người dùng không đăng nhập lần hai, không rời khỏi thanh địa chỉ, không mất điều hướng — chỉ đổi layout sang chế độ tập trung.

Lý do tách bạch vai trò mà không tách hệ thống: không tiêu chí nào trong năm tiêu chí extraction (nhịp release riêng, nghẽn tài nguyên import/render, đội ngũ riêng, nhu cầu bán độc lập, ranh giới compliance) đang đúng. Tách bây giờ là trả phí vận hành cho một lợi ích chưa tồn tại.

### 1.2 Hai con đường tạo template

Cột `email_template.origin` (migration 071) là thứ phân biệt, và nó quyết định **màn hình nào mở ra**:

| `origin` | Tạo bằng | Sửa bằng | Nguồn sự thật khi sửa |
|---|---|---|---|
| `imported` | Import HTML / dán code | `TemplateEditorScreen` (CodeMirror) — **đã có** | `draftHtml` |
| `builder` | **Mailcraft** | Màn hình builder — **chưa có, là việc của kế hoạch này** | `projectData` → **sinh ra** `draftHtml` |

Hai con đường này bình đẳng về kết quả, không phải chính/phụ. Người có file HTML từ designer đi đường thứ nhất; người không biết HTML — theo `mailcraft-design-direction.md` §2 là nhân sự và marketing nội bộ làm việc bằng tiếng Việt — đi đường thứ hai.

`origin` **không đổi được sau khi tạo**. Chuyển `imported` thành `builder` giữa chừng sẽ để lại HTML không có cây component tương ứng; chuyển ngược lại sẽ bỏ rơi cây component còn sống. Vì thế `origin` chỉ có trong `createTemplateSchema`, không có trong `updateTemplateSchema`.

### 1.3 Ranh giới sở hữu dữ liệu

```
projectData  ──(builder sinh ra)──>  draftHtml  ──(publish)──>  version bất biến  ──(campaign ghim)──>  gửi
   ▲                                     ▲
   │                                     │
Mailcraft sở hữu                    EOW sở hữu
(API không đọc)                (sanitize, render, gửi)
```

**Nguyên tắc bất biến (ADR-019):** `draftHtml` là bản ghi duy nhất được dùng để render và gửi. `projectData` chỉ phục vụ việc mở lại để sửa. API **không bao giờ parse** nó — chú thích trên `email-template.entity.ts:39-40` là hợp đồng, không phải ghi chú tuỳ ý.

Hệ quả trực tiếp, và là quy tắc thiết kế quan trọng nhất của màn hình này:

> **Không được có tính năng nào chỉ tồn tại trong `projectData` mà không biểu diễn được ra HTML.** Người dùng thấy nó trên canvas mà email không có ⇒ lỗi thiết kế, không phải lỗi triển khai.

### 1.4 Sáu cổng tích hợp — bốn cái đã tồn tại

`apps/web/src/screens/templates/editor-ports.ts` đã khai báo bốn port, và chú thích đầu tệp nói rõ chúng sinh ra để `origin: 'builder'` cắm vào mà màn hình không phải biết:

| Port | Trạng thái | Ghi chú |
|---|---|---|
| `ContentStore` | ✅ có | `load` / `save(+draftRevision)` / `publish` |
| `VariableProvider` | ✅ có | Danh mục biến — EOW là nguồn duy nhất |
| `PreviewService` | ✅ có | Render thật qua server |
| `LintService` | ✅ có | 6 mã cảnh báo |
| `EmailEditorEngine` | ❌ thiếu | **S2 thêm.** Bọc model+emitter của chính ta (ADR-039 — không dùng GrapesJS) |
| `AssetProvider` | ❌ thiếu | Cố tình hoãn — chưa có kho asset (§3.2) |

Không dựng bộ contract mới. Thêm đúng cái thiếu.

---

## 2. Quy ước bắt buộc cho màn hình mới

Phần này áp dụng cho **mọi** màn hình mới trong `apps/web`, không riêng builder. Nguồn: `design-reference/ui-source-contract.yaml`, `visual-acceptance.md`, và các spec đã duyệt.

### 2.1 Sáu trạng thái — bắt buộc đủ

`loading` · `empty` · `error` · `success` · `permission_denied` · `reconnecting` (khi có realtime).

**`permission_denied` là trạng thái hay bị bỏ quên nhất, và ở repo này nó có tiền lệ đã giải.** Spec `2026-08-26-template-read-only-permission-design.md` đã tách `content:read` khỏi `content:manage` (migration 073) đúng để trạng thái này dựng được:

- Route builder yêu cầu **`content:read`** — đủ để vào và nhìn thấy.
- Thiếu `content:manage` ⇒ **chỉ đọc có giải thích**, không phải màn hình trắng, không phải 403 thô.
- Quyền kiểm **trong màn hình**, không chặn ở route. Chặn ở route thì kết quả lại là màn hình trắng.
- Chỉ đọc nghĩa là: nội dung hiện đầy đủ (canvas, inspector, preview, lint, biến, lịch sử); bị vô hiệu hoá là autosave, xuất bản, lưu trữ, khôi phục, sửa biến, gửi thử.
- Chốt chặn nên đặt tại **một điểm duy nhất** mà mọi đường sửa đi qua — tiền lệ là `change()` trong `TemplateEditorScreen`, không rải `if` khắp component.

Hàm quyết định phải là **hàm thuần** đặt cạnh `templateContentIsReadOnly()` trong `template-editor.ts` — web không có test render component, nên logic nào không thuần là logic không test được.

### 2.2 Ba viewport

1440×900 · 768×1024 · 390×844 (`visual-acceptance.md`).

Chính sách responsive riêng của builder (`ui/UI-HANDOFF.md` §6):

| Khổ | Hành vi |
|---|---|
| ≥1280px | Editor đầy đủ |
| 1024–1279px | Chỉ mở **một** panel bên tại một thời điểm; panel dùng chế độ overlay |
| <1024px | Quản lý và preview vẫn dùng được; kéo-thả hiện lời giải thích "không hỗ trợ khổ này" |

390px **không được vỡ layout** — nó là chế độ đọc/preview được thiết kế có chủ đích, không phải bản rơi rớt.

### 2.3 Dark mode: chrome tối, canvas luôn sáng

Đây là quy ước dễ làm sai nhất, và `globals.css` đã ép sẵn:

```css
.theme-dark .preview-content, .theme-dark .email-canvas,
.theme-dark .mail-preview-stage article, .theme-dark .template-large-preview
  { background:#fff; color:#292429 }
.theme-dark .mail-preview-stage { background:#151214 }
```

Khung ứng dụng theo theme người dùng; **bề mặt email luôn nền sáng** kể cả trong dark mode — vì đó là email thật, không phải UI. Nếu canvas tối, người dùng sẽ dựng email trên nền tối rồi nhận về email nền sáng.

Builder phải theo đúng quy tắc này, và **dùng lại** class `.email-canvas` sẵn có thay vì tự đặt tên mới — tên mới sẽ nằm ngoài rule trên và âm thầm sai trong dark mode.

### 2.4 Design token — không rải màu cứng

EOW dùng CSS custom properties: `--ink` `--muted` `--line` `--surface` `--canvas` `--coral` (accent) `--green` `--amber`, thang `--radius-sm|md|lg`, thang chữ `--ui-xs|sm|md|lg`.

Mailcraft giữ tông thương hiệu riêng (`#173F33` primary, `#F3F1ED` nền ứng dụng, `#E9E7E2` nền canvas — `ui/UI-HANDOFF.md` §5), nhưng **khai báo tập trung ở một chỗ**, không rải giá trị màu cứng khắp component. Dùng xanh cho trạng thái chọn/editor, **không** cho mọi container — canvas phải giữ trung tính để thiết kế email được ưu tiên thị giác.

### 2.5 `ARCH-HANDOFF`: chỉ được append vào `globals.css`

Không sửa dòng đã duyệt nào của `apps/web/src/app/globals.css`. Thêm rule mới thì được; **nối thêm selector vào rule có sẵn thì không**.

Khi một rule cũ khớp nhầm bề mặt mới, cách xử lý đúng là **đổi class trong JSX** cho rule cũ thôi khớp, rồi viết block mới — không phải sửa rule cũ. Tiền lệ đầy đủ: `2026-08-26-template-editor-layout-and-thumbnails-design.md` §3.

### 2.6 Tiếng Việt là ngôn ngữ chính

Toàn bộ copy tiếng Việt. Sắp xếp danh sách bằng `localeCompare(..., 'vi')`. Không thiết kế layout giả định độ dài chuỗi tiếng Anh — nhãn tiếng Việt thường dài hơn 20–40%.

### 2.7 Đồng thời: `412`, không phải `409`

Codebase này dùng `412`. Chuỗi đầy đủ đã hiện hữu:

- `PATCH /templates/:id` bắt buộc header `If-Match` — thiếu ⇒ **`428`** (`templates.controller.ts:23-26`).
- `draftRevision` lệch ⇒ **`412`** với thông điệp "Template has changed. Reload before saving." (`templates.service.ts:214`).
- `problem.ts:52` đã map `409|412|428` sang copy `RESOURCE_CONFLICT`.
- `draftRevision`, **không bao giờ** gọi là `version` — `EmailTemplateVersionEntity.version` đã mang nghĩa "số hiệu bản đã xuất bản".

Trạng thái autosave phải có **năm**, không phải bốn: `Saved` · `Saving` · `Unsaved` · `Save failed` · **`Bản nháp đã bị thay đổi ở nơi khác`**. Trạng thái thứ năm mở màn so sánh cho người dùng chọn giữ bản của mình hay lấy bản máy chủ. **Không được lặng lẽ ghi đè.**

### 2.8 Lint: đúng sáu mã, không tự định nghĩa bộ khác

`IMAGE_ALT_MISSING` · `LINK_TARGET_MISSING` · `LINK_PLACEHOLDER` · `LINK_INVALID` · `TEXT_BODY_EMPTY` · `HTML_SIZE_LARGE`. Tất cả mức `warning`, có `count` và `field`, bấm được để nhảy tới vị trí.

⇒ **Khối mặc định không được dùng `href="#"`** — `LINK_PLACEHOLDER` bắt `#`, `javascript:void(0)`, `example.com`, `example.test`. Mọi khối kéo vào sẽ lập tức sinh cảnh báo. Dùng trạng thái "chưa đặt liên kết" tường minh.
⇒ `href="{{ten_bien}}"` là **hợp lệ**.
⇒ Màn hình cho soạn văn bản thuần phải **luôn gửi** `textBody`, kể cả rỗng — bỏ trường đi thì server phân tích trên bản sinh tự động và không có cảnh báo nào.

### 2.9 Biến: chỉ `{{key}}`

Cú pháp duy nhất: `{{ten_bien}}`, key theo `[a-z][a-z0-9_]{0,63}`.

**Không hỗ trợ, bị từ chối lúc xuất bản:** helper (`{{formatDate x}}`), truy cập thuộc tính (`{{user.name}}`), biểu thức lồng, `{{#if}}`, `{{#each}}`.
⇒ **Không thiết kế UI cho nội dung điều kiện hay khối lặp.** Nếu cần, đó là quyết định sản phẩm bàn riêng.

Bốn scope hiển thị tách nhóm rõ: `system` · `global` · `recipient` · `template`. Mỗi biến có `required` và `defaultValue`. Biến chưa khai báo **chặn xuất bản** (`UNKNOWN_VARIABLE`), **không** chặn lưu nháp.

Trên canvas, biến hiển thị nền vàng nhạt (`<mark>`) — nhận diện được nhưng vẫn phản ánh gần đúng email cuối. Panel danh mục **phải còn**, kể cả khi thêm cách chèn bằng `/` hay `{`: đó là chỗ duy nhất người dùng thấy biến nào bắt buộc và biến nào có mặc định.

Định dạng ngày/số resolve **lúc render, phía server**, từ định nghĩa biến hiện tại — không đóng băng vào version (ADR-036). Builder không tự format phía client.

### 2.10 Version bất biến

`PATCH /template-versions/:id` trả **`405`**; `DELETE` cũng vậy. Hệ quả cho UI lịch sử phiên bản:

- **Không có** nút "Sửa version này".
- "Khôi phục" nghĩa là **tạo bản nháp mới từ nội dung version cũ**, không ghi đè version.
- Xóa version: không tồn tại.
- Trạng thái template: `draft` · `published` · `archived`. Không có xóa cứng.

### 2.11 Điều hướng Back — bốn lớp

Nút Back trong focus mode xử lý theo thứ tự, dừng ở lớp đầu tiên áp dụng được (`ui/UI-HANDOFF.md` §3):

1. Đóng modal hoặc panel công cụ đang mở rộng;
2. Thoát preview;
3. Rời focus editor về màn quản lý template;
4. Về route EOW trước đó.

Còn thay đổi chưa lưu ⇒ hộp thoại **Lưu nháp / Bỏ / Ở lại**. *Back never silently deletes a draft.*

### 2.12 Ràng buộc HTML đầu ra

Mọi HTML lưu vào EOW đều đi qua `template-html-sanitizer.ts`: quét `<style>` → `juice()` inline CSS → sanitize lần cuối. **Không có đường vòng cho `origin: 'builder'`.**

| Ràng buộc | Nội dung |
|---|---|
| Tag | 37 tag email. **Không** `script` `iframe` `video` `svg` `button` `form` `input` `picture` `link` `meta` |
| Button | Xuất `<a>` tạo dáng bằng `<table>` — `<button>` bị xóa |
| Attribute | `id` và `data-*` **bị xóa** ⇒ ánh xạ HTML↔cây component phải nằm trong `projectData` (ADR-037 §3) |
| CSS | 19 thuộc tính, thành **20** sau khi ADR-037 §1 thêm `border-radius`. **ADR-038** cho phép giá trị nhiều thành phần (tối đa 4 token) trên `padding`, `margin`, `border`, `border-radius`, `border-spacing` ⇒ ràng buộc "radius một giá trị dùng chung" của ADR-037 §1 **đã được gỡ**; inspector được phép có control bốn góc |
| `@media` | **Bị xóa** (`preserveMediaQueries: false`). Responsive bằng fluid/hybrid: bảng `width="100%"` + `max-width`, cột xếp chồng bằng `align` (ADR-037 §2) |
| `url(` | Bị chặn ⇒ **không background image bằng CSS**. Dùng `<img>` hoặc `bgcolor` |
| Ảnh | `src` chỉ `https:` hoặc `cid:`. **Không base64** |
| Kích thước | Cứng 5 MB (từ chối lưu); cảnh báo từ 512 KB; lồng tối đa 100 cấp |

Chuỗi chứa `@import`, `url(`, `expression(`, `behavior:`, `-moz-binding`, `javascript:`, `data:` làm **toàn bộ stylesheet bị xóa**, không phải chỉ dòng vi phạm.

### 2.13 Không component nào gọi thẳng engine hay API

UI gọi qua port. Không component nào được import model hay emitter trực tiếp, và `apps/web` **không có dependency `grapesjs`** (ADR-039). Đây là điều kiện để cùng một màn hình chạy được với adapter mock (test) lẫn adapter thật (production) mà không sửa component — và là seam để thay engine sau này mà không viết lại UI.

---

## 3. Định hướng

### 3.1 Thứ tự triển khai

| Slice | Nội dung | Cổng thoát |
|---|---|---|
| **S1** | `projectData` qua contract + `border-radius` vào allowlist | Lưu/đọc lại project JSON qua HTTP |
| **S2** | `EmailEditorEngine` + port model/emitter | Không có dependency `grapesjs`; HTML qua sanitizer không mất padding/margin/border |
| **S3** | Route builder + focus mode | Vào/ra không mất nháp; Back 4 lớp |
| **S4** | Khối + inspector + biến | Dựng được email onboarding thật |
| **S5** | Publish + ghim chiến dịch | Chiến dịch gửi đúng version đã duyệt |

**Thước đo thành công của cả nỗ lực này** (`mailcraft-design-direction.md` §2): *một người phụ trách nhân sự tự dựng xong email onboarding trong mười phút mà không phải hỏi ai* — đồng thời người có kỹ thuật vẫn xuống được tới HTML khi cần.

### 3.2 Cố tình hoãn, và vì sao

| Việc | Vì sao hoãn | Điều kiện mở |
|---|---|---|
| **Asset API + kho lưu trữ** | Chưa tồn tại trong EOW; sanitizer cấm base64 | Chặn ảnh upload — S4 chỉ dán URL `https` |
| **Import HTML vào builder** | Dựng ngược cây component từ HTML là bài toán khó, và ADR-037 §3 đã cấm cách sai (đọc `id`) | Sau khi S4 ổn định |
| **Reusable block library** | Chưa chốt thuộc user hay tenant | Quyết định sản phẩm |
| **Nội dung điều kiện / khối lặp** | Cú pháp biến không hỗ trợ | Quyết định sản phẩm riêng |
| **Media query thật (hướng A)** | Cần spike kiểm chứng hộp thư | Có bằng chứng render |
| **Tách service riêng** | Không tiêu chí nào trong năm tiêu chí §3.3 đang đúng | Xem §3.3 |

### 3.3 Khi nào xét lại kiến trúc

Chỉ khi **một trong năm** điều sau thành hiện thực, không phải khi codebase "cảm thấy lớn": nhịp release cần tách riêng; import/render nghẽn tài nguyên với API; có đội ngũ riêng nhận sở hữu; có nhu cầu bán Mailcraft độc lập; có yêu cầu cách ly tenant/compliance.

Khi đó thứ tự tách khả dĩ: worker render/import → asset service → Mailcraft API → frontend độc lập. Vì UI đã nói chuyện qua port, việc tách là thay adapter phía sau port — không phải viết lại editor.

### 3.4 Hai trạng thái treo — **đã đóng cả hai** (2026-09-01)

- **ADR-019** (email visual editor) → **`Accepted`**. Spike đã chạy (ADR-039); yêu cầu "HTML canonical độc lập editor JSON" được thoả bằng cách tự sở hữu emitter; kiểm chứng xanh trọn vẹn 235 file / 1517 test.
- **FE-013** → **`Rejected`**, không phải `Accepted`. Thư viện chưa từng gánh việc gì trong bản tham chiếu (mount 1×1px ngoài màn hình, không bao giờ đọc lại). Xem ADR-039.

Câu hỏi ban đầu — "newsletter preset có xuất đúng tập tag không" — hoá ra đặt sai tiền đề: không có preset nào cả. Cái spike thực sự tìm ra là một chặn ở tầng CSS (`padding`/`margin`/`border` bị xoá âm thầm), đã sửa bằng **ADR-038**.

---

## 5. Bản đồ phủ màn hình — "khi nào xong bộ UI bên kia?"

### 5.1 Câu trả lời thẳng: sẽ không bao giờ phủ 100%, và đó là chủ đích

Bộ handoff liệt kê **15 màn hình**: 10 màn người dùng (`ui/SCREEN-INVENTORY.md`, UI-01…UI-10) và 5 màn quản trị (ADM-01…ADM-05); `design-reference/screen-catalog.yaml` bẻ nhỏ phần editor thành MC-UI-001…011.

**Năm màn quản trị phần lớn không áp dụng trong kiến trúc đã chọn.** ADM-01 (Content providers), ADM-02 (Mailcraft provider details) và ADM-05 (Connector delivery/retry log) chỉ có nghĩa khi Mailcraft là **service riêng** phải đăng ký và đồng bộ qua connector. Chưa tiêu chí nào trong năm tiêu chí §3.3 thành hiện thực, nên không có provider nào để quản trị và không có connector log nào để xem. ADM-03 (OIDC) và ADM-04 (tenant/permission) **đã thuộc EOW** từ trước — không phải màn hình Mailcraft.

⇒ Mục tiêu đúng không phải "tích hợp full bộ UI", mà là **phủ hết 10 màn người dùng**, trong đó một phần đáng kể EOW đã có sẵn.

### 5.2 Bảng phủ

| Handoff ID | Màn hình | Ai làm | Trạng thái |
|---|---|---|---|
| UI-01 | Quản lý template | `TemplatesScreen.tsx` | ✅ **đã có** — S3 chỉ thêm lối vào "Tạo bằng Mailcraft" |
| UI-08 / MC-UI-009 | Lịch sử phiên bản | `TemplateEditorScreen` / `BuilderScreen` (`TemplateVersionHistory`) | 🟡 **phần lớn đã có** — danh sách + khôi phục có từ trước (`2026-08-26-template-version-history-design.md`); S8 Task 47 nối `preview`; `compare` (Task 48) chưa có |
| UI-09 / MC-UI-008 | Preview & soát nội dung | `TemplateEditorScreen` | ✅ **phần lớn đã có** — preview server-side + lint 6 mã; S4 nối vào canvas builder |
| MC-UI-011 | Custom HTML/CSS | `TemplateCodeView` | ✅ **đã có** — dùng lại, không viết mới |
| UI-02 | Tạo template | — | 🔜 **S3** |
| UI-03 / MC-UI-001 | Focus editor (studio) | — | 🔜 **S3** khung + **S4** nội dung |
| MC-UI-002 | Insert workspace | — | 🔜 **S4** |
| MC-UI-003 | Structure workspace (cây node) | — | 🔜 **S4** |
| MC-UI-007 | Theme & document settings | — | 🔜 **S4** |
| UI-10 / MC-UI-010 | Publish handoff | — | 🔜 **S5** (route publish đã có, cần màn tổng kết) |
| UI-04, UI-05 / MC-UI-006 | Import HTML + báo cáo **vào builder** | — | ⏸ **hoãn** — import hiện có đi vào code editor, vẫn dùng được |
| UI-06 / MC-UI-004 | Thư viện khối tái dùng | — | ⏸ **hoãn** — chưa chốt thuộc user hay tenant |
| UI-07 / MC-UI-005 | Thư viện asset | — | 🚫 **chặn** — EOW chưa có kho asset; sanitizer cấm base64 |
| ADM-01, 02, 05 | Provider & connector log | — | ❌ **không áp dụng** — chỉ có nghĩa khi tách service |
| ADM-03, ADM-04 | OIDC, tenant & quyền | EOW | ✅ **đã thuộc EOW** (RBAC + migration 073) |

**Đọc bảng này thế nào:** 4 màn đã xong, 6 màn nằm trong S3–S5, 2 màn hoãn có chủ đích, 1 màn bị chặn bởi phụ thuộc ngoài, 2 nhóm không áp dụng.

### 5.3 "Xong" nghĩa là gì, và cái gì quyết định thời điểm

**Định nghĩa xong của vertical slice** (hết S5): một người dùng thật mở Mailcraft từ EOW, dựng email onboarding có chữ/ảnh-URL/nút/biến, lưu, xuất bản một version bất biến, và một chiến dịch gửi đúng version đó. Không có asset upload, không có khối tái dùng, không import HTML vào builder.

**Định nghĩa xong của sản phẩm** — thêm ba mảng ở §3.2, mỗi mảng cần điều kiện riêng được gỡ trước.

Tôi **không đưa ra mốc thời gian** vì chưa có dữ liệu nhịp độ để suy ra, và một con số bịa ra sẽ tệ hơn không có. Thay vào đó, đây là thứ thật sự quyết định lịch:

```
S1 ──> S2 ──> S3 ──> S4 ──> S5
 │      │      │      │      │
 nhỏ   RỦI RO  vừa   LỚN    nhỏ
      (spike)        (phần thân)
```

- **S1** nhỏ và chắc chắn: sửa một dòng allowlist, nối một trường qua bốn tầng đã biết tên. Không có ẩn số.
- **S2 không còn là rủi ro lịch trình — spike đã xong.** Kết quả: không dùng GrapesJS (ADR-039), emitter tự sở hữu, output đã đo 85% sống sót qua sanitizer sau ADR-038. Rủi ro còn lại chuyển sang **khối lượng port**: `studio.tsx` là 959 dòng đặc, và emitter mang sẵn một nợ kỹ thuật (dựa vào `@media` mà sanitizer xoá) phải viết lại fluid/hybrid ở S4.
- **S4 là phần thân** của toàn bộ nỗ lực, và độ lớn của nó phụ thuộc kết quả S2.
- **S3, S5** vừa và nhỏ, ít ẩn số.

⇒ **Câu hỏi "khi nào xong" chỉ trả lời được sau S2.** Chạy S1 rồi làm spike S2 là con đường ngắn nhất để có một ước lượng đáng tin, thay vì một con số đoán mò hôm nay.

---

## 6. Truy vết business rule — 12 rule `BR-TPL-*`

`visual-acceptance.md` yêu cầu mỗi màn hình truy vết tới rule ID, API operation và test tự động. Bảng này là truy vết đó.

**Điểm mấu chốt: builder không sinh ra rule mới.** Cả 12 rule đã được đường `imported` thực thi. Việc của builder là **không phá** chúng — nên cột quan trọng nhất là "builder phải làm gì".

| Rule | Nội dung | Hiện trạng | Builder phải làm gì | TC |
|---|---|---|---|---|
| BR-TPL-001 | Vòng đời draft/published/archived | ✅ có | Kế thừa; không thêm trạng thái | TC-TPL-001 |
| BR-TPL-002 | Version bất biến khi publish | ✅ có | UI không có "sửa version"; restore = tạo nháp mới (§2.10) | TC-TPL-002, 015 |
| BR-TPL-003 | Cú pháp `{{variable_key}}`, key phải tồn tại | ✅ có | **Không** UI cho helper/`#if`/`#each` (§2.9) | TC-TPL-003, 013 |
| BR-TPL-004 | Required/optional + default | ✅ có | Panel biến hiện `required` và giá trị mặc định, tách 4 scope | TC-TPL-004 |
| BR-TPL-005 | Preview merge subject/HTML/text | ✅ có | Dùng lại `PreviewService`, hiện `missingKeys` | TC-TPL-005 |
| BR-TPL-006 | Sanitize HTML, validate link | ✅ có | **S1 sửa allowlist** ⇒ TC-TPL-006 và 014 phải chạy lại | TC-TPL-006, 014 |
| BR-TPL-007 | Bắt buộc có text part | ✅ có | **S4 phải có trường văn bản thuần**, luôn gửi kể cả rỗng (§2.8) | TC-TPL-007 |
| BR-TPL-008 | `unsubscribe_url` + header List-Unsubscribe | ⚠️ một phần | `unsubscribe_url` là biến **scope `system`**, đã có (`recipient-variable-context.ts:33`). Builder phải cho chèn được nó — thường trong khối footer | TC-TPL-008 |
| BR-TPL-009 | Ảnh HTTPS/asset storage, không base64 | ✅ có | **Đây là gốc của việc chặn thư viện asset** (§5.2). S4 chỉ dán URL `https` | TC-TPL-009 |
| BR-TPL-010 | Tên template duy nhất trong tenant (409) | ✅ có | Màn tạo phải xử lý `409`, không nuốt lỗi | TC-TPL-010 |
| BR-TPL-011 | Test email có nhãn, không tính vào thống kê | ✅ có | Nút gửi thử khoá khi chờ, tái dùng `Idempotency-Key` | TC-TPL-011 |
| BR-TPL-012 | Campaign snapshot version + schema | ✅ có | **S5 nghiệm thu chính là rule này** | TC-TPL-012, 015 |

⇒ **Hai rule tạo ràng buộc thiết kế thật cho builder**: BR-TPL-007 (bắt buộc có ô văn bản thuần — không được bỏ vì "canvas đã đẹp rồi") và BR-TPL-008 (phải chèn được `unsubscribe_url`, nếu không email bulk sẽ bị chặn ở khâu gửi chứ không phải khâu soạn).

---

## 7. Phần backend — ít hơn bạn nghĩ, và đó là chủ đích

Câu hỏi hợp lý: "backend phải làm gì cho builder?" Đáp án: **gần như không gì, ngoài S1.**

Lý do nằm ở ADR-019 và chú thích trên `email-template.entity.ts:39-40`: API **không học khái niệm builder**. Nó nhận `draftHtml` như mọi template khác, cộng thêm một cục JSON mờ nó không đọc. Sanitize, lint, render, publish, snapshot — toàn bộ đã tồn tại và **dùng chung một đường** cho cả `imported` lẫn `builder`.

| Hạng mục backend | Cần làm | Slice |
|---|---|---|
| `projectData` qua DTO/response/contract | ✅ có việc | **S1** |
| `border-radius` vào allowlist sanitizer | ✅ có việc | **S1** |
| Lưu nháp + optimistic concurrency (`If-Match`/412) | ❌ đã có | — |
| Sanitize + lint 6 mã | ❌ đã có | — |
| Danh mục biến 4 scope + định dạng lúc render | ❌ đã có (ADR-031/032/033/036) | — |
| Preview server-side | ❌ đã có | — |
| Publish → version bất biến + `contentHash` | ❌ đã có | — |
| Outbox / domain event | ❌ đã có (ADR-012) | — |
| Campaign ghim version | ❌ đã có (ADR-013/029) | — |
| RBAC `content:read` / `content:manage` | ❌ đã có (migration 073) | — |
| **Asset API + kho lưu trữ** | ⏸ **chưa có, chưa lên lịch** | ngoài vertical slice |

**Không có migration mới trong toàn bộ S1–S5.** Cột `project_data`, `origin`, `draft_revision` đã có từ migration 071. Điều này quan trọng vì mỗi migration kéo theo nghĩa vụ cập nhật `database/migrations.lock.json` bằng tay (§ bối cảnh trong plan).

**Một mảng backend duy nhất còn thiếu hẳn là Asset API** — và nó bị chặn bởi BR-TPL-009 chứ không phải bởi builder. Khi nào làm nó là quyết định sản phẩm riêng, không thuộc kế hoạch này.

---

## 4. Nghiệm thu màn hình

Màn hình builder chỉ được coi là xong khi đủ cả bốn nhóm:

**Đầu ra HTML** — đúng tập tag §2.12; không `<button>`/`<svg>`/`<form>`; không dựa `id`/`data-*`; style trong 20 thuộc tính cho phép; không `url()`; mobile không phụ thuộc `@media`; ảnh luôn `https`; khối mặc định không `href="#"`; template thực tế dưới 512 KB.

**Tích hợp** — `apps/web` không có dependency `grapesjs`; không component nào import model/emitter trực tiếp; biến/ảnh/lint/preview/lưu đều qua port; chạy được với adapter mock lẫn thật mà không sửa component; `getHtml()` trả HTML đầy đủ độc lập với `projectData`.

**Mô hình sản phẩm** — chỉ `{{key}}`; bốn scope tách nhóm có `required` và mặc định; có trường văn bản thuần; lịch sử phiên bản không có "sửa version"; preview hiện `missingKeys`.

**Trạng thái & trải nghiệm** — đủ 6 trạng thái, đặc biệt `permission_denied` dạng chỉ đọc; đủ 3 viewport, 390px là chế độ đọc được thiết kế; dark mode chrome tối/canvas sáng; autosave có trạng thái xung đột kèm màn so sánh; lint đúng 6 mã bấm được; copy tiếng Việt sắp xếp theo `vi`; token khai báo tập trung.

Bằng chứng ảnh chụp lưu ở thư mục evidence của run, **không** lưu vào `design-reference/`.
