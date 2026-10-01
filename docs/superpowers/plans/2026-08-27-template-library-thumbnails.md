# Template Library Thumbnails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Làm cho các thẻ trong thư viện template phân biệt được bằng mắt — thay hình vẽ trang trí cứng bằng chính HTML của template, render thu nhỏ.

**Architecture:** `GET /templates` bỏ `html` và `textBody` khỏi phản hồi, nên danh sách nhẹ đi. Mỗi thẻ tự nạp template đầy đủ qua `GET /templates/:id` **khi lọt vào tầm nhìn** (`IntersectionObserver`), rồi render trong `<iframe sandbox="" srcDoc>` rộng cố định 640px và `transform: scale()` thu vào khung thẻ. HTML quá lớn, nạp lỗi hoặc thiếu observer thì hạ xuống poster nhẹ — chính là mockup hiện tại, giữ lại làm fallback.

**Tech Stack:** NestJS + TypeORM (api), React 18 + TypeScript (web), Vitest, OpenAPI contract.

**Spec:** `docs/superpowers/specs/2026-08-26-template-editor-layout-and-thumbnails-design.md` §1.2, §5.

---

## Bối cảnh bắt buộc đọc trước

**Máy này thiếu RAM, và điều đó quyết định cách bạn chạy test.** Máy có 15.9 GB. Với đủ 8 container của `pnpm deploy:up` cộng trình duyệt, RAM trống tụt xuống ~0.7 GB và các test spawn tiến trình hoặc container bắt đầu hết giờ — sáu lần trong đợt trước, mỗi lần một test khác, không lần nào liên quan tới mã đang sửa. Cách chạy đúng:

```bash
pnpm infra:up
```

Chỉ dựng postgres, redis, mailpit. `apps/api` và `apps/worker` nối tới Postgres ở `127.0.0.1:55432` nên **cần** ba container này; `packages/architecture-tests` thì cần càng ít càng tốt. `infra:up` là cấu hình duy nhất thoả cả hai. Đóng Browser pane trước khi chạy `pnpm check`.

Nếu một test hết giờ: chạy lại **riêng tệp đó** trước khi điều tra. `boot.test.ts` mất 22s trên trần 30s — biên 8 giây, là mắt xích đứt tiếp theo.

**`pnpm --filter <pkg> test -- <tên>` KHÔNG lọc.** Dạng đúng là `pnpm --filter @eow/api test templates-http`.

**Không tin exit code.** Ghi `echo "PNPM_EXIT=$?" >> "$LOG"` vào log rồi đọc lại, và đừng `| tail -N` một lần chạy `pnpm -r` — mỗi package in một khối tổng kết riêng, tail chỉ cho bạn thấy khối cuối.

**Mốc xanh đầy đủ tại `3ddbada`: 1414 test / 227 tệp** (1397 của `be6fc36` cộng 17 test của module dọn fixture).

## File Structure

| Tệp | Trách nhiệm |
|---|---|
| `apps/api/src/templates/templates.service.ts` | Thêm `TemplateSummaryResponse` + `templateSummaryResponse()`; `list()` trả kiểu mới |
| `contracts/openapi.yaml` | Thêm schema `TemplateSummary`; `TemplateListResponse` trỏ vào nó |
| `apps/web/src/api/templates.ts` | Thêm `EmailTemplateSummary`; `listTemplates` trả kiểu mới |
| `apps/web/src/screens/templates/template-thumbnail.ts` + test | Hàm thuần quyết định `thumbnail \| poster`. Không DOM, test độc lập |
| `apps/web/src/screens/templates/TemplateThumbnail.tsx` | Component: mount lười, nạp theo id, iframe thu nhỏ, fallback poster |
| `apps/web/src/screens/templates/TemplatesScreen.tsx` | Thay ruột `.template-preview` bằng component trên |
| `apps/web/src/app/globals.css` | **Chỉ append** rule mới cho khung thumbnail |

---

### Task 1: Hàm thuần quyết định thumbnail hay poster

**Files:**
- Create: `apps/web/src/screens/templates/template-thumbnail.ts`
- Test: `apps/web/src/screens/templates/template-thumbnail.test.ts`

- [ ] **Step 1: Viết test đỏ**

Tạo `apps/web/src/screens/templates/template-thumbnail.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { THUMBNAIL_MAX_HTML_BYTES, thumbnailMode } from './template-thumbnail.js';

describe('template thumbnail mode', () => {
  it('waits while the template has not been fetched yet', () => {
    expect(thumbnailMode({ html: null, failed: false, observerAvailable: true })).toBe('pending');
  });

  it('renders the real html once it arrives', () => {
    expect(thumbnailMode({ html: '<p>Xin chào</p>', failed: false, observerAvailable: true })).toBe('thumbnail');
  });

  it('falls back to the poster when the fetch failed', () => {
    expect(thumbnailMode({ html: null, failed: true, observerAvailable: true })).toBe('poster');
  });

  it('falls back to the poster for html past the size ceiling', () => {
    const huge = 'x'.repeat(THUMBNAIL_MAX_HTML_BYTES + 1);
    expect(thumbnailMode({ html: huge, failed: false, observerAvailable: true })).toBe('poster');
  });

  it('falls back to the poster with no IntersectionObserver, before any fetch', () => {
    expect(thumbnailMode({ html: null, failed: false, observerAvailable: false })).toBe('poster');
  });

  it('measures bytes, not characters, so Vietnamese text is not undercounted', () => {
    const nearLimit = 'ế'.repeat(THUMBNAIL_MAX_HTML_BYTES / 2);
    expect(thumbnailMode({ html: nearLimit, failed: false, observerAvailable: true })).toBe('poster');
  });
});
```

- [ ] **Step 2: Chạy để xác nhận nó đỏ**

```bash
pnpm --filter @eow/web test template-thumbnail
```

Kỳ vọng: FAIL — không tìm thấy module `./template-thumbnail.js`.

- [ ] **Step 3: Viết cài đặt tối thiểu**

Tạo `apps/web/src/screens/templates/template-thumbnail.ts`:

```ts
/**
 * Cùng ngưỡng với `HTML_SIZE_LARGE` trong
 * apps/api/src/templates/template-content-lint.ts. Dùng lại con số server đã
 * coi là "lớn" thay vì bịa một hằng số thứ hai cho cùng một khái niệm.
 */
export const THUMBNAIL_MAX_HTML_BYTES = 512 * 1024;

export type ThumbnailMode = 'pending' | 'thumbnail' | 'poster';

/**
 * Một thẻ trong thư viện chỉ có ba trạng thái: chưa có HTML (đang chờ lọt vào
 * tầm nhìn hoặc đang nạp), có HTML và render được, hoặc phải hạ xuống poster.
 *
 * Tách khỏi component để test được mà không cần DOM, IntersectionObserver hay
 * mạng — đó cũng là ba thứ khiến nhánh fallback khó kiểm nhất.
 */
export function thumbnailMode(input: {
  html: string | null;
  failed: boolean;
  observerAvailable: boolean;
}): ThumbnailMode {
  if (input.failed || !input.observerAvailable) return 'poster';
  if (input.html === null) return 'pending';
  return new TextEncoder().encode(input.html).length > THUMBNAIL_MAX_HTML_BYTES ? 'poster' : 'thumbnail';
}
```

- [ ] **Step 4: Chạy lại**

```bash
pnpm --filter @eow/web test template-thumbnail
```

Kỳ vọng: PASS, 6 test.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/screens/templates/template-thumbnail.ts apps/web/src/screens/templates/template-thumbnail.test.ts
git commit -m "feat(web): decide thumbnail or poster without touching the DOM"
```

---

### Task 2: Projection nhẹ cho `GET /templates`

**Files:**
- Modify: `apps/api/src/templates/templates.service.ts`
- Modify: `contracts/openapi.yaml`
- Test: `apps/api/test/integration/templates-http.test.ts`

- [ ] **Step 1: Viết test đỏ**

Thêm vào `apps/api/test/integration/templates-http.test.ts`, bên trong describe đã có:

```ts
  it('keeps html and textBody out of the library listing but not out of the detail', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/templates')
      .set('Cookie', cookieHeader).set('x-csrf-token', csrfToken)
      .send({ name: `Projection ${Date.now()}`, subject: 'Tiêu đề', html: '<p>Xin chào</p>' })
      .expect(201);

    const list = await request(app.getHttpServer())
      .get('/api/v1/templates').set('Cookie', cookieHeader).expect(200);
    const listed = list.body.items.find((item: { id: string }) => item.id === created.body.id);

    expect(listed).toBeDefined();
    expect(listed).not.toHaveProperty('html');
    expect(listed).not.toHaveProperty('textBody');
    // Everything the library actually renders must survive the projection.
    expect(listed.name).toBe(created.body.name);
    expect(listed.subject).toBe('Tiêu đề');
    expect(listed.status).toBe('draft');
    expect(listed.updatedAt).toBeDefined();

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/templates/${created.body.id}`).set('Cookie', cookieHeader).expect(200);
    expect(detail.body.html).toContain('Xin chào');
    expect(detail.body).toHaveProperty('textBody');
  });
```

- [ ] **Step 2: Chạy để xác nhận nó đỏ**

```bash
pnpm --filter @eow/api test templates-http
```

Kỳ vọng: FAIL ở `expect(listed).not.toHaveProperty('html')` — hiện `html` vẫn có trong danh sách.

- [ ] **Step 3: Thêm kiểu và mapper**

Trong `apps/api/src/templates/templates.service.ts`, thêm ngay sau khai báo `TemplateResponse` (kết thúc bằng `latestVersionId: string | null;\n};`):

```ts
/**
 * Library-list shape: everything the grid renders, minus the two fields that
 * carry the content itself. `html` alone is capped at 5 MB per template and the
 * three callers of this endpoint all pass `limit: 100`, so shipping it made the
 * listing scale with content size rather than with row count. Same reasoning as
 * `TemplateVersionSummary` above. The thumbnail fetches `GET /templates/:id`
 * for the cards actually on screen instead.
 */
export type TemplateSummaryResponse = Omit<TemplateResponse, 'html' | 'textBody'>;
```

Thêm mapper ngay sau hàm `templateResponse`:

```ts
function templateSummaryResponse(template: EmailTemplateEntity, latestVersionId: string | null): TemplateSummaryResponse {
  const { html: _html, textBody: _textBody, ...summary } = templateResponse(template, latestVersionId);
  return summary;
}
```

- [ ] **Step 4: Đổi `list()` sang mapper mới**

Trong cùng tệp, sửa chữ ký và thân của `list` (hiện ở dòng 134):

```ts
  async list(tenantId: string, query: TemplateListQueryDto): Promise<{ items: TemplateSummaryResponse[] }> {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const templates = await new TemplatesRepository(manager, tenantId).list(query);
      const latestIds = await new TemplateVersionsRepository(manager, tenantId).findLatestIdsByTemplateIds(templates.map((template) => template.id));
      return { items: templates.map((template) => templateSummaryResponse(template, latestIds.get(template.id) ?? null)) };
    });
  }
```

- [ ] **Step 5: Cập nhật contract**

Trong `contracts/openapi.yaml`, thêm schema mới ngay **trước** `TemplateListResponse:` (dòng 1570):

```yaml
    TemplateSummary:
      type: object
      required: [id, name, status, origin, draftRevision, subject, validation, createdAt, updatedAt, latestVersionId]
      description: >-
        Template metadata for the library grid. Deliberately omits html and textBody:
        html alone is capped at 5 MB per template, so including it made the listing
        scale with content size rather than row count. Fetch GET /templates/{id} for
        the content of a single template.
      properties:
        id: {type: string, format: uuid}
        name: {type: string}
        status: {type: string, enum: [draft, published, archived]}
        origin: {type: string, enum: [imported, builder]}
        draftRevision: {type: integer, minimum: 1}
        subject: {type: string}
        validation: {$ref: '#/components/schemas/TemplateValidation'}
        createdAt: {type: string, format: date-time}
        updatedAt: {type: string, format: date-time}
        latestVersionId: {type: string, format: uuid, nullable: true}
```

Rồi đổi `TemplateListResponse` để trỏ vào nó:

```yaml
    TemplateListResponse:
      type: object
      required: [items]
      properties: {items: {type: array, items: {$ref: '#/components/schemas/TemplateSummary'}}}
```

Kiểm `TemplateValidation` là tên schema đúng trong tệp; nếu `Template` khai báo `validation` theo cách khác thì chép **đúng** cách đó sang, đừng bịa một hình dạng mới.

- [ ] **Step 6: Chạy lại test API**

```bash
pnpm --filter @eow/api test templates-http
```

Kỳ vọng: PASS.

- [ ] **Step 7: Chạy compat-check**

```bash
pnpm contracts:compat-check
```

Kỳ vọng: **báo cáo breaking change** — `html` và `textBody` bị gỡ khỏi `required` của phản hồi danh sách. Đây là thay đổi có chủ đích. Đọc báo cáo và xác nhận **không có** thay đổi ngoài dự kiến nào khác. Nếu nó báo "No breaking OpenAPI changes detected" thì bạn đã sửa contract sai chỗ — `TemplateListResponse` vẫn đang trỏ vào `Template`.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/templates/templates.service.ts contracts/openapi.yaml apps/api/test/integration/templates-http.test.ts
git commit -m "feat(api): drop html and textBody from the template library listing"
```

---

### Task 3: Kiểu danh sách phía web

**Files:**
- Modify: `apps/web/src/api/templates.ts`

- [ ] **Step 1: Thêm kiểu và đổi chữ ký**

Trong `apps/web/src/api/templates.ts`, thêm ngay sau khai báo `EmailTemplate`:

```ts
/** Library-list shape. The server no longer sends content in the listing -- see TemplateSummary in the contract. */
export type EmailTemplateSummary = Omit<EmailTemplate, 'html' | 'textBody'>;
```

Đổi `listTemplates` (dòng 75):

```ts
export function listTemplates(query: TemplateQuery = {}): Promise<{ items: EmailTemplateSummary[] }> {
```

- [ ] **Step 2: Typecheck để tìm mọi nơi lỡ đọc `html` từ danh sách**

```bash
pnpm --filter @eow/web exec tsc --noEmit
```

Kỳ vọng: **có thể có lỗi**, và đó là mục đích. Ba nơi gọi `listTemplates` được kiểm ở đợt thiết kế và chỉ đọc `name`/`subject`/`status`/`updatedAt`, nhưng typecheck là lưới thật chứ không phải trí nhớ của tôi. Nếu có lỗi, sửa nơi gọi để nạp chi tiết khi thực sự cần nội dung — **đừng** nới kiểu lại cho hết lỗi.

Ghi chú: `TemplatesScreen` truyền `template` vào `TemplatePreviewOverlay`, mà overlay đó gọi endpoint preview chứ không đọc `template.html`. Nếu tsc phàn nàn ở đó thì thu hẹp prop của overlay xuống `EmailTemplateSummary`.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/api/templates.ts
git commit -m "feat(web): type the template listing without its content"
```

---

### Task 4: Component thumbnail

**Files:**
- Create: `apps/web/src/screens/templates/TemplateThumbnail.tsx`

- [ ] **Step 1: Viết component**

Tạo `apps/web/src/screens/templates/TemplateThumbnail.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import { getTemplate } from '../../api/templates.js';
import { thumbnailMode } from './template-thumbnail.js';

/** Email render width the thumbnail is laid out at before scaling. Fixed so every card shares one scale. */
const THUMBNAIL_WIDTH = 640;
const FETCH_TIMEOUT_MS = 5000;

/** Cached per template id: the grid remounts cards on search and filter, and the content does not change under it. */
const htmlCache = new Map<string, string>();

/**
 * The card's visual: the template's own HTML, rendered small.
 *
 * Loaded lazily because a library of 100 templates would otherwise open 100
 * iframes and fetch 100 bodies for the four cards on screen. Rendered in a
 * fully sandboxed frame -- `sandbox=""` grants nothing back, and the HTML was
 * sanitized on save -- which is the same containment the editor preview uses.
 */
export function TemplateThumbnail({ templateId, poster }: { templateId: string; poster: React.ReactNode }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [html, setHtml] = useState<string | null>(() => htmlCache.get(templateId) ?? null);
  const [failed, setFailed] = useState(false);
  const [scale, setScale] = useState(0);
  const observerAvailable = typeof IntersectionObserver !== 'undefined';

  // CSS cannot derive the ratio between the card and a fixed 640px layout width,
  // so the scale is measured here and re-measured when the grid reflows.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const measure = () => setScale(host.clientWidth / THUMBNAIL_WIDTH);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const resize = new ResizeObserver(measure);
    resize.observe(host);
    return () => resize.disconnect();
  }, []);

  useEffect(() => {
    if (!observerAvailable || html !== null) return;
    const host = hostRef.current;
    if (!host) return;

    let cancelled = false;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      const timer = setTimeout(() => { if (!cancelled) setFailed(true); }, FETCH_TIMEOUT_MS);
      getTemplate(templateId)
        .then((template) => {
          clearTimeout(timer);
          if (cancelled) return;
          htmlCache.set(templateId, template.html);
          setHtml(template.html);
        })
        .catch(() => { clearTimeout(timer); if (!cancelled) setFailed(true); });
    });
    observer.observe(host);
    return () => { cancelled = true; observer.disconnect(); };
  }, [templateId, html, observerAvailable]);

  const mode = thumbnailMode({ html, failed, observerAvailable });
  return <div className="template-thumbnail" ref={hostRef}>
    {mode === 'thumbnail' && html !== null
      ? <iframe
          className="template-thumbnail-frame"
          title=""
          aria-hidden="true"
          tabIndex={-1}
          sandbox=""
          scrolling="no"
          srcDoc={html}
          style={{ width: THUMBNAIL_WIDTH, height: THUMBNAIL_WIDTH, transform: `scale(${String(scale)})` }}
        />
      : poster}
  </div>;
}
```

`height` bằng `THUMBNAIL_WIDTH` cho khung một tỉ lệ vuông trước khi bị `overflow:hidden` của thẻ cắt xuống đúng chiều cao thẻ. Khung được đặt tuyệt đối bên trong `.template-preview`, vốn đã là `position:relative` sẵn trong `globals.css` — không cần đụng rule đó.

Ba điểm có chủ đích, đừng "sửa lại cho gọn":
- `aria-hidden` + `title=""` + `tabIndex={-1}`: thumbnail là trang trí. Thẻ bọc nó đã có `aria-label` mang tên template, và một iframe đọc được sẽ khiến trình đọc màn hình duyệt qua toàn bộ nội dung email cho **mỗi** thẻ.
- `mode === 'pending'` cũng render `poster`. Ô trống nhấp nháy trước khi ảnh về trông như lỗi; poster là trạng thái chờ tử tế.
- Cache là `Map` cấp module, không phải state. Lưới remount thẻ mỗi lần tìm kiếm hay đổi bộ lọc, và nội dung không đổi dưới chân nó.

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @eow/web exec tsc --noEmit
```

Kỳ vọng: không lỗi.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/screens/templates/TemplateThumbnail.tsx
git commit -m "feat(web): render the template's own html as its card thumbnail"
```

---

### Task 5: Nối vào thư viện và thêm CSS

**Files:**
- Modify: `apps/web/src/screens/templates/TemplatesScreen.tsx`
- Modify: `apps/web/src/app/globals.css` (**chỉ append**)

- [ ] **Step 1: Bọc mockup thành poster**

Trong `TemplatesScreen.tsx`, tìm nút `.template-preview` của thẻ thật (nút có `aria-label={`Xem trước template ${template.name}`}`). Nội dung hiện tại của nó bắt đầu bằng `<small className="template-sample-label">HTML TEMPLATE</small>`.

Thay các phần tử mockup — `<small className="template-sample-label">`, `<span className="template-preview-brand">`, `<h3>`, `<p>`, và hai `<i />` — bằng:

```tsx
<TemplateThumbnail templateId={template.id} poster={<>
  <small className="template-sample-label">HTML TEMPLATE</small>
  <span className="template-preview-brand">EMAIL</span>
  <h3>{template.name}</h3>
  <p>{template.subject || 'Chưa có tiêu đề'}</p>
  <i /><i />
</>} />
```

`<span className="template-hover-layer">` ở cuối nút **giữ nguyên tại chỗ**, ngoài `TemplateThumbnail` — nó là lớp hover của thẻ, không phải một phần của ảnh.

Thêm import ở đầu tệp:

```tsx
import { TemplateThumbnail } from './TemplateThumbnail.js';
```

- [ ] **Step 2: Append CSS**

Thêm vào **cuối** `apps/web/src/app/globals.css`:

```css
/* Library thumbnail: the template's own HTML laid out at 640px and scaled into
   the card. transform-origin keeps the top-left corner pinned so every card
   shows the same part of its email. The frame is inert -- pointer events belong
   to the card button underneath it, which is what opens the preview.
   ARCH-HANDOFF: appended rules, no approved line is edited. */
.template-thumbnail{position:absolute;inset:0;overflow:hidden;background:#fff}
.template-thumbnail-frame{border:0;transform-origin:top left;pointer-events:none;background:#fff;display:block}
.theme-dark .template-thumbnail,.theme-dark .template-thumbnail-frame{background:#fff}
```

`background:#fff` lặp lại trong nhánh dark mode là có chủ ý: canvas email luôn nền sáng kể cả khi giao diện tối, theo §5.3 của `mailcraft-integration-requirements.md`.

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter @eow/web exec tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/screens/templates/TemplatesScreen.tsx apps/web/src/app/globals.css
git commit -m "feat(web): show real template thumbnails in the library grid"
```

---

### Task 6: Kiểm chứng tự động

**Files:** không sửa gì.

- [ ] **Step 1: Chuẩn bị môi trường**

```bash
pnpm infra:up
```

Đóng Browser pane nếu đang mở.

- [ ] **Step 2: Chạy `pnpm check` và đọc số**

```bash
pnpm check
```

Ghi log ra tệp với đường dẫn tuyệt đối và `echo "PNPM_EXIT=$?" >> "$LOG"`. Đọc số `Test Files` / `Tests` của **cả bảy** package.

Kỳ vọng: `PNPM_EXIT=0`, tổng **1421 test / 228 tệp** — mốc `3ddbada` là 1414/227, cộng 6 test của Task 1 (một tệp mới) và 1 test của Task 2 (tệp đã có). Lệch số nghĩa là có gì đó ngoài dự kiến; đọc kỹ trước khi đi tiếp.

- [ ] **Step 3: Chạy architecture tests nếu chưa nằm trong bước trên**

`pnpm check` đã bao gồm `packages/architecture-tests`. Xác nhận `ARCH-HANDOFF` (`handoff-fidelity.test.ts`) xanh — bạn vừa đụng `globals.css`.

---

### Task 7: Cổng nghiệm thu trên ứng dụng thật

**Files:** không sửa gì.

Đây là task quyết định. Vấn đề ở §1.2 của spec — mọi thẻ trông giống nhau — **không một test nào bắt được**, vì markup vẫn hợp lệ và mọi assertion vẫn xanh. Nó chỉ lộ ra khi đo DOM thật.

- [ ] **Step 1: Dựng app**

```bash
pnpm deploy:up
```

Mở `http://localhost:8080/templates`, đăng nhập `admin@example.test` / `Admin@123`.

**Nếu vừa rebuild mà giao diện không đổi:** trình duyệt đang phục vụ bundle cũ. Thêm `?cachebust=1` vào URL. Và kiểm container có mới không: `docker ps --format "{{.Names}}\t{{.RunningFor}}"` — nếu nó già hơn commit của bạn thì bạn đang nhìn bản cũ, không phải bản vừa sửa.

- [ ] **Step 2: Đo — các thẻ có còn giống hệt nhau không**

Chạy trong console, cần ít nhất 2 template có HTML khác nhau:

```js
(()=>{
 const cards=[...document.querySelectorAll('.template-card .template-preview')];
 return {
  cardCount:cards.length,
  distinctShells:new Set(cards.map(c=>c.innerHTML.replace(/<h3>.*?<\/h3>|<p>.*?<\/p>/g,''))).size,
  cardsWithFrame:cards.filter(c=>c.querySelector('iframe')).length
 };
})()
```

| Chỉ số | Trước khi sửa | Ngưỡng đạt |
|---|---|---|
| `distinctShells` | **1** (giống hệt từng byte) | **= `cardCount`** |
| `cardsWithFrame` | 0 | = số thẻ đang trong tầm nhìn |

- [ ] **Step 3: Đo — danh sách có còn tải nội dung không**

```js
performance.getEntriesByType('resource')
  .filter(r=>/\/api\/v1\/templates(\?|$)/.test(r.name))
  .map(r=>({url:r.name.slice(-40),bytes:r.transferSize}))
```

Phản hồi danh sách phải nhỏ hơn hẳn trước đây, và **không** chứa HTML. Xác nhận thêm:

```js
fetch('/api/v1/templates?limit=5').then(r=>r.json())
  .then(d=>({firstItemKeys:Object.keys(d.items[0]||{}), hasHtml:'html' in (d.items[0]||{})}))
```

Kỳ vọng: `hasHtml: false`.

- [ ] **Step 4: Kiểm mount lười**

Nếu thư viện có nhiều hơn một màn hình thẻ: đếm số iframe trước và sau khi cuộn xuống. Số phải **tăng** — nếu mọi thẻ đều có iframe ngay từ đầu thì `IntersectionObserver` chưa hoạt động và tính năng đang nạp toàn bộ thư viện.

- [ ] **Step 5: Kiểm poster fallback**

DevTools → Network → chặn `/api/v1/templates/*` (chỉ route chi tiết, không chặn route danh sách). Tải lại. Trong vòng 5 giây mọi thẻ phải hạ xuống poster mockup — **không** ô trống, không màn lỗi.

- [ ] **Step 6: Kiểm ba khổ màn hình**

1440×900 · 768×1024 · 390×844. Thumbnail phải giữ đúng tỉ lệ, không tràn khỏi thẻ, và `document.documentElement.scrollWidth > innerWidth` phải là `false` ở cả ba.

- [ ] **Step 7: Kiểm chế độ chỉ đọc**

Thư viện giờ có hai chế độ. Tạo một tài khoản viewer để kiểm — nó phải có `content:read` mà **không** có `content:manage`:

```sql
INSERT INTO app_user (tenant_id, email, display_name, role, password_hash, status)
SELECT u.tenant_id, 'viewer-check@example.test', 'Viewer Check', 'viewer', u.password_hash, 'active'
FROM app_user u WHERE u.email='admin@example.test' LIMIT 1;

INSERT INTO user_role (tenant_id, user_id, role_id, assigned_at)
SELECT u.tenant_id, u.id, r.id, now()
FROM app_user u, role r WHERE u.email='viewer-check@example.test' AND r.key='viewer';
```

Mật khẩu giống admin vì hash được chép sang. Đăng nhập bằng tài khoản đó và xác nhận thumbnail vẫn render — chúng là nội dung chỉ đọc nên **không** được gating — trong khi Import, drop-zone và Gửi thử vẫn ẩn.

Xoá tài khoản sau khi xong, đúng thứ tự phụ thuộc khoá ngoại:

```sql
DELETE FROM user_session WHERE user_id IN (SELECT id FROM app_user WHERE email='viewer-check@example.test');
DELETE FROM user_role   WHERE user_id IN (SELECT id FROM app_user WHERE email='viewer-check@example.test');
DELETE FROM app_user    WHERE email='viewer-check@example.test';
```

- [ ] **Step 8: Kiểm dark mode**

Bật dark mode. Chrome tối đi nhưng **thumbnail phải giữ nền sáng** — đó là email thật, không phải giao diện.

- [ ] **Step 9: Push**

Chỉ push sau khi mọi ngưỡng ở Step 2–8 đều đạt.

```bash
git push origin main
```

---

## Rủi ro

| Rủi ro | Giảm thiểu |
|---|---|
| N iframe làm chậm lưới | Mount lười theo tầm nhìn, cache theo id, hạ xuống poster khi HTML > 512 KB |
| Ảnh `https` trong template sinh request thật cho mỗi thẻ | Chỉ thẻ trong tầm nhìn mới render; chấp nhận, và đo lại ở Step 4 |
| Bỏ `html` khỏi danh sách phá nơi gọi ngoài dự kiến | Typecheck ở Task 3 Step 2 là lưới thật; compat-check là lưới thứ hai |
| Thumbnail lọt vào cây trợ năng, đọc cả nội dung email mỗi thẻ | `aria-hidden` + `title=""` + `tabIndex={-1}`; nhãn nằm ở nút bọc ngoài |
| Sửa `globals.css` vi phạm `ARCH-HANDOFF` | Chỉ append; `git diff` phải không có dòng nào bị đổi |

## Ngoài phạm vi

Ảnh chụp phía máy chủ · assets API · phân trang thư viện · thay biến bằng giá trị mẫu trong thumbnail (biến hiện nguyên văn `{{ten_bien}}`, đã ghi rõ ở §5.2 của spec) · ba quyết định sanitizer của Mailcraft.
