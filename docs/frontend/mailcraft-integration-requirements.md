# Mailcraft — Yêu cầu tích hợp & UI/UX từ Email Operations Workspace

> ⚠️ **Chưa cần đọc tài liệu này ở giai đoạn prototype.**
> Định hướng, ý tưởng và lưu ý khi sáng tạo nằm ở [mailcraft-design-direction.md](mailcraft-design-direction.md) — đọc bản đó trước.
> Bản này là tài liệu kỹ thuật cho **giai đoạn tích hợp**, khi identity và cấu trúc thông tin của Mailcraft đã chốt.

**Đối tượng:** đội tích hợp Mailcraft vào EOW.
**Mục đích:** danh sách ràng buộc kỹ thuật ở thời điểm hiện tại. Lưu ý: phần lớn ràng buộc trong §1 nằm trong mã nguồn EOW và **có thể mở** — xem §5.2 của tài liệu định hướng trước khi coi bất kỳ dòng nào ở đây là bất biến.
**Cách dùng:** dùng §6 làm checklist nghiệm thu ở giai đoạn tích hợp.

Mọi ràng buộc dưới đây đều dẫn nguồn tới mã nguồn EOW hiện hành, không phải suy đoán.

---

## 0. Ranh giới hai hệ thống

EOW giữ: HTML canonical, danh mục biến, người nhận, chiến dịch, gửi và lịch sử gửi.
Mailcraft giữ: trải nghiệm dựng nội dung.

Template trong EOW có hai nguồn gốc:

| `origin` | Tạo bằng | Sửa bằng | Nguồn sự thật |
|---|---|---|---|
| `imported` | Import HTML / dán code | Code editor trong EOW | HTML canonical |
| `builder` | **Mailcraft** | Mailcraft | Project JSON → **sinh ra** HTML canonical |

**Nguyên tắc bất biến (ADR-019):** HTML canonical là bản ghi duy nhất được dùng để gửi email. Project JSON chỉ phục vụ việc chỉnh sửa lại. Hệ quả trực tiếp cho thiết kế:

> Không được có tính năng nào chỉ tồn tại trong project JSON mà không biểu diễn được ra HTML. Nếu người dùng thấy nó trên canvas mà email không có, đó là lỗi thiết kế chứ không phải lỗi triển khai.

---

## 1. Ràng buộc bắt buộc — vi phạm thì HTML bị biến đổi lúc lưu

Nguồn: `apps/api/src/templates/template-html-sanitizer.ts`. Mọi HTML lưu vào EOW đều đi qua ba bước: quét `<style>` → `juice()` inline CSS → sanitize lần cuối. Không có đường vòng, kể cả cho template `builder`.

### 1.1 Tag được phép

```
a b blockquote body br caption center code div em font
h1 h2 h3 h4 h5 h6 head hr html i img li ol p pre span strong
table tbody td tfoot th thead tr u ul
```

**Không có:** `<script>` `<iframe>` `<video>` `<audio>` `<svg>` `<button>` `<form>` `<input>` `<picture>` `<source>` `<link>` `<meta>`.

Lưu ý: `<button>` bị xóa. Block "Button" phải xuất ra `<a>` tạo dáng bằng `<table>`, đúng chuẩn email — không được xuất `<button>`.

`<style>` **được chấp nhận ở lần quét đầu**, sau đó `juice()` inline hóa và xóa thẻ đi. Bạn có thể xuất `<style>`, nhưng đừng trông đợi nó còn tồn tại trong HTML đã lưu.

### 1.2 Attribute được phép

| Tag | Attribute |
|---|---|
| `a` | `href` `name` `target` `title` |
| `img` | `alt` `height` `src` `title` `width` |
| `table` | `align` `bgcolor` `border` `cellpadding` `cellspacing` `height` `role` `width` |
| `td` | `align` `bgcolor` `colspan` `height` `rowspan` `valign` `width` |
| `th` | như `td`, thêm `scope` |
| mọi tag | `class` `style` `title` |

**`id` không nằm trong danh sách — mọi thuộc tính `id` đều bị xóa.**
GrapesJS gán `id` cho component theo mặc định. Xem §2.3.

`data-*` cũng bị xóa. Đừng dựa vào `data-*` để đánh dấu bất cứ thứ gì cần sống sót sau khi lưu.

### 1.3 Thuộc tính CSS được phép trong `style`

**Cập nhật 2026-09-02:** danh sách gốc là 19 thuộc tính (bản trước ghi nhầm 20). ADR-037 thêm `border-radius` ⇒ 20. **ADR-040** thêm `display` · `max-height` · `overflow` ⇒ 23. **ADR-042** thêm `box-shadow` · `letter-spacing` · `text-transform` · `background-image` (giới hạn `linear-gradient()`) ⇒ **27**. **ADR-045** thêm bốn thuộc tính `mso-*` (`mso-line-height-rule` · `mso-hide` · `mso-table-lspace` · `mso-table-rspace`) ⇒ **31**. **ADR-048** thêm `list-style-type` ⇒ **32**. **ADR-038** cho phép **giá trị nhiều thành phần** (2–4 token cách nhau bằng khoảng trắng, mỗi token vẫn phải hợp lệ) trên sáu thuộc tính `padding` · `margin` · `border` · `border-radius` · `border-spacing` · `box-shadow`.

Danh sách gốc:

```
color  background-color  font-family  font-size  font-style  font-weight
line-height  text-align  text-decoration  vertical-align
width  height  max-width  min-width
border  border-collapse  border-spacing  margin  padding
```

**Bị xóa:** `background` (shorthand — dùng `background-color`), `float`, `position`, `opacity`, `border-top`/`border-left`/… (chỉ `border` gộp được phép), `mso-*` **ngoài bốn tên ADR-045 mở**, và mọi thuộc tính không có trong danh sách trên.

> `border-radius` (ADR-037) và `display`/`max-height`/`overflow` (ADR-040) **không còn** bị xóa. `mso-hide:all` **cũng không còn bị xoá kể từ ADR-045** — preheader giờ ẩn cả ở Outlook desktop. Kiểm kê từng khối: `docs/superpowers/specs/2026-09-01-builder-block-sanitizer-audit.md`.

> **ADR-045** mở tầng tương thích Outlook: bốn thuộc tính `mso-*` theo tên (`mso-line-height-rule`, `mso-hide`, `mso-table-lspace`, `mso-table-rspace` — **không mở theo tiền tố**), ba thẻ `<head>` (`meta[charset]`, `meta[name]`, `title`) cùng `html[lang]`, và thẻ trung gian `<mso-ghost>` mà sanitizer nở thành comment điều kiện ở bước cuối. `http-equiv` bị loại có chủ ý và có test khoá. Comment tuỳ ý, `@media` và VML **vẫn bị xoá**.

> **ADR-042** mở tiếp bốn thuộc tính, mỗi thuộc tính có ngữ pháp giá trị riêng, không dùng chung danh sách cũ:
> - `box-shadow` — dùng đúng shorthand 2–4 token của ADR-038 (`offset-x offset-y blur color`). **Không hỗ trợ `inset`** — giá trị đó cần 6 token, vượt trần 4 token, nên vẫn bị loại.
> - `letter-spacing` — số kèm đơn vị `px|em|rem|%`, **được phép dấu trừ** (tracking âm cho tiêu đề). Dấu trừ chỉ áp dụng cho thuộc tính này, không mở rộng sang các thuộc tính số khác.
> - `text-transform` — đúng bốn từ khóa `uppercase` `lowercase` `capitalize` `none` (cộng `inherit`/`initial`/`unset`).
> - `list-style-type` (ADR-048) — đúng chín từ khóa `disc` `circle` `square` `decimal` `lower-alpha` `upper-alpha` `lower-roman` `upper-roman` `none`. Bốn đường khác để chọn ký hiệu đầu dòng **vẫn bị tước**, đã đo: `list-style` (shorthand — nó kéo theo `list-style-image` vốn nhận `url()`), `list-style-position`, thuộc tính `type` và thuộc tính `start` trên `<ol>`. Danh sách đánh số luôn bắt đầu từ 1.
> - `background-image` — **chỉ** `linear-gradient(...)`: hướng tùy chọn (`to <cạnh>` hoặc góc `deg`) rồi 2–6 điểm dừng màu (hex/`rgb()`/`rgba()`, có thể kèm `%`). `url(` không khớp được cấu trúc này dù ở ngoài hay lồng bên trong gradient — đây là chốt chặn bảo mật thật của thuộc tính này, vì `unsafeCss` (chặn `@import`/`url(`/…) chỉ quét nội dung `<style>`, không quét giá trị `style="..."` inline.
>
> Xem `docs/adr/adr-042-css-allowlist-for-the-inspector-shadow-tracking-transform-gradient.md` để có bảng đo trước/sau đầy đủ.

Giá trị cũng bị kiểm: chỉ chấp nhận mã màu hex, `rgb()`/`rgba()`, số kèm đơn vị `px|em|rem|%|pt`, một tập từ khóa (`normal bold italic none left right center justify top middle bottom solid dashed underline line-through inherit initial unset`), và tên font. Với sáu thuộc tính ở trên (kể cả `box-shadow`), giá trị còn có thể là 2–4 token như vậy nối bằng khoảng trắng — `border:1px solid #ccc`, `padding:12px 20px` (ADR-038). `rgb()` **có dấu cách bên trong** không dùng được trong dạng nối; viết `rgb(0,0,0)`.

Chuỗi chứa `@import`, `url(`, `expression(`, `behavior:`, `-moz-binding`, `javascript:`, `data:` làm **toàn bộ stylesheet bị xóa**, không phải chỉ dòng vi phạm.

> `url(` bị chặn ⇒ **không có background image bằng CSS bất kỳ**, kể cả bên trong `linear-gradient()`. Nền ảnh phải làm bằng `<img>` hoặc `bgcolor`; nền gradient (không phải ảnh) dùng `background-image:linear-gradient(...)` (ADR-042).

### 1.4 `@media` bị hủy — ràng buộc nguy hiểm nhất

`juice()` chạy với `preserveMediaQueries: false`. **Mọi media query bị xóa khỏi HTML đã lưu.**

Hệ quả: yêu cầu "responsive email first-class" (§12 của brief Mailcraft) **không thể** thực hiện bằng media query dưới sanitizer hiện tại. Bản mobile phải đạt bằng kỹ thuật fluid/hybrid — bảng `width="100%"` kèm `max-width`, cột xếp chồng bằng `align` — hoặc phải sửa sanitizer. Xem §2.2.

Đây là điểm cần xác nhận **trước khi** thiết kế hệ thống block, vì nó quyết định cấu trúc HTML của mọi block.

### 1.5 Ảnh

`src` chỉ được là `https:` hoặc `cid:`. Ảnh `http:` và `data:` bị **xóa thuộc tính `src`**, giữ lại thẻ `<img>` rỗng kèm cảnh báo.

⇒ **Không nhúng base64.** Asset manager của Mailcraft bắt buộc phải trả về URL `https` thật. EOW hiện **chưa có** module lưu trữ asset — đây là phụ thuộc phải giải quyết trước khi Mailcraft dùng được ảnh upload.

Scheme cho `href`: `http` `https` `mailto` `tel` `cid`. Protocol-relative (`//example.com`) bị chặn.

### 1.6 Kích thước

- Cứng: **5 MB** HTML — vượt là từ chối lưu, không phải cắt bớt.
- Cảnh báo: từ **512 KB** (`HTML_SIZE_LARGE`).
- Độ lồng nhau tối đa: 100 cấp.

### 1.7 Cú pháp biến

Chỉ `{{ten_bien}}`. Key theo `[a-z][a-z0-9_]{0,63}`.

**Không hỗ trợ và sẽ bị từ chối lúc xuất bản:** helper (`{{formatDate x}}`), truy cập thuộc tính (`{{user.name}}`), biểu thức lồng nhau, điều kiện `{{#if}}`, vòng lặp `{{#each}}`.
Mã lỗi tương ứng: `UNSAFE_TEMPLATE_EXPRESSION`, `MALFORMED_TEMPLATE_SYNTAX`.

⇒ **Không thiết kế UI cho conditional content hay repeatable block dựa trên biến.** Nếu cần, đó là một quyết định sản phẩm phải bàn riêng, không phải tính năng prototype tự thêm.

Có giới hạn số biến trên một trường (`TEMPLATE_VARIABLE_LIMIT_EXCEEDED`). Biến chưa khai báo trong danh mục sẽ **chặn xuất bản** (`UNKNOWN_VARIABLE`), không chặn lưu nháp.

---

## 2. Ba xung đột giữa brief Mailcraft và EOW — ✅ đã chốt bởi ADR-037

> **Cập nhật 2026-08-31:** cả ba mục dưới đây đã có quyết định trong
> `docs/adr/adr-037-builder-template-allowlist-and-editor-placement.md`. Phần văn bản gốc
> được giữ nguyên làm bối cảnh, nhưng **ADR mới là thứ có hiệu lực** khi hai bên khác nhau:
>
> | Mục | Quyết định |
> |---|---|
> | 2.1 `border-radius` | **Mở allowlist.** ADR-037 mở cho một giá trị; **ADR-038 mở tiếp cho shorthand bốn góc**, nên inspector *được phép* có control bốn góc. |
> | 2.2 Responsive | **Hướng B** (fluid/hybrid) là mặc định duy nhất. Hướng A vẫn bị từ chối tới khi có spike kiểm chứng hộp thư; chưa có spike nào được lên lịch. |
> | 2.3 `id` | **Giữ nguyên loại bỏ.** Ánh xạ nằm hoàn toàn trong `project_data`. Anchor link nếu cần thì dùng `a[name]` (đã được phép sẵn) — và đó là quyết định sản phẩm riêng. |

Đây là các điểm brief 34 điểm yêu cầu nhưng hệ thống hiện tại sẽ phá.

### 2.1 `border-radius`

Brief §10 liệt kê `Border radius` là property của Button và Image. Sanitizer xóa nó.

Đề xuất: **mở rộng allowlist** để nhận `border-radius` — an toàn về bảo mật, chỉ cần kiểm giá trị theo đúng regex đang dùng. Nếu không mở, prototype phải bỏ property này khỏi inspector: hiển thị một control mà kết quả không tồn tại trong email còn tệ hơn không có.

### 2.2 Responsive bằng `@media`

Brief §12 yêu cầu desktop/mobile là first-class. `preserveMediaQueries: false` xóa sạch media query.

Hai hướng:
- **A.** Bật `preserveMediaQueries: true` và cho phép `<style>` tồn tại trong HTML đã lưu, giới hạn ở media query. Rủi ro: một số hộp thư bỏ `<style>` trong `<head>`; cần kiểm chứng bằng spike.
- **B.** Mailcraft xuất HTML fluid/hybrid không cần media query. Chắc chắn hơn, hạn chế hơn về bố cục.

Đề xuất: **B làm mặc định, A là mở rộng có kiểm chứng.** Quyết định này phải có trước khi thiết kế hệ thống cột.

### 2.3 Thuộc tính `id`

GrapesJS gán `id` cho component và tham chiếu bằng `#id` trong CSS. Sanitizer xóa `id`; `juice()` đã inline CSS trước đó nên phần style vẫn còn, nhưng mọi thứ dựa vào `id` sau khi lưu sẽ hỏng: anchor link nội bộ, và bất kỳ nỗ lực nào đọc ngược HTML để dựng lại cây component.

⇒ **Không dựa vào `id` để ánh xạ HTML ↔ project JSON.** Ánh xạ phải nằm trong project JSON, không nằm trong HTML. Hoặc đưa `id` vào allowlist nếu thực sự cần anchor link — nhưng đó phải là quyết định có chủ đích.

---

## 3. Cổng tích hợp — prototype phải tiêm, không hard-code

Prototype không được gọi thẳng API EOW, cũng không được nhúng dữ liệu mẫu vào component. Mọi dữ liệu đi qua provider tiêm từ ngoài. Đây là điều kiện để cùng một Mailcraft chạy được ở cả prototype (adapter mock) lẫn production (adapter EOW).

```ts
/** Bọc engine. UI không được gọi GrapesJS trực tiếp ở bất kỳ đâu. */
interface EmailEditorEngine {
  loadHtml(html: string): Promise<void>;
  getHtml(): Promise<string>;
  loadProjectData(data: unknown): Promise<void>;
  getProjectData(): Promise<unknown>;
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  setDevice(device: 'desktop' | 'mobile'): void;
  addBlock(blockId: string): void;
  on(event: 'change' | 'select', handler: (payload: unknown) => void): () => void;
}

/** Danh mục biến. EOW là nguồn duy nhất — không tự bịa danh sách. */
interface VariableProvider {
  list(): Promise<Array<{
    key: string;
    label: string;
    source: 'system' | 'global' | 'recipient' | 'template';
    required: boolean;
    defaultValue: string | null;
  }>>;
}

/** Ảnh và tệp. Bản prototype có thể chỉ nhận URL; chữ ký không đổi khi EOW có assets API. */
interface AssetProvider {
  list(query?: string): Promise<Asset[]>;
  upload(file: File): Promise<Asset>;
  remove(id: string): Promise<void>;
}

/** Lưu trữ. `etag` phục vụ optimistic concurrency — xem §5.7. */
interface ContentStore {
  load(): Promise<{ html: string; projectData: unknown | null; textBody: string; etag: string }>;
  save(input: { html: string; projectData: unknown; textBody: string; etag: string }): Promise<{ etag: string }>;
  publish(): Promise<{ version: number }>;
}

/** Render thật với dữ liệu mẫu. EOW đã có sẵn endpoint này. */
interface PreviewService {
  render(input: { html: string; sample: Record<string, string> }): Promise<{
    subject: string;
    html: string;
    missingKeys: string[];
  }>;
}

/** Kiểm tra nội dung. Trả đúng bộ mã ở §5.8, không tự định nghĩa bộ khác. */
interface LintService {
  check(input: { html: string; textBody: string }): Promise<LintIssue[]>;
}
```

---

## 4. Mô hình dữ liệu EOW mà UI phải phản ánh đúng

**Bốn scope biến**, hiển thị tách nhóm rõ ràng: `system` (mặc định hệ thống) · `global` (dùng chung) · `recipient` (dữ liệu người nhận) · `template` (riêng template này). Mỗi biến có `required` và `defaultValue`. Một số biến có `allowCampaignOverride` — chiến dịch được ghi đè giá trị cho lượt gửi đó.

**Bản text thuần** là một trường riêng song song với HTML, không phải suy ra lúc gửi. Prototype phải có chỗ cho nó — sinh tự động từ HTML cũng được, nhưng phải hiện ra để người dùng sửa được.

**Version bất biến.** Xuất bản tạo ra một version không sửa được: `PATCH /template-versions/:id` trả về `405 Method Not Allowed`, `DELETE` cũng vậy. Hệ quả cho UI Version History (brief §19):

- **Không có** nút "Sửa version này".
- "Restore" nghĩa là **tạo bản nháp mới từ nội dung version cũ**, không phải ghi đè version.
- Xóa version: không tồn tại.

**Trạng thái template:** `draft` · `published` · `archived`. Không có xóa cứng — chỉ lưu trữ.

---

## 5. Yêu cầu UI/UX riêng của EOW

Phần này bổ sung cho brief 34 điểm, không thay thế nó.

### 5.1 Sáu trạng thái bắt buộc cho mọi màn hình

`loading` · `empty` · `error` · `success` · `permission_denied` · `reconnecting` (khi có realtime).
Nguồn: `design-reference/ui-source-contract.yaml`.

**`permission_denied` là trạng thái hay bị bỏ quên nhất.** EOW có RBAC; quyền `content:manage` quyết định ai được sửa nội dung. Người không có quyền phải thấy editor ở **chế độ chỉ đọc có giải thích**, không phải màn hình trắng hay lỗi 403 thô.

### 5.2 Ba viewport bắt buộc

1440×900 · 768×1024 · 390×844. Nguồn: `design-reference/visual-acceptance.md`.

Brief §29 nói không cần ép editor đầy đủ lên điện thoại — đồng ý. Nhưng 390×844 vẫn phải được **thiết kế** thành chế độ đọc/preview tử tế, không phải để vỡ layout.

### 5.3 Dark mode: chrome theo theme, canvas thì không

EOW có `.theme-dark`. Nhưng canvas email **luôn nền sáng** kể cả trong dark mode — vì đó là email thật, không phải UI. EOW đã ép điều này trong `globals.css`. Mailcraft phải theo cùng quy tắc, nếu không người dùng sẽ thiết kế email trên nền tối rồi nhận về email nền sáng.

### 5.4 Design token phải map được

EOW dùng CSS custom properties: `--coral` (accent), `--line`, `--surface`, `--ink`, `--muted`, cùng thang radius/shadow. Mailcraft cứ dùng hệ token riêng, nhưng **khai báo tập trung ở một chỗ** để map sang token EOW khi tích hợp. Đừng rải giá trị màu cứng khắp component.

### 5.5 Biến trên canvas

Phải nhận diện được nhưng vẫn phản ánh gần đúng email cuối. EOW đang dùng nền vàng nhạt (`<mark>`) trên canvas và thay bằng giá trị mẫu ở preview. Giữ nhất quán để người dùng chuyển qua lại giữa hai sản phẩm không bị lạc.

Về cách chèn (brief §14 để mở): EOW hiện dùng panel bên phải, bấm để chèn tại con trỏ. Prototype thêm `/` hoặc `{` cũng tốt, nhưng **panel danh mục phải còn** — đó là chỗ duy nhất người dùng thấy được biến nào `required` và biến nào có giá trị mặc định.

### 5.6 Preview phải hiện `missingKeys`

Endpoint preview của EOW trả về danh sách key không có dữ liệu mẫu. Preview mà im lặng bỏ qua chúng là preview nói dối. Phải hiện rõ "thiếu dữ liệu mẫu cho: …".

### 5.7 Autosave cần trạng thái xung đột, không chỉ Saved/Saving/Failed

Brief §18 liệt kê Saved · Saving · Unsaved · Save failed. Thiếu một trạng thái mà EOW đã gặp thật:

> **Bản nháp đã bị thay đổi ở nơi khác** (một tab khác, hoặc một người khác).

EOW xử lý bằng optimistic concurrency: gửi kèm `etag`/`version`, server trả `409`, UI hiện màn so sánh cho người dùng chọn giữ bản của mình hay lấy bản trên máy chủ. Mailcraft phải thiết kế trạng thái này, không được lặng lẽ ghi đè.

### 5.8 Bộ mã lint — dùng đúng bộ này

`IMAGE_ALT_MISSING` · `LINK_TARGET_MISSING` · `LINK_PLACEHOLDER` · `LINK_INVALID` · `TEXT_BODY_EMPTY` · `HTML_SIZE_LARGE`. Tất cả ở mức `warning`, có `count` và `field`.

`LINK_PLACEHOLDER` bắt `#`, `javascript:void(0)`, `example.com`, `example.test`. ⇒ **Block mặc định của Mailcraft không được dùng `href="#"`** — mọi block mới kéo vào sẽ lập tức sinh cảnh báo. Dùng trạng thái "chưa đặt liên kết" tường minh thay vì `#`.

`href="{{ten_bien}}"` là **hợp lệ** — biến làm địa chỉ liên kết được chấp nhận.

`TEXT_BODY_EMPTY` chỉ xuất hiện khi request `POST /templates/analyze` **có gửi** trường `textBody` và giá trị rỗng (hoặc chỉ có khoảng trắng). Màn hình nào cho phép soạn bản văn bản thuần thì phải luôn gửi `textBody`, kể cả khi rỗng — bỏ trường này đi thì server phân tích trên bản text sinh tự động từ HTML và không có cảnh báo nào. Bản đã xuất bản vẫn luôn có phần text (server tự sinh khi publish), nên đây là cảnh báo về chất lượng nội dung, không phải lỗi chặn.

### 5.9 Tiếng Việt là ngôn ngữ chính

Toàn bộ copy tiếng Việt. Sắp xếp danh sách dùng `localeCompare(..., 'vi')`. Không thiết kế layout giả định độ dài chuỗi tiếng Anh — nhãn tiếng Việt thường dài hơn 20–40%.

### 5.10 Gửi thử cần chống trùng

EOW yêu cầu `Idempotency-Key` cho thao tác gửi thử. Nút "Gửi thử" phải khóa lại trong lúc chờ và tái sử dụng cùng một key khi thử lại, không sinh key mới mỗi lần bấm.

---

## 6. Checklist nghiệm thu prototype

**Đầu ra HTML**

- [ ] Xuất HTML dùng đúng tập tag ở §1.1; không có `<button>`, `<svg>`, `<form>`
- [ ] Không dựa vào `id` hoặc `data-*` để giữ ngữ nghĩa sau khi lưu
- [ ] Mọi style dùng đến nằm trong 27 thuộc tính ở §1.3, hoặc đã có quyết định mở rộng allowlist
- [ ] Không dùng `url()` ở bất kỳ đâu, kể cả lồng trong `linear-gradient()`; `background-image` chỉ được phép dạng gradient (ADR-042)
- [ ] Bố cục mobile không phụ thuộc `@media`, hoặc đã chốt hướng A ở §2.2
- [ ] Ảnh luôn là URL `https`, không base64
- [ ] Block mặc định không sinh `href="#"`
- [ ] HTML của một template thực tế dưới 512 KB

**Tích hợp**

- [ ] UI không gọi GrapesJS trực tiếp — mọi lời gọi qua `EmailEditorEngine`
- [ ] Biến, ảnh, lint, preview, lưu đều qua provider tiêm từ ngoài
- [ ] Chạy được với adapter mock (prototype) và adapter thật (production) mà không sửa component
- [ ] Có `getHtml()` trả về HTML đầy đủ độc lập với project JSON

**Mô hình sản phẩm**

- [ ] Biến chỉ dạng `{{key}}`; không có UI cho điều kiện / vòng lặp / helper
- [ ] Bốn scope biến hiển thị tách nhóm, có `required` và giá trị mặc định
- [ ] Có trường text thuần
- [ ] Version history không có "sửa version"; restore tạo bản nháp mới
- [ ] Preview hiện `missingKeys`

**Trạng thái & trải nghiệm**

- [ ] Đủ 6 trạng thái ở §5.1, đặc biệt `permission_denied` dạng chỉ đọc
- [ ] Đủ 3 viewport; 390px là chế độ đọc/preview được thiết kế
- [ ] Dark mode: chrome tối, canvas email luôn sáng
- [ ] Autosave có trạng thái xung đột kèm màn so sánh
- [ ] Lint hiển thị đúng 6 mã, bấm được để nhảy tới vị trí
- [ ] Toàn bộ copy tiếng Việt, sắp xếp theo `vi`
- [ ] Design token khai báo tập trung, map được sang token EOW

---

## Phụ lục — nguồn dẫn

| Ràng buộc | Tệp |
|---|---|
| Sanitizer, allowlist, juice, giới hạn 5 MB | `apps/api/src/templates/template-html-sanitizer.ts` |
| Bộ mã lint và ngưỡng 512 KB | `apps/api/src/templates/template-content-lint.ts` |
| Cú pháp biến, mã lỗi xuất bản | `apps/api/src/templates/template-variables.ts`, `apps/web/src/screens/templates/template-errors.ts` |
| Version bất biến (405) | `apps/api/src/templates/templates.controller.ts` |
| Trạng thái bắt buộc, viewport, quy tắc không tự ý redesign | `design-reference/ui-source-contract.yaml`, `design-reference/visual-acceptance.md` |
| Quyết định giữ HTML canonical độc lập editor JSON | `docs/adr/adr-019-email-visual-editor.md` |
| Không dùng GrapesJS — builder tự sở hữu model và emitter; FE-013 = `Rejected` | `docs/adr/adr-039-builder-owns-its-document-model-no-grapesjs.md` |
