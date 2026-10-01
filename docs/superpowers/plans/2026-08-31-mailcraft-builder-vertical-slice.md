# Mailcraft Builder — Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Một người phụ trách nhân sự mở Mailcraft từ trong EOW, kéo-thả dựng xong email, lưu, xuất bản một version bất biến, rồi chọn đúng version đó trong một chiến dịch — không rời khỏi `apps/web`, không đăng nhập lần hai.

**Architecture:** Mailcraft là **route trong `apps/web`**, không phải app riêng và không iframe (ADR-037 §4, ADR-009, ADR-041). Editor nói chuyện với hệ thống qua `editor-ports.ts` đã có sẵn; **model tài liệu và emitter là của chính ta** (ADR-039 — không dùng GrapesJS), bọc sau một port mới `EmailEditorEngine` để không component nào gọi thẳng chúng. Backend không học khái niệm "builder": `project_data` là JSON mờ đi kèm draft, còn `draftHtml` vẫn là bản ghi duy nhất dùng để render và gửi (ADR-019).

**Tech Stack:** NestJS + TypeORM + Postgres (api), React 19 + react-router-dom 7 + Vite (web), Vitest cho unit/integration, Playwright cho e2e. **Không thêm phụ thuộc editor nào** — ADR-039.

**Spec:** `docs/superpowers/specs/2026-08-31-mailcraft-builder-screen-design.md` — bức tranh toàn cảnh và **toàn bộ quy ước màn hình**. Đọc §2 trước khi viết bất kỳ dòng UI nào; plan này chỉ tách task, không lặp lại quy ước.

**Quyết định nền:** ADR-037 (allowlist + vị trí), **ADR-038** (CSS nhiều giá trị), **ADR-039** (không GrapesJS), **ADR-040** (`display`/`max-height`/`overflow`), **ADR-041** (focus mode + URL)
**Kiểm kê khối:** `docs/superpowers/specs/2026-09-01-builder-block-sanitizer-audit.md` — đọc trước Task 5
**Ràng buộc kỹ thuật:** `docs/frontend/mailcraft-integration-requirements.md`
**Định hướng sản phẩm:** `docs/frontend/mailcraft-design-direction.md`
**Tham chiếu UI (ngoài repo, chỉ đọc):** `../mailcraft-ui-handoff-v1/ui/`

---

## Bối cảnh bắt buộc đọc trước

**Bốn trong sáu port đã tồn tại — đừng thiết kế lại.** `apps/web/src/screens/templates/editor-ports.ts` đã khai báo `ContentStore`, `VariableProvider`, `PreviewService`, `LintService`, và chú thích đầu tệp đã nói rõ nó tồn tại để `origin: 'builder'` sau này cắm vào mà màn hình không phải biết. Việc cần làm là **thêm** `EmailEditorEngine`, không phải dựng bộ contract mới. `AssetProvider` chưa có, và MC-UI-005 (`upload`/`replace`/`bind`/`mark_decorative`) **bắt buộc phải có nó** — sanitizer chỉ nhận `https:`/`cid:`, không base64. Đây là **phụ thuộc phải làm ở S6**, không phải mục được phép bỏ.

**`projectData` có cột DB nhưng chưa có đường ra contract.** `email_template.project_data` tồn tại từ migration 071 và có trên entity, nhưng `TemplateResponse` (`templates.service.ts:30`) không trả nó, `contracts/openapi.yaml` không khai báo nó, và `updateTemplateSchema` là `.strict()` (`dto/template.dto.ts:22`) nên gửi `projectData` lên hôm nay bị **400**, không phải bị bỏ qua. Đây là việc nối dây, không phải quyết định kiến trúc — quyết định đã nằm ở comment trên `email-template.entity.ts:39-40`.

**Không cần migration mới cho S1.** Cột đã có. Tránh được bẫy `migrations.lock.json` (xem dưới) là một lý do để giữ S1 đúng phạm vi này.

**`ARCH-MIGRATION` không tự chúc phúc lock file.** `packages/architecture-tests/src/migration-immutability.test.ts` so từng SHA-256 với `database/migrations.lock.json` và fail ở bất kỳ khác biệt nào. Slice nào có migration thì hash phải tính và dán tay trong cùng commit.

**`412`, không phải `409`, là mã xung đột của codebase này.** `templates.service.ts:214` đã ném `412` khi `draftRevision` lệch, và `expectedRevision()` ở `templates.controller.ts:23-26` ném `428` khi thiếu `If-Match`. Builder phải dùng đúng đường này, không tự định nghĩa cơ chế khác.

**Máy này thiếu RAM.** Dùng `pnpm infra:up` (chỉ postgres/redis/mailpit), không dựng đủ 8 container. Đóng Browser pane trước khi chạy `pnpm check`.

**`pnpm --filter <pkg> test -- <tên>` KHÔNG lọc.** Dạng đúng: `pnpm --filter @eow/api test templates-http`.

**Không tin exit code.** Ghi `echo "PNPM_EXIT=$?" >> "$LOG"` rồi đọc lại; đừng `| tail -N` một lần chạy `pnpm -r`.

**`pnpm -r` dừng ở workspace fail đầu tiên — các workspace sau *không chạy*.** Một lần check có api fail đã khiến `web` (259 test) và `worker` (162 test) không chạy, mà nhìn log thì tưởng đã chạy. Luôn kiểm từng workspace đã thực sự chạy chưa, hoặc chạy riêng từng cái.

**Suite api chập chờn dưới tải.** Hai lần chạy đầy liên tiếp, mỗi lần một test tích hợp *khác nhau* fail (`boot.test.ts`, rồi `auth-http.test.ts`), **cả hai đều pass khi chạy riêng**. `vitest.shared.ts` đã ghi sẵn `"Process did not exit within the timeout"` là chữ ký CPU quá tải chứ không phải lỗi thật. Test tích hợp nào fail thì **chạy riêng file đó trước khi kết luận**.

**Nhiều phiên Claude sửa chung một checkout.** File chưa commit có thể đổi giữa chừng. Trước khi `git apply` bất cứ patch nào, kiểm `git status`; nếu `apply --check` fail vì phiên khác đang sửa đúng file đó thì **bàn giao phần việc kèm lý do**, đừng ép patch — ép là xoá mất việc đang chạy. Verify việc của phiên khác bằng cách đọc code và chạy lại test, không dựa vào báo cáo. Push sau mỗi trạng thái mạch lạc đã test.

---

## Bản đồ slice

| Slice | Nội dung | Workspace Mailcraft phủ | Trạng thái |
|---|---|---|---|
| **S1** | `projectData` qua contract + allowlist | — | ✅ xong |
| **S2** | `EmailEditorEngine` + model/emitter | — | ✅ xong |
| **S3** | Route builder + focus mode | MC-UI-001 (một phần) | ✅ xong |
| **S4** | **Editor đầy đủ**: rail, Insert 14 khối, Structure, Theme, Custom HTML, inspector, biến, expand, token | MC-UI-002 · 003 · 007 · 011 | ✅ xong (Task 16–25) |
| **S5** | Reusable block library | MC-UI-004 | ✅ xong (Task 26–31) |
| **S6** | Asset storage (backend) + Asset library | MC-UI-005 | ✅ xong (Task 32–42) *(ADR-043)* |
| **S7** | HTML import + báo cáo phân tích | MC-UI-006 | ✅ xong (Task 43–46) |
| **SV** | Port thị giác theo ADR-044 + khôi phục tính năng đã mất | MC-UI-001…008 · 011 | ⬜ Task SV-1…SV-6 *(ADR-044)* |
| **S8** | Preview/review + Version history đầy đủ | MC-UI-008 · 009 | ⬜ Task 47–51 |
| **S9** | Publish handoff + ghim chiến dịch | MC-UI-010 | ⬜ Task 52–56 |

**S1–S5 đã xong.** S4 dựng xong Task 16–22; lần kiểm chứng 2026-09-03 (đọc code + chạy lại test) tìm thêm ba việc, đã làm nốt ở Task 23–25 — xem mục "S4: ba việc kiểm chứng 2026-09-03 tìm ra". **S5–S9 đã tách task** (Task 26–56). S6 tách được là nhờ **ADR-043** chốt kho lưu trữ trước — không có ADR đó thì task S6 sẽ đoán mò tầng hạ tầng.

---

## File Structure — S1

| Tệp | Trách nhiệm |
|---|---|
| `apps/api/src/templates/dto/template.dto.ts` | `projectData` vào `create`/`update` schema; `origin` vào `create` |
| `apps/api/src/templates/templates.service.ts` | `TemplateResponse` mang `projectData`; `update()` ghi nó; `templateSummaryResponse()` **loại** nó |
| `apps/api/src/templates/template-html-sanitizer.ts` | `border-radius` vào `allowedStyles` |
| `apps/api/src/templates/template-html-sanitizer.test.ts` | Giá trị đơn qua, shorthand 4 giá trị bị loại |
| `apps/api/test/integration/templates-http.test.ts` | Vòng lưu–đọc `projectData` qua HTTP, kèm `If-Match` |
| `contracts/openapi.yaml` | `projectData` vào `Template`, `TemplateCreateRequest`, `TemplateUpdateRequest` |
| `apps/web/src/api/templates.ts` | `projectData` vào `EmailTemplate` và `TemplatePatch` |

---

### Task 1: `border-radius` qua sanitizer

> **Đã xong, và đã bị mở rộng sau đó.** Task này được triển khai đúng như mô tả bên dưới
> (commit `8274a52`). Sau đó spike S2 phát hiện cùng nguyên nhân gốc còn xoá `padding`,
> `margin`, `border`, nên **ADR-038** thay quy tắc một-giá-trị bằng cú pháp nhiều token —
> test `drops multi-value border-radius shorthand` ở dưới **đã bị thay** bằng test khẳng
> định shorthand sống sót. Xem `docs/adr/adr-038-multi-value-css-in-the-template-sanitizer.md`
> và `docs/superpowers/specs/2026-09-01-grapesjs-spike-findings.md` §8. Phần dưới giữ nguyên
> làm bản ghi lịch sử.

**Files:**
- Modify: `apps/api/src/templates/template-html-sanitizer.ts`
- Test: `apps/api/src/templates/template-html-sanitizer.test.ts`

- [ ] **Step 1: Viết test đỏ**

Thêm vào `template-html-sanitizer.test.ts`:

```ts
it('keeps a single-value border-radius', () => {
  const result = sanitizeTemplateHtml('<td style="border-radius:8px">x</td>');
  expect(result.html).toContain('border-radius');
});

it('drops multi-value border-radius shorthand', () => {
  // safeStyleValues has no space-separated pattern; ADR-037 makes this explicit
  // so an inspector never ships a per-corner control the pipeline silently eats.
  const result = sanitizeTemplateHtml('<td style="border-radius:8px 8px 0 0">x</td>');
  expect(result.html).not.toContain('border-radius');
});
```

- [ ] **Step 2: Chạy — phải đỏ ở test đầu**

```bash
pnpm --filter @eow/api test template-html-sanitizer
```

- [ ] **Step 3: Thêm một dòng vào `allowedStyles`**

Trong `template-html-sanitizer.ts`, khối `allowedStyles['*']` (dòng ~35–56), thêm cạnh `border`:

```ts
    'border-radius': safeStyleValues,
```

Không sửa `safeStyleValues`. Regex số hiện tại (`/^(?:[\d.]+)(?:px|em|rem|%|pt)?$/i`) khớp `8px` và `50%`, không khớp `8px 8px 0 0` — đó chính là hành vi ADR-037 §1 chốt.

- [ ] **Step 4: Chạy lại — cả hai xanh**

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(templates): allow single-value border-radius through the sanitizer"
```

---

### Task 2: `projectData` qua DTO và response

**Files:**
- Modify: `apps/api/src/templates/dto/template.dto.ts`
- Modify: `apps/api/src/templates/templates.service.ts`
- Test: `apps/api/test/integration/templates-http.test.ts`

- [ ] **Step 1: Viết test đỏ**

Thêm vào `templates-http.test.ts` — vòng tạo → lưu → đọc lại:

```ts
it('round-trips projectData on a builder template', async () => {
  const created = await post('/api/v1/templates', { name: 'Onboarding', origin: 'builder' });
  expect(created.body.origin).toBe('builder');
  expect(created.body.projectData).toBeNull();

  const tree = { pages: [{ frames: [{ component: { type: 'wrapper' } }] }] };
  const saved = await patch(`/api/v1/templates/${created.body.id}`, { projectData: tree, html: '<p>x</p>' }, { 'if-match': `"${created.body.draftRevision}"` });
  expect(saved.status).toBe(200);
  expect(saved.body.projectData).toEqual(tree);

  const read = await get(`/api/v1/templates/${created.body.id}`);
  expect(read.body.projectData).toEqual(tree);
});

it('keeps projectData out of the library listing', async () => {
  // Same rule as html/textBody (ADR-035): lists carry metadata, detail routes
  // carry content. A component tree is content and would restore the size
  // coupling ADR-035 exists to remove.
  const list = await get('/api/v1/templates?limit=100');
  expect(list.body.items[0]).not.toHaveProperty('projectData');
});
```

- [ ] **Step 2: Chạy — đỏ**

```bash
pnpm --filter @eow/api test templates-http
```

- [ ] **Step 3: Mở DTO**

Trong `dto/template.dto.ts`:

```ts
const projectData = z.record(z.string(), z.unknown()).nullable();
const origin = z.enum(['imported', 'builder']);
```

- `createTemplateSchema`: thêm `origin: origin.optional().default('imported')`.
- `updateTemplateSchema`: thêm `projectData: projectData.optional()`.

`origin` **không** vào `updateTemplateSchema` — một template đã tạo không đổi được nguồn gốc; đổi `imported` thành `builder` giữa chừng sẽ để lại HTML không có cây component tương ứng.

- [ ] **Step 4: Mở response**

Trong `templates.service.ts`:
- `TemplateResponse` (dòng ~30): thêm `projectData: Record<string, unknown> | null`.
- `templateResponse()` (dòng ~99): trả `projectData: template.projectData`.
- `templateSummaryResponse()` (dòng ~110): thêm `projectData` vào danh sách bị bóc, cạnh `html` và `textBody`.
- `create()`: gán `origin` từ body.
- `update()`: gán `projectData` khi body có trường này. Đặt cạnh các gán hiện có, **trước** `template.draftRevision = template.draftRevision + 1`.

- [ ] **Step 5: Chạy lại — xanh**

- [ ] **Step 6: Commit**

---

### Task 3: Contract và client

**Files:**
- Modify: `contracts/openapi.yaml`
- Modify: `apps/web/src/api/templates.ts`

- [ ] **Step 1: OpenAPI**

Trong `contracts/openapi.yaml`:
- `Template` (dòng ~1556): thêm `projectData` vào `properties` **và** vào `required` — nó luôn có mặt, chỉ là `null` với template `imported`:

```yaml
        projectData: {type: [object, 'null'], additionalProperties: true, description: 'Opaque component tree for builder-origin templates. Never read by the API; draftHtml stays the only content rendered and sent (ADR-019).'}
```

- `TemplateSummary`: **không** thêm. Ghi chú `description` sẵn có đã nói vì sao.
- `TemplateCreateRequest`: thêm `origin` (enum, mặc định `imported`).
- `TemplateUpdateRequest`: thêm `projectData`.

- [ ] **Step 2: Kiểm tra tương thích**

```bash
pnpm contracts:compat-check
```

Thêm trường **optional** vào response là mở rộng, không phá vỡ. Nếu script báo lỗi, đọc kỹ trước khi sửa — ADR-035 đã ghi rằng script này không resolve `$ref` và không phải trọng tài cuối cùng.

- [ ] **Step 3: Client**

Trong `apps/web/src/api/templates.ts`: thêm `projectData: Record<string, unknown> | null` vào `EmailTemplate`, và `projectData?: Record<string, unknown>` vào `TemplatePatch`. `EmailTemplateSummary` giữ nguyên — nó là `Omit` từ response listing.

- [ ] **Step 4: Typecheck**

```bash
pnpm typecheck
```

- [ ] **Step 5: Commit**

---

### Task 4: Nghiệm thu S1

- [ ] **Step 1: Chạy đầy đủ**

```bash
pnpm infra:up
pnpm check
```

- [ ] **Step 2: Đối chiếu mốc test**

Số test phải **tăng** so với mốc xanh của commit trước, không giảm. Nếu có test đỏ không liên quan tới `templates` hay `sanitizer`, chạy riêng tệp đó trước khi điều tra — nhiều khả năng là timeout do RAM.

- [ ] **Step 3: Xác nhận bằng lời, kèm bằng chứng**

Không tuyên bố xong khi chưa dán được số test và trạng thái `pnpm check`.

---

## File Structure — S2

| File | Vai trò |
|---|---|
| `apps/web/src/screens/templates/builder/document.ts` | Kiểu của model `Doc`/`Node`. Không hành vi |
| `apps/web/src/screens/templates/builder/emitter.ts` | `Doc` → HTML. **Hàm thuần**, không React, không DOM |
| `apps/web/src/screens/templates/builder/emitter.test.ts` | Test đơn vị cho emitter |
| `apps/web/src/screens/templates/editor-ports.ts` | Thêm `EmailEditorEngine` |
| `apps/web/src/screens/templates/builder/engine.ts` | Hiện thực `EmailEditorEngine` trên model + emitter |
| `packages/architecture-tests/src/builder-block-sanitizer.test.ts` | Cổng chặn: mọi khối phải sống sót sanitizer |

Emitter là **hàm thuần** vì web không có test render component (spec §2.1) — logic nào không thuần là logic không test được.

---

### Task 5: Model tài liệu và emitter cho khối lá

**Files:** tạo `builder/document.ts`, `builder/emitter.ts`, `builder/emitter.test.ts`

Port từ `studio.tsx` (`htmlNode`/`exportNode`) **và sửa luôn lỗi trong lúc port** — port nguyên bản hỏng rồi sửa sau ở S4 là làm hai lần và có nguy cơ bản hỏng bị dùng thật.

Ba lỗi phải sửa ngay tại task này (kiểm kê §2.1, §2.4, §5 việc 3):

| Prototype viết | Phải đổi thành | Vì sao |
|---|---|---|
| `background:${bg}` | `background-color:${bg}` | shorthand bị xoá ⇒ nút CTA mất nền |
| `font:700 36px Georgia` | `font-size` + `font-weight` + `font-family` tách rời | `font` shorthand bị xoá |
| `aria-label="…"` | `title="…"` | `aria-label` không nằm trong allowlist thuộc tính |

- [ ] **Step 1: Test đỏ** — khẳng định đầu ra *đã sửa*, không phải đầu ra prototype:

```ts
it('emits background-color, never the background shorthand', () => {
  const html = emitNode(button({ accent: '#173f33' }));
  expect(html).toContain('background-color:#173f33');
  expect(html).not.toMatch(/background:/);
});

it('names social links with title, not aria-label', () => {
  const html = emitNode(social([{ platform: 'facebook', url: 'https://f.test', enabled: true }]));
  expect(html).toContain('title=');
  expect(html).not.toContain('aria-label');
});
```

- [ ] **Step 2: Chạy — đỏ.** `pnpm --filter @eow/web test emitter`
- [ ] **Step 3: Port** `document.ts` rồi `emitter.ts` cho: `text` `heading` `button` `image` `banner` `logo` `social` `table` `spacer` `preheader`.
- [ ] **Step 4: Xanh. Commit.**

---

### Task 6: Khối bố cục và xếp chồng mobile không dùng `@media`

**Files:** sửa `builder/emitter.ts`, `builder/emitter.test.ts`

`section` · `row` · `column`, cộng hai khối còn lại (`divider`, và preheader thôi phát `opacity`).

**Kỹ thuật đã kiểm chứng — không phải đề xuất.** Bố cục hai cột fluid/hybrid đi qua sanitizer nguyên vẹn:

```html
<td align="center" style="text-align:center">
  <div style="display:inline-block;width:100%;max-width:280px;vertical-align:top;padding:12px 16px;background-color:#fff">…</div>
  <div style="display:inline-block;width:100%;max-width:280px;vertical-align:top;…">…</div>
</td>
```

Các `div` tự xuống dòng khi khung hẹp lại, **không cần media query**. `display:inline-block` chỉ dùng được nhờ **ADR-040** — quyết định làm cho preheader, hoá ra tháo luôn ràng buộc responsive của ADR-037 §2.

⇒ **Bỏ hẳn `mc-stack`/`mc-column`.** Chúng là class chết: `@media` bị xoá nên không quy tắc nào dùng tới (spike §5).

Đường ngăn cũng đổi — `border-top` bị xoá nên `<hr>` chỉ còn `border:0`, tức render ra không có gì:

```html
<table role="presentation" width="100%"><tr><td style="height:2px;background-color:#173f33"></td></tr></table>
```

- [ ] **Step 1: Test đỏ** — không có `@media`, không có `mc-stack`, đường ngăn có `background-color`.
- [ ] **Step 2–4: đỏ → port → xanh → commit.**

---

### Task 7: `EmailEditorEngine`

**Files:** sửa `editor-ports.ts`, tạo `builder/engine.ts` + test

Chữ ký ở `mailcraft-integration-requirements.md` §3. Hiện thực bọc model + emitter.

- [ ] Test đỏ: `getHtml()` trả HTML đầy đủ **suy ra từ model**, không đọc `projectData` thô; `loadProjectData`/`getProjectData` khứ hồi không mất dữ liệu.
- [ ] `undo`/`redo` giữ nguyên kiểu `past`/`present`/`future` của prototype — đã chạy được, không cần phát minh lại.
- [ ] Không component nào import `emitter.ts` hay `document.ts` trực tiếp.

---

### Task 8: Biến kiểm kê khối thành cổng chặn tự động

**Files:** tạo `packages/architecture-tests/src/builder-block-sanitizer.test.ts`

Đây là việc quan trọng nhất của S2 về lâu dài. Kiểm kê ở `2026-09-01-builder-block-sanitizer-audit.md` được làm **bằng tay**, và §6 của nó yêu cầu mọi khối mới phải chạy lại đúng bài đó. Bằng tay thì sẽ không ai chạy.

Test đặt ở `architecture-tests` vì chỉ package đó đọc được **cả** emitter (web) lẫn sanitizer (api).

- [ ] Với **mọi** loại khối: emit HTML → chạy qua `sanitizeTemplateHtml` → khẳng định **không khai báo nào biến mất** ngoài danh sách loại trừ đã ghi (`box-shadow`, `background-image`, `letter-spacing`, `text-transform`, `opacity`).
- [ ] Danh sách loại trừ **viết cứng và có chú thích**, để thêm một khối làm mất thứ khác là **đỏ**, không phải im lặng.

Cổng này bắt đúng bốn lỗi mà kiểm kê tay đã tìm ra — nếu nó tồn tại từ đầu thì đã không cần cuộc kiểm kê nào.

---

### Task 9: Nghiệm thu S2

- [ ] `apps/web/package.json` **không** có `grapesjs` (ADR-039)
- [ ] `pnpm check` xanh — chạy `architecture-tests` với `--no-file-parallelism`, xem "Bẫy môi trường"
- [ ] Cập nhật `state.json`: `s2-engine-port` → `completed`

---

## File Structure — S3

| File | Vai trò |
|---|---|
| `apps/web/src/app/page-meta.ts` | `isFocusRoute()` + `PageMeta` cho route build |
| `apps/web/src/app/AppRoutes.tsx` | Route `/templates/:templateId/build` |
| `apps/web/src/app/nav.ts` | `routePermissions` cho route mới |
| `apps/web/src/app/AppShell.tsx` | Biến thể focus: header gọn thay sidebar/utility-bar/page-header/footer |
| `apps/web/src/app/globals.css` | CSS focus mode — **chỉ append** |
| `apps/web/src/screens/templates/builder/BuilderScreen.tsx` | Màn hình builder, mount `EmailEditorEngine` |
| `apps/web/src/screens/templates/builder/back-navigation.ts` | Back 4 lớp — **hàm thuần** |
| `apps/web/src/screens/templates/template-editor.ts` | `editorPathFor(template)` — **hàm thuần** |

**Ràng buộc bao trùm S3:** web **không có test render component**. Nên mọi logic phải nằm trong **hàm thuần** kiểm được bằng unit test; phần chỉ dựng được bằng mắt thì nghiệm thu bằng Playwright (`apps/web/e2e/`) và ảnh chụp 3 viewport, không phải bằng "tôi đã xem qua".

---

### Task 10: Predicate, route, quyền

- [ ] **Test đỏ** trong `page-meta.test.ts`: `isFocusRoute('/templates/abc/build')` true; `/templates/abc/edit`, `/templates`, `/campaigns/new` false.
- [ ] **Không** tái dùng `isAutosaveRoute` — nó trả lời câu khác và hôm nay tình cờ đúng cho cùng route. Đây đúng là cái bẫy `page-meta.ts` đã ghi lại.
- [ ] `AppRoutes.tsx`: route mới, bọc `RequirePermission` với **`content:read`** (giống `/edit` — chỉ đọc xử lý *trong* màn hình, chặn ở route sẽ ra màn trắng).
- [ ] `nav.ts`: thêm `routePermissions['/templates/:id/build']`.

### Task 11: Biến thể focus của `AppShell`

- [ ] Khi `isFocusRoute` → **không** render `.sidebar`, `.utility-bar`, `.page-header`, `.app-footer`; render header gọn 56px; vẫn giữ `<Outlet context={setSaveState} />`.
- [ ] Theme class **vẫn ở trên phần tử gốc** — đây là lý do ADR-041 giữ builder trong shell; làm hỏng chỗ này là mất dark mode.
- [ ] CSS **chỉ append** vào `globals.css`. Rule cũ khớp nhầm bề mặt mới thì **đổi class trong JSX**, không sửa rule cũ (tiền lệ: `2026-08-26-template-editor-layout-and-thumbnails-design.md` §3).
- [ ] Không unit-test được ⇒ nghiệm thu bằng e2e ở Task 15.

### Task 12: Header gọn và Back 4 lớp

- [ ] **Test đỏ** cho `back-navigation.ts` — hàm thuần nhận `{ modalOpen, previewOpen, dirty }`, trả `'close-modal' | 'exit-preview' | 'confirm-dirty' | 'to-list' | 'to-previous-route'`. Thứ tự đúng spec §2.11.
- [ ] Header gọn: Back · tiêu đề tài liệu · trạng thái lưu · Xem trước · Xuất bản (ADR-009).
- [ ] Hộp thoại Lưu/Bỏ/Ở lại **tái dùng `ModalFrame`** và bám tiền lệ `confirmDiscard` ở `TemplateEditorScreen.tsx:114,507` — không dựng modal thứ hai.
- [ ] **Back không bao giờ âm thầm bỏ nháp.**

### Task 13: Vào đúng editor theo `origin`

- [ ] **Test đỏ** cho `editorPathFor(template)` — hàm thuần: `builder` → `/build`, `imported` → `/edit`.
- [ ] `TemplatesScreen` dùng nó ở **cả hai** chỗ đang hardcode `/edit` (EntityActionMenu trong lưới, và sau khi import ở dòng ~265). `origin` đã có trên type `EmailTemplate` phía client.
- [ ] `/templates/:id/edit` khi nạp trúng template `builder` thì **redirect** sang `/build` — chỉ là lưới an toàn cho link cũ, không phải đường đi chính.

### Task 14: Chỉ đọc và khổ hẹp

- [ ] Thiếu `content:manage` ⇒ builder **chỉ đọc có giải thích**: canvas/preview/lịch sử vẫn hiện, các đường sửa bị vô hiệu tại **một chốt duy nhất** (tiền lệ `templateContentIsReadOnly()`).
- [ ] `<1024px`: không render canvas kéo-thả mà hiện lời giải thích; **không được vỡ layout** (spec §2.2). 390px là chế độ đọc được thiết kế.

### Task 15: Nghiệm thu S3

- [ ] e2e: mở builder từ thư viện → sửa → Back → hiện hộp thoại → "Ở lại" giữ nguyên nháp.
- [ ] e2e: template `imported` vẫn vào `/edit`, không lạc sang `/build`.
- [ ] Ảnh chụp 3 viewport (1440×900 · 768×1024 · 390×844), lưu vào thư mục evidence của run — **không** lưu vào `design-reference/`.
- [ ] Dark mode: chrome tối, canvas email **luôn sáng** (spec §2.3).
- [ ] `pnpm check` — chạy `architecture-tests` với `--no-file-parallelism`, và **kiểm từng workspace đã chạy chưa**: `pnpm -r` dừng ở workspace fail đầu tiên.
- [ ] `state.json`: `s3-route-and-focus-mode` → `completed`.

---

## File Structure — S4

| File | Vai trò |
|---|---|
| `apps/web/src/screens/templates/builder/blocks.ts` | Danh mục khối cho thư viện — **hàm thuần** |
| `apps/web/src/screens/templates/builder/tree-ops.ts` | Chèn / xoá / di chuyển / chọn node — **hàm thuần** |
| `apps/web/src/screens/templates/builder/inspector-fields.ts` | Node → danh sách trường — **hàm thuần** |
| `apps/web/src/screens/templates/builder/BuilderScreen.tsx` | Ráp canvas + thư viện + inspector |
| `apps/web/src/screens/templates/builder/*.test.ts` | Unit test cho ba tệp thuần trên |

Vẫn ràng buộc cũ: web **không có test render component**, nên mọi logic phải nằm trong hàm thuần; phần dựng bằng mắt nghiệm thu bằng Playwright + ảnh 3 viewport.

---

### Nguyên tắc chi phối phần còn lại: **dựng đủ, không tự cắt**

> **Sửa hướng 2026-09-03.** Bản trước của mục này là "sáu quyết định sản phẩm" do tôi tự đặt:
> cắt bộ khối từ 14 xuống 9, bỏ tool rail, thay Structure tree bằng breadcrumb, hoãn Reusable
> blocks và Assets. **Những quyết định đó không thuộc quyền tôi và đã bị huỷ.** Bản Mailcraft
> là chuẩn nghiệm thu; không được cắt bất cứ thứ gì khỏi nó.
>
> Thứ **duy nhất** được phép thêm ngoài Mailcraft là **một action đi lại giữa MailSpace và
> Mailcraft** — đã có ở S3 (header gọn + Back 4 lớp). Ngoài đó, không thêm gì, không bớt gì.

**Chuẩn đối chiếu là `mailcraft-ui-handoff-v1/design-reference/screen-catalog.yaml`** — 11 workspace, mỗi cái có `states` và `actions` liệt kê sẵn. Đó là danh sách nghiệm thu, không phải gợi ý.

| ID | Workspace | Actions bắt buộc | Hiện trạng |
|---|---|---|---|
| MC-UI-001 | Studio workspace | (6 state: clean · dirty · saving · save_failed · revision_conflict · permission_denied) | Một phần — S3 |
| MC-UI-002 | Insert workspace | `insert_section` `insert_row` `insert_column` `insert_element` | Một phần — **9/14 khối** |
| MC-UI-003 | Structure workspace | `select_node` `expand_node` `collapse_node` `expand_all` `collapse_all` | **Chưa có** |
| MC-UI-004 | Reusable block library | `search` `insert` `rename` `delete` `save_current_tree` | **Chưa có** |
| MC-UI-005 | Asset and logo library | `upload` `replace` `bind` `mark_decorative` | **Chưa có** — cần kho lưu trữ |
| MC-UI-006 | HTML import and analysis | `upload_html` `analyze` `review_report` `create_draft` | Một phần — thiếu report |
| MC-UI-007 | Theme and document settings | `change_width` `change_typography` `change_surface` `change_responsive_rules` | **Chưa có** |
| MC-UI-008 | Preview and content review | `switch_device` `render_variables` `run_content_review` | Một phần |
| MC-UI-009 | Version history | `compare` `preview` `create_draft` | EOW có sẵn một phần |
| MC-UI-010 | Publish handoff | `validate` `publish` `retry_registration` | S5 |
| MC-UI-011 | Custom HTML/CSS | `edit_sanitized_html` `validate` `preview` | **Chưa có** |

**Bố cục bắt buộc (UI-HANDOFF §2) — năm vùng, không được bỏ vùng nào:** header gọn 56px · **tool rail 56px** (Insert · Structure · Reusable · Assets) · workspace panel 320px **mở rộng được 480px** · canvas · inspector 336px **mở rộng được 480px**. Mọi panel dùng **chung một workspace shell**.

**Token thương hiệu (UI-HANDOFF §5) — đủ bốn:** `#173F33` · `#18342C` · `#F3F1ED` · `#E9E7E2`. Hiện mới có một.

### Hai thứ chặn thật, không phải sở thích

Phân biệt rõ: dưới đây **không phải cắt**, mà là phụ thuộc chưa tồn tại. Chúng phải được **làm**, không được bỏ.

**1. Kho lưu trữ asset.** MC-UI-005 cần `upload`/`replace`, mà sanitizer chỉ nhận `src` là `https:`/`cid:` — không base64. EOW **chưa có** module lưu trữ. ⇒ Cần một slice riêng dựng Asset API + storage, **trước** MC-UI-005. Đây là việc bắt buộc, không phải mục hoãn vô thời hạn.

**2. Bốn thuộc tính CSS inspector cần mà sanitizer đang xoá.** `box-shadow` · `letter-spacing` · `text-transform` · gradient nền. — **✅ Xong 2026-09-10.** ADR-042 mở allowlist (2026-09-02), nhưng control mãi không được dựng suốt tám ngày trong khi bốn chỗ vẫn khẳng định ngược lại, trong đó có **một test xanh** tên *"never generates a field for a property the sanitizer strips"* — nó không mô tả lỗi, nó **giữ** lỗi. Dựng control đồng nghĩa phải xoá chính cái test đó. Bài học ghi ở đầu `inspector-fields.ts`.

Cách xử **không phải** bỏ control khỏi inspector — mà là **mở allowlist**, đúng cách ADR-040 đã làm với `display`. Cả bốn đều thuần trình bày, không phải bề mặt tấn công; `linear-gradient()` không dùng `url(` nên vẫn qua được `unsafeCss`. ⇒ Cần một ADR mở allowlist trước khi làm inspector, để không có control nào cho ra kết quả rỗng.

### Cổng đối chiếu độ trung thực — chưa tồn tại, phải thêm

Hiện **không có cổng nào** so giao diện đã dựng với Mailcraft. `visual-acceptance.md` so với baseline `ui-handoff-v2` (giao diện EOW), không phải prototype Mailcraft. Ảnh 3 viewport ở S3/S4 chứng minh **bố cục không vỡ**, không chứng minh **giống Mailcraft**.

⇒ Thêm một test đối chiếu `screen-catalog.yaml`: mọi `actions` của 11 workspace phải có điểm chạm trong mã, và fail khi thiếu. Nếu không, "đầy đủ" lại quay về cảm tính — đúng bài học §6 của bản kiểm kê khối.

### Task 16: Mở allowlist cho bốn thuộc tính inspector cần *(ADR trước, code sau)*

Không được bỏ control khỏi inspector để né sanitizer. Mở đường cho chúng, đúng cách ADR-040 làm với `display`.

- [ ] Viết ADR: `box-shadow`, `letter-spacing`, `text-transform`, và `background-image` giới hạn ở `linear-gradient()` (không `url(`).
- [ ] Đo trước khi quyết, như ADR-040: từng giá trị thật mà emitter phát ra, qua `sanitizeTemplateHtml`.
- [ ] Cập nhật `mailcraft-integration-requirements.md` §1.3 cùng commit.

### Task 17: Tool rail và workspace shell dùng chung

- [ ] Rail 56px, bốn đích: **Insert · Structure · Reusable · Assets** (UI-HANDOFF §2). Đích chưa có nội dung thì hiện trạng thái `empty` có giải thích — **không được ẩn mục**.
- [ ] Một workspace shell dùng chung cho mọi panel: cùng header, vùng tìm kiếm, cuộn, footer, và chế độ **compact/expanded** (320px ↔ 480px).
- [ ] Inspector cũng mở rộng được 336px ↔ 480px.
- [ ] Bốn token thương hiệu đủ: `#173F33` `#18342C` `#F3F1ED` `#E9E7E2`.

### Task 18: MC-UI-002 Insert — đủ 14 khối

- [ ] Bổ sung 5 khối đang thiếu: `logo` `banner` `table` `social` `preheader`. Emitter **đã hỗ trợ cả năm và đã có test** — chỉ thiếu mục thư viện và inspector.
- [ ] `preheader` kèm copy nói rõ **không ẩn được trong Outlook desktop** (`mso-hide:all` bị xoá — ADR-040).
- [ ] Bốn action đúng tên catalog: `insert_section` `insert_row` `insert_column` `insert_element`.

### Task 19: MC-UI-003 Structure — cây component

- [ ] Năm action: `select_node` `expand_node` `collapse_node` `expand_all` `collapse_all`.
- [ ] Điều hướng cây bằng phím mũi tên, Enter, Space (UI-HANDOFF §7).
- [ ] Breadcrumb đã dựng ở S4 **giữ lại** — nó bổ sung cho cây, không thay thế.

### Task 20: MC-UI-007 Theme và MC-UI-011 Custom HTML

- [ ] Theme: `change_width` `change_typography` `change_surface` `change_responsive_rules`.
- [ ] Custom HTML/CSS: `edit_sanitized_html` `validate` `preview`, dùng lại CodeMirror mà `TemplateCodeView` đã nạp động.

### Task 21: Cổng đối chiếu độ trung thực

- [ ] Test đọc `screen-catalog.yaml` và khẳng định **mọi `actions` của 11 workspace** có điểm chạm trong mã; thiếu là đỏ.
- [ ] Danh sách miễn trừ (nếu có) phải ghi lý do từng dòng, như `ACCEPTED_LOSSES` ở `ARCH-BUILDER-SANITIZER`.
- [ ] Đây là thứ biến "đầy đủ" thành đo được. Không có nó, phạm vi lại trôi về cảm tính.

### Task 22: Nghiệm thu S4

- [ ] Đủ 5 vùng bố cục UI-HANDOFF §2; đủ 4 token; rail đủ 4 đích.
- [ ] `ARCH-BUILDER-SANITIZER` xanh với **cả 14** khối.
- [ ] e2e: thao tác đủ bằng bàn phím.
- [ ] Ảnh 3 viewport **đặt cạnh ảnh prototype** để so trực tiếp.
- [ ] `pnpm check`; `state.json` cập nhật.

---

## S4: ba việc kiểm chứng 2026-09-03 tìm ra — Task 23–25 *(đã làm)*

> Kiểm chứng bằng cách đọc code và chạy lại test (không đọc báo cáo), 2026-09-03.
> **Xanh:** ADR-042 + allowlist (Task 16); rail 4 đích + workspace shell 320↔480 +
> inspector 336↔480 + đủ 4 token thương hiệu (Task 17); đủ 15 kind khớp `KINDS`
> (Task 18); Structure tree + phím mũi tên (Task 19); Theme + Custom HTML (Task 20);
> e2e bàn phím + ảnh 3 viewport (Task 22). `@eow/web` 356/356; architecture-tests
> 147/147 (19 file, trừ 2 file cần Docker); `ARCH-BUILDER-SANITIZER` 17/17;
> `ARCH-HANDOFF` 2/2.
>
> **Không xanh khi kiểm chứng:** ba việc dưới đây. **Cả ba đã làm xong trong cùng phiên** —
> mục này giữ lại nguyên trạng chẩn đoán vì nó là bằng chứng cho cách sửa, và vì bài học
> "cổng xanh chưa chắc là cổng chặn được" đắt hơn bản thân lỗi. Sau Task 23–25: cổng
> `ARCH-MAILCRAFT-FIDELITY` 91/91, `@eow/web` 361/361, architecture-tests 198/198.

### Task 23: Xung đột `412` trong builder — đang **lặng lẽ ghi đè**, đúng thứ §2.7 cấm

`BuilderScreen.tsx:483-493` bắt `412` rồi gọi thẳng `load()`, kèm chú thích tự nhận
là tạm: *"Simplified conflict handling for S3 … there is exactly one editable field
here (the name) until S4"*. **S4 đã xong, lý do đó đã hết hiệu lực** — giờ có cả cây
tài liệu, theme, custom HTML.

> **Đính chính (đo xong 2026-09-03).** Bản đầu của mục này — và commit `7c8e16f` —
> mô tả cơ chế **sai**: tôi viết rằng `load()` ghi đè name/subject/textBody đang sửa
> bằng bản máy chủ, và canvas lệch khỏi phần còn lại. Dựng lại web image từ bản
> **trước khi sửa** rồi đo thì cả hai đều không đúng. Lỗi là thật và nặng, nhưng nó
> nằm ở chỗ khác. Phần dưới là cơ chế đo được, không phải suy luận từ đọc code.

**Cơ chế thật, đo trên stack đã đóng gói:**

1. `dispatch({type:'failed', conflict:true})` trả patch bị từ chối về `pending`, status `'conflict'`.
2. `load()` → `dispatch({type:'saved'})`, mà reducer **áp lại `pending` lên trên** draft vừa tải (`{ ...action.draft, ...state.pending }`) và đặt status về `'idle'` vì `pending` không rỗng ⇒ **rời trạng thái conflict ngay trong cùng một tick**. Vì thế thay đổi cục bộ **không** hề mất, và canvas cũng **không** lệch — bản cục bộ thắng một cách nhất quán.
3. Effect autosave không còn thấy `'conflict'` nữa, gửi lại đúng patch đó với `draftRevision` mới, và **thành công**.

**Đo trực tiếp** (probe Playwright trên bản trước khi sửa, hai phiên cùng sửa trường `name`):

```
PROBE local-field  = "Tên tôi vừa gõ"
PROBE status-text  = "… Đã lưu …"
PROBE server-name  = "Tên tôi vừa gõ"   (phiên kia vừa ghi "TEN CUA PHIEN KHAC")
```

⇒ **Việc của phiên kia biến mất, và không ai được hỏi.** Xung đột được tự giải, nghiêng
về phía người dùng cục bộ, trong im lặng. Đó đúng là §2.7 cấm — *"Không được lặng lẽ ghi đè"*
— và là lý do §2.7 đòi trạng thái thứ năm kèm màn so sánh cho người dùng chọn.

Hai điểm phụ, cũng đo được:

- `saveStatusText` chỉ có **bốn** nhánh, không có `status === 'conflict'` ⇒ rơi xuống `'Đã lưu'`. Header báo "đã lưu" đúng lúc server vừa từ chối, rồi lại thành đúng sau khi patch được âm thầm gửi lại — người dùng không bao giờ thấy có chuyện gì xảy ra.
- `autosave-reducer.ts` ghi rõ hợp đồng *"the screens hold off while status is 'conflict'"*. Builder phá hợp đồng đó bằng `dispatch({type:'saved'})` ngay sau `failed`, biến trạng thái conflict thành một tick không ai kịp nhìn thấy.

- [x] Bỏ `void load()` khỏi nhánh `conflict`; giữ `status: 'conflict'` cho tới khi người dùng chọn.
- [x] Thêm nhánh thứ năm vào `saveStatusText`: `Bản nháp đã bị thay đổi ở nơi khác`.
- [x] Dựng màn so sánh, **dùng lại** `resolveConflict` đã có trong `apps/web/src/api/autosave-reducer.ts` và tiền lệ `compose-conflict` của `TemplateEditorScreen.tsx` (hai nút *Dùng bản trên máy chủ* / *Giữ thay đổi của tôi*). Không dựng cơ chế thứ hai.
- [x] Xung đột chạm cả `projectData` ⇒ khi chọn "Dùng bản trên máy chủ", `resolveConflict(false)` nạp lại engine từ `conflictServer.projectData` (hoặc `blankDoc()` nếu không có) và bỏ chọn node, nên canvas không còn giữ cây cũ.
- [x] Test: `templateConflictExcerpt` + `TEMPLATE_CONFLICT_FIELD_LABEL` tách sang `template-editor.ts` (cả hai editor cùng dùng, không chép hai bản) kèm 5 test thuần; e2e `templates-builder-conflict.spec.ts` 2 test, **hai phiên sửa cùng một trường** (khác trường thì cả hai merge sạch và không chứng minh được ai thắng):
  - trong lúc câu hỏi còn mở, server **vẫn giữ giá trị của phiên kia** — bản trước khi sửa thì lúc này patch đã âm thầm gửi lại xong;
  - *"Dùng bản trên máy chủ"* thật sự **bỏ** thay đổi cục bộ, kể cả trên canvas, và không có patch nào xếp hàng gửi sau để lật lại lựa chọn đó.

**Đã xong.** Cổng `ARCH-MAILCRAFT-FIDELITY` (Task 24) đỏ ở `MC-UI-001.revision_conflict`
trước khi sửa, xanh sau khi sửa. E2E đỏ trên web image dựng từ bản trước khi sửa, xanh sau.

**Bài học đắt hơn cả lỗi:** chẩn đoán ban đầu của tôi đọc từ code và *sai cơ chế* — tôi
bỏ qua việc reducer áp lại `pending` lên draft vừa tải. Chỉ tới khi dựng lại image cũ và
đo thật thì mới ra đúng chuyện. Kết luận rút ra giống hệt Task 24: **đọc code cho ra giả
thuyết, không cho ra kết luận.** Slice sau, mọi khẳng định về hành vi runtime phải có một
phép đo đứng sau.

### Task 24: `ARCH-MAILCRAFT-FIDELITY` xanh nhưng **không chặn được** — đo bằng đột biến

Task 21 yêu cầu *"Test đọc `screen-catalog.yaml`"*. Test hiện tại **không đọc** file đó:
`CATALOG` là bản chép tay, và hai test chống trôi (`toEqual([...11 id])`, `toBe(38)`)
so `CATALOG` với hằng số **nằm trong chính tệp đó** — không thể phát hiện nguồn đổi.
(Bản chép hôm nay *đúng*: đã đối chiếu, 38 action khớp yaml.)

Nặng hơn: `fileContains` là **so chuỗi con**, và 21/23 "touch point" chỉ khớp **chữ
trong comment**, không khớp mã. Hai phép đột biến đã chạy:

| Đột biến | Kỳ vọng | Thực tế |
|---|---|---|
| Xoá hẳn khối `section` khỏi `BLOCK_CATALOG`, giữ nguyên comment | đỏ | **XANH 40/40** |
| Giữ đủ 15 khối, chỉ sửa chữ trong comment | xanh | **ĐỎ** — `insert_section` fail |

Cổng đang đo **văn bản chú thích**, không đo hành vi — ngược hẳn mục đích. (Việc xoá
khối `section` bị `blocks.test.ts` bắt, nhưng đó là test khác; cổng độ trung thực
không đóng góp gì.)

Ba lỗ hổng nữa:

- `MC-UI-011 preview` và `validate` khớp **ngẫu nhiên**: `BuilderScreen.tsx` có `previewOpen`/`previewError`/`previewTemplateDraft` (25 lần khớp "preview"). Tệ hơn, comment ngay cạnh tự nói *"`preview` is deliberately not a third mechanism here"* — tức là **chưa làm**, mà cổng vẫn ghi là "has a real code touch point". Phải chuyển sang `excludedReason`.
- Nhánh `excludedReason` chỉ khẳng định `.trim().length > 0`. Chuỗi rỗng-khác-rỗng nào cũng qua ⇒ **hạ một action xuống exclusion là đường xanh một dòng**. Đúng cái "phạm vi trôi về cảm tính" mà Task 21 sinh ra để chặn.
- **`states` hoàn toàn không được kiểm.** Catalog khai `states` cho cả 11 workspace; MC-UI-001 **chỉ có** `states` (6 cái) và bị ghi `actions: []` ⇒ 0 assertion. Chính vì thế cổng không thấy được Task 23: `revision_conflict` là state MC-UI-001 bắt buộc, và nó hỏng.

- [x] Vendor vào `design-reference/mailcraft-screen-catalog.yaml` (header ghi nguồn + ngày chép + cách re-sync) và **parse bằng `js-yaml`**. Mọi action/state catalog khai mà chưa có check ⇒ đỏ, nên re-sync làm lộ yêu cầu mới thay vì giấu đi.
- [x] Bốn loại check, không loại nào comment thoả được: `behaviour` (chạy module thuần thật), `markup` (`data-mc-action`/`data-mc-state`, đọc **sau khi đã xoá comment**), `unreachable` (state không thể xảy ra + assertion chứng minh), `deferred` (mang slice ID).
- [x] Bốn phép đột biến, chạy trên cổng mới:

| Đột biến | Cổng cũ | Cổng mới |
|---|---|---|
| Xoá khối `section` khỏi `BLOCK_CATALOG`, giữ comment | XANH 40/40 | **ĐỎ** — `insert_section` + `MC-UI-002.empty` |
| Giữ đủ 15 khối, chỉ sửa chữ trong comment | ĐỎ | **XANH** |
| Gỡ `data-mc-action` thật, đặt **đúng chuỗi đó** vào một comment | — | **ĐỎ** — `switch_device` |
| Xoá dòng **S7** khỏi bản đồ slice (exclusion trỏ vào chỗ trống) | — | **ĐỎ** — *"a deferral points at S7, but the plan's slice map has no row for it"* |

- [x] `deferred` mang slice ID, và cổng kiểm slice đó **có dòng trong bản đồ slice của plan**; `architecture-rejects` phải tìm được lý do `retry_registration` trong plan.
- [x] Kiểm `states` luôn: 47 state của cả 11 workspace, không riêng 38 action. Cổng đi từ 40 lên **91 test**, và chính phần state là thứ bắt được Task 23.
- [x] `stripComments` có test riêng (giữ `https://` trong chuỗi, bỏ `//`, `/* */`, `{/* */}`, không cho dấu nháy escape kết thúc chuỗi sớm) + sàn an toàn: xoá quá nửa tệp là lỗi stripper, báo đúng như vậy thay vì báo đỏ nhầm.

**Một sửa sai của cổng cũ:** `MC-UI-011.preview` từng được ghi là "có touch point thật" vì `BuilderScreen.tsx` chứa chuỗi `preview` 25 lần (`previewOpen`, `previewError`…), trong khi comment ngay cạnh nói ngược lại — *"preview is deliberately not a third mechanism here"*. Nay là `deferred('S8')`.

### Task 25: Đồng bộ đánh số slice giữa plan và `state.json`

`state.json` đang ở `currentNode: "s5-publish-and-campaign-pin"`, còn bản đồ slice
của plan (2026-09-03) đặt **S5 = Reusable block library** và **S9 = Publish handoff**.
Hai cách đánh số cùng tồn tại sẽ khiến phiên sau đọc "S5" ra hai nghĩa.

- [x] `s5-publish-and-campaign-pin` → `s9-publish-handoff-and-campaign-pin`; thêm bốn node `s5`…`s8` đúng bản đồ slice. Evidence cũ giữ nguyên từng chữ.
- [x] `exclusions` bỏ Asset/Reusable/Import-report (đã thành S5/S6/S7 bắt buộc), giữ lại đúng bốn mục thật sự ngoài phạm vi, kèm `scopeNote` ghi lý do sửa.
- [x] `s4-blocks-inspector-variables` chuyển `completed` → `in_progress`, `currentNode` trỏ về nó — S4 chưa đóng cho tới khi Task 23–25 xong.

---

## S5 đến S9 — đã tách task, trừ S6

Task 26–56 dưới đây tách từ `screen-catalog.yaml`, không từ trí nhớ: mỗi slice ghi rõ nó phủ workspace nào, `states` và `actions` nào. **S6 tách được là nhờ ADR-043** (`docs/adr/adr-043-asset-storage-for-builder-images.md`) chốt bảy câu hỏi kho lưu trữ trước; đọc ADR trước khi bắt đầu Task 32.

Ba điều đã áp dụng cho cả năm slice, rút ra từ chính lần kiểm chứng S4:

1. **Đừng tin bảng phủ §5.2 của spec.** Nó ghi MC-UI-009 là "✅ đã có"; code tự nhận `compare` và `preview` chưa làm. Đọc code trước, sửa bảng sau.
2. **Phần lớn "còn thiếu" là UI, không phải backend.** Endpoint version, preview theo version, `campaign.templateVersionId`, publish — đã có hết. Kiểm trước khi lên lịch việc backend.
3. **Mỗi slice kết bằng việc chuyển `excludedReason` thành touch point thật**, theo cổng đã sửa ở Task 24. Exclusion là phụ thuộc có địa chỉ, không phải chỗ cất việc chưa làm.

**S2 đã được tách task ở trên.**

### S3 — Route builder và focus mode

**Đã tách task ở mục riêng bên trên** (Task 10–15). Phạm vi và quyết định giữ ở đây làm tóm tắt.

**Phạm vi:** route builder cho template `origin: 'builder'`; layout focus mode (header EOW gọn, ẩn sidebar); nút Back 4 lớp và hộp thoại Lưu/Bỏ/Ở lại theo spec §2.11; trạng thái `permission_denied` chỉ đọc theo spec §2.1.

**✅ Đã chốt — ADR-041.** Route riêng **`/templates/:templateId/build`**, nằm **trong** `AppShell`; shell nhận thêm một predicate `isFocusRoute(pathname)` **hẹp, chỉ quyết định layout**. Ra ngoài shell sẽ mất theme class (dark mode chết) và mất kênh save-state qua outlet context. URL tách vì shell phải chọn chrome **trước khi** fetch template — `origin` đã có sẵn trong `TemplateSummaryResponse` nên danh sách link thẳng tới đúng editor. CSS focus mode **chỉ được append** vào `globals.css` (ARCH-HANDOFF).

### S4 — Khối nội dung, inspector, biến

**Đã tách task ở mục riêng bên trên** (Task 16–21). Phạm vi giữ ở đây làm tóm tắt.

**Chưa giải được — chặn ảnh upload:** EOW chưa có Asset API hay kho lưu trữ, mà sanitizer chỉ nhận `src` là `https:` hoặc `cid:` (không base64). Nên S4 chỉ hỗ trợ **dán URL `https` có sẵn**; `AssetProvider` và kho lưu trữ là một slice riêng chưa lên lịch.

### S5 — MC-UI-004 Thư viện khối tái dùng

**Phủ:** MC-UI-004 · states `loading` `empty` `success` `error` · actions `search` `insert` `rename` `delete` `save_current_tree`.

#### ✅ Task 26 — Quyết định: khối tái dùng thuộc **tenant** *(người dùng chốt 2026-09-03)*

Không thuộc người tạo. Thư viện khối là **tài sản chung của tổ chức**, giống template và biến `global` — không phải không gian riêng của từng người.

**Hệ quả bắt buộc, không được lặng lẽ đổi ở Task 27–31:**

| Điểm | Quyết định |
|---|---|
| Khoá ngoại | `tenant_id` là cột phạm vi. `created_by` **có**, nhưng chỉ để **ghi công và hiển thị**, không phải để phân quyền. |
| Đọc | `content:read` — thấy **mọi** khối của tenant. Không có bộ lọc "khối của tôi". |
| Ghi / sửa tên / xoá | `content:manage` — trên **mọi** khối của tenant, kể cả khối người khác tạo. |
| Trùng tên | Duy nhất **trong phạm vi tenant**, không phải trong phạm vi người dùng ⇒ `409`, theo đúng tiền lệ BR-TPL-010. |
| UI | **Một danh sách duy nhất.** Không tách "của tôi" / "dùng chung" — tách như thế là dựng lại mô hình sở hữu cá nhân mà quyết định này vừa bác. |

**Điều phải nói thẳng với người dùng, vì nó là mặt trái của lựa chọn này:** ai có `content:manage` đều **đổi tên và xoá được khối người khác tạo**. Đó là ý nghĩa của "thuộc tenant", không phải lỗ hổng. ⇒ danh sách phải hiển thị `created_by`, và `delete` phải có bước xác nhận nêu rõ tên khối (Task 30).

**Xoá là xoá cứng, và đây là chỗ nó khác hẳn asset (ADR-043 §5.)** `insert` **chép** nhánh `Node` vào tài liệu; template giữ bản sao của riêng nó. Vì thế xoá một khối khỏi thư viện **không** làm hỏng bất kỳ template nào đã dùng nó — kể cả template đã xuất bản. Asset thì ngược lại: version bất biến còn trỏ tới URL của asset, nên ở đó phải xoá mềm. Đừng chép quy tắc xoá mềm của S6 sang đây; ràng buộc sinh ra nó không tồn tại ở slice này.

⇒ Không cần ADR riêng: quyết định này đi theo đúng khuôn phạm vi-tenant mà cả repo đang dùng (RBAC + migration 073), không mở hướng kiến trúc mới. Ghi ở đây là đủ, và `ARCH-TENANT-ISOLATION` là thứ ép nó không trôi.

> Ràng buộc kế thừa: khối lưu lại là **một nhánh `Node`** của `document.ts`, không phải HTML. Lưu HTML sẽ tạo con đường thứ hai vào canvas mà cây component không biết — đúng cái ADR-037 §3 cấm. Chèn lại đi qua `tree-ops.ts` như mọi khối khác.

| Tệp | Vai trò |
|---|---|
| `database/migrations/0XX-*.sql` | Bảng `reusable_block` — **migration đầu tiên của cả nỗ lực này**; phải tính SHA-256 và dán tay vào `database/migrations.lock.json` cùng commit (`ARCH-MIGRATION`) |
| `apps/api/src/templates/reusable-blocks.*` | CRUD, phạm vi theo tenant, RBAC `content:manage` để ghi / `content:read` để đọc |
| `contracts/openapi.yaml` | 5 operation; chạy `pnpm contracts:compat-check` |
| `apps/web/src/screens/templates/builder/reusable-blocks.ts` | Lọc/sắp xếp danh sách — **hàm thuần**, sắp xếp bằng `localeCompare(..., 'vi')` (§2.6) |

- [x] **Task 26:** chốt và ghi quyền sở hữu — **tenant**, xem mục quyết định ngay trên.
- [x] **Task 27:** migration + entity + service + RBAC theo đúng bảng hệ quả trên (`tenant_id` phạm vi, `created_by` chỉ ghi công, unique theo tenant, xoá cứng); hash lock file trong cùng commit; test cách ly tenant (`ARCH-TENANT-ISOLATION` đã có khuôn) **và** một test khẳng định người dùng B sửa/xoá được khối do A tạo trong cùng tenant — đó là quyết định, không phải lỗ hổng, nên phải có test giữ nó.
- [x] **Task 28:** contract + client + `compat-check`; kèm module thuần `builder/reusable-blocks.ts` (lọc cục bộ + sắp xếp `localeCompare(..., 'vi')`, khớp dấu bỏ dấu) và 11 test cho nó.
- [x] **Task 29:** `save_current_tree` — lưu **node đang chọn** kèm con của nó; từ chối lưu node rỗng; tên trùng trong phạm vi ⇒ `409`, màn hình không nuốt lỗi (tiền lệ BR-TPL-010).
- [x] **Task 30:** panel `reusable` thay `EmptyWorkspaceNotice` (`BuilderScreen.tsx`) bằng nội dung thật: `search` (lọc cục bộ, không round-trip mỗi ký tự), `insert`, `rename`, `delete` có xác nhận nêu rõ tên khối. **Một danh sách duy nhất**, mỗi dòng hiện `created_by`. Đủ 4 state, **kể cả `error`**.
- [x] **Task 31:** nghiệm thu — `ARCH-MAILCRAFT-FIDELITY` (bản đã sửa ở Task 24) chuyển 5 action MC-UI-004 từ `excludedReason` sang touch point thật; e2e bàn phím; `pnpm check`.

---

### S6 — MC-UI-005 Kho lưu trữ asset + Thư viện ảnh/logo

**Phủ:** MC-UI-005 · states `loading` `empty` `success` `error` `missing_assets` · actions `upload` `replace` `bind` `mark_decorative`.

**✅ ADR-043 đã có** (`docs/adr/adr-043-asset-storage-for-builder-images.md`) — object store S3-compatible (MinIO ở dev), URL vĩnh viễn do app sở hữu, một bucket prefix theo `tenant_id`, 5 MB/tệp, **không SVG**, xoá mềm, **`cid:` ngoài phạm vi**. Đọc ADR trước Task 32; plan này không lặp lại lý do.

> **Đây là slice duy nhất có migration** trong cả nỗ lực. `ARCH-MIGRATION` so từng SHA-256 với `database/migrations.lock.json` và fail ở mọi khác biệt ⇒ hash tính và dán tay **trong cùng commit**. Spec §7 ghi "không có migration mới trong S1–S5" — câu đó đúng cho S1–S5 và hết hiệu lực ở đây.

| Tệp | Vai trò |
|---|---|
| `compose.yaml` | MinIO — **vào bộ `infra:up`**, không phải bộ đầy đủ (máy dev thiếu RAM) |
| `database/migrations/076_asset_storage.sql` | Bảng `asset`; + hash vào `migrations.lock.json` cùng commit |
| `apps/api/src/assets/asset-storage.ts` | Adapter object store — **đằng sau interface**, để prod đổi endpoint bằng env chứ không sửa code |
| `apps/api/src/assets/assets.controller.ts` | Upload/list/archive (RBAC) + route phục vụ `@Public()` |
| `apps/api/src/assets/asset-validation.ts` | Magic bytes, MIME allowlist, trần kích thước — **hàm thuần**, test được không cần store |
| `apps/web/src/screens/templates/editor-ports.ts` | `AssetProvider` — cổng thứ sáu, đóng lại bộ sáu của spec §1.4 |

- [x] **Task 32:** *(đo trước, code sau — ADR-043 §Consequences yêu cầu)* một ảnh thật đi hết vòng upload → `projectData` → emitter → `sanitizeTemplateHtml` → publish, khẳng định `src` sống sót nguyên vẹn. **Không viết UI trước khi phép đo này xanh.** Đây là điều ADR-043 tự nhận nó chưa làm được, khác ADR-042.
- [x] **Task 33:** MinIO vào `compose.yaml` + `infra:up`; `S3AssetStorage` sau interface `AssetStorage`; test chạy với MinIO **thật**, không mock (mock sẽ xanh trong khi `forcePathStyle`/endpoint/credential đều sai — đúng những thứ khác nhau giữa MinIO và S3, và đúng thứ adapter sinh ra để che). Interface **không có `delete`**: ADR-043 §5 giữ object vĩnh viễn, nên có `delete` là mời người ta dùng nó.
- [x] **Task 34:** migration `076_asset_storage.sql` + entity + hash lock file **cùng commit**; `ARCH-TENANT` phủ `asset`; thêm test RLS nối bằng chính role `eow_app` (`asset-rls.test.ts`) — owner bypass RLS và bỏ qua GRANT nên test nối bằng owner sẽ xanh cả khi bảng không có policy lẫn grant nào.
- [x] **Task 35:** validation — magic bytes (**không tin `Content-Type` client gửi**), allowlist `png`/`jpeg`/`gif`/`webp`, **từ chối `image/svg+xml`** (ADR-043 §4: SVG chạy script, và route phục vụ nằm ở origin có cookie phiên), trần 5 MB. Hàm thuần, test không cần store.
- [x] **Task 36:** API — upload/list/archive qua `AuthGuard` + RBAC (`content:read` đọc / `content:manage` ghi); route phục vụ `@Public()`. **Ràng buộc từ phép đo Task 32:** URL phát ra phải là **https tuyệt đối** (`ASSET_PUBLIC_ORIGIN`), vì sanitizer xoá thẳng đường dẫn tương đối — đặt sai biến này thì mọi ảnh trong email **đã xuất bản** hỏng mà không có cảnh báo nào. Đồng thời ép `ASSET_STORAGE_SECRET_KEY` không rỗng **tại chỗ dùng** (schema env để `default('')` cho tới khi có route thật). **Route công khai đầu tiên phục vụ dữ liệu người dùng** ⇒ rate limit, và chỉ nhận `asset_id` tra bảng, **không** nhận đường dẫn do client dựng (nếu không nó thành proxy đọc tuỳ ý object store). `replace` **tạo asset mới rồi trỏ lại**, không ghi đè byte — ghi đè sẽ đổi ảnh trong mọi email đã xuất bản.
- [x] **Task 37:** contract + `AssetProvider` port + client; `pnpm contracts:compat-check`.
- [x] **Task 38:** panel `assets` thay `EmptyWorkspaceNotice` (`BuilderScreen.tsx:764`) bằng nội dung thật. Đủ **năm** state, kể cả `missing_assets`. Copy phải nói hai điều ADR-043 cấm giấu: (a) URL công khai là **bearer capability** — ai có link đều tải được, đừng để tệp nhạy cảm ở đây; (b) asset đã archive **vẫn được phục vụ** cho email đã gửi — archive là ẩn khỏi thư viện, không phải thu hồi.
- [x] **Task 39:** `bind` + `mark_decorative` trong `tree-ops.ts`, **không** trong port (ADR-043 §7: đưa vào port sẽ để UI sửa tài liệu qua hai đường, phá §2.13). `mark_decorative` ⇒ emitter phát `alt=""` **và** `role="presentation"`.
- [x] **Task 40:** `IMAGE_ALT_MISSING` chính xác hơn — `alt=""` kèm `role="presentation"` ⇒ **0 cảnh báo**; thiếu `alt` mà không có `role="presentation"` ⇒ vẫn 1 cảnh báo. §2.8 cấm định nghĩa **bộ mã khác**, không cấm làm một mã có sẵn đúng hơn. Test cả hai chiều.
- [x] **Task 41:** copy nói thẳng ảnh `https:` **bị Outlook desktop chặn mặc định** cho tới khi người nhận bấm hiển thị ảnh — cùng cách ADR-040 xử preheader, không giả vờ nó không tồn tại.
- [x] **Task 42:** nghiệm thu — cổng (bản đã sửa ở Task 24) chuyển 4 action MC-UI-005 từ `excludedReason` sang touch point thật; `ARCH-MIGRATION` xanh với lock file đã cập nhật; e2e bàn phím upload→bind→publish; `pnpm check`.

---

### S7 — MC-UI-006 Import HTML + báo cáo phân tích

**Phủ:** MC-UI-006 · states `file_selected` `import_analyzing` `import_partial` `import_fallback` `missing_assets` `error` · actions `upload_html` `analyze` `review_report` `create_draft`.

**Đã có, đừng dựng lại:** `analyzeTemplate` (sanitize + 6 mã lint) và luồng upload/tạo trong `TemplatesScreen.tsx:43-71`. **Thiếu đúng một thứ:** `review_report` — màn hình trình bày *sanitizer đã bỏ những gì* — và sáu state trên.

> Spec `docs/superpowers/specs/2026-09-01-sanitizer-reports-what-it-removed-design.md` đã đặc tả phần báo cáo này. **Đọc nó trước Task 43** — nhiều khả năng phần backend đã có sẵn hoặc đã đặc tả xong, và S7 chỉ còn phần màn hình.

**Ranh giới phải giữ:** import vẫn tạo `origin: 'imported'` (vào code editor). Dựng ngược cây component từ HTML là bài toán riêng, và ADR-037 §3 đã cấm cách sai (đọc `id`, mà sanitizer xoá `id`). **S7 không được lặng lẽ mở rộng thành import-vào-builder.**

> **Task 43 đã bác dự đoán ở trên.** Backend **không** có sẵn gì: `changes` vẫn là một câu cố định, `<script>` và `@media` bị vứt im lặng hoàn toàn. Ba mâu thuẫn giữa bản thiết kế và kế hoạch này đã được đo và quyết định trong `docs/superpowers/specs/2026-09-04-sanitizer-report-gap-analysis.md` §4 — đọc nó trước khi sửa bất cứ dòng nào dưới đây.

- [x] **Task 43:** đọc spec sanitizer-report; xác định phần nào đã có, phần nào còn thiếu. Ghi lại trước khi viết code. → `4891b27`
- [x] **Task 44:** màn `review_report` — nhóm theo loại (tag / attribute / CSS / `@media` / stylesheet cả khối). → `8d4b768` (phép đo) + `7d287cb` (màn hình).
      **Sửa so với bản gốc:** ~~mỗi mục bấm được để nhảy tới vị trí, giống 6 mã lint đã làm~~ — tiền lệ này **không tồn tại**: 6 mã lint chỉ có `{code, severity, count, field}`, không có `start`/`end`. Và phép đo mà §3.1 của bản thiết kế chọn (so trước/sau) **đếm chứ không định vị**; muốn định vị thì phải nhân bản allowlist, đúng thứ §3.1 đã bác. ⇒ chỉ đếm theo loại. Việc "nhóm" do thứ tự (mất mát lớn trước) và do chính câu chữ tự nói loại của nó đảm nhiệm. Xem gap-analysis §4.3 và §4.4.
- [x] **Task 45:** đủ sáu state, đặc biệt hai cái dễ bỏ: `import_partial` (một phần bị bỏ, vẫn tạo được nháp) và `import_fallback` (không phân tích được, người dùng vẫn đi tiếp bằng HTML thô). `missing_assets` = ảnh trỏ tới URL không phải `https:` — **liệt kê, không tự sửa**. → `7d287cb`
      Một điều chỉnh nhỏ: `missing_assets` nhận cả `cid:` là hợp lệ, khớp với API, chứ không chỉ `https:` như luật của builder — builder không thể sinh ra `cid:`, còn bản tin import thì có thể.
- [x] **Task 46:** nghiệm thu — bốn chỗ ghi nợ (`review_report`, `import_partial`, `import_fallback`, `missing_assets`) thành check thật, 8 đột biến đều đỏ; e2e import tệp mẫu đóng băng có `<script>` + `@media` + ảnh `http:`, khẳng định báo cáo nêu đủ ba; `pnpm check`. → `a450dba` + `68fcdac`
      **Thay cho nghiệm thu "đủ 16" của bản thiết kế** (đã lỗi thời — ADR-040 trả lại 3 mục, ADR-042 trả 4 mục, S2 sửa emitter phần còn lại): một tệp mẫu HTML **import** đóng băng ở `.agents/runs/2026-08-31-mailcraft-builder/evidence/s7-task43/lossy-import-sample.html`, sinh ra đúng một tập đóng 10 dòng phủ cả sáu loại mất mát.

**Hai lỗi thật S7 tìm ra ngoài phạm vi báo cáo:**
1. Một chú thích HTML chỉ cần *nhắc tới* `<style>` là `stripUnsafeStyleBlocks` xoá luôn tới `</style>` thật kế tiếp — **phá mất CSS thật**, có từ M3-S1. Đo trên tệp mẫu: mất 611 ký tự kèm một quy tắc `@media` đang chạy. → `68fcdac`
2. Healthcheck Postgres báo khoẻ trước khi nhận kết nối mạng (`f42ce44`), và ba khiếm khuyết trong chính cổng `ARCH-NGINX-ROUTING` (`78a0180`) — cả hai làm `pnpm check` đỏ vì lý do không liên quan tới thứ chúng canh.

---

### SV — Port thị giác theo ADR-044

**Vì sao có slice này, và vì sao nó đứng trước S8.** ADR-044 đảo luật: prototype Mailcraft là
**gốc thị giác**, không còn là tài liệu chỉ để ngó. Ba việc đã xong (`85072ed`, `0c6b8ca`,
`d743f1b`): prototype vào repo, `studio.css` chép nguyên văn vào `globals.css`, khối `contact`
trở lại, báo cáo import dựng lại theo bố cục prototype. Còn lại là **điều 3** — port DOM và tên
lớp — cộng hai nhóm tính năng đã mất.

Đứng **trước S8/S9** vì hai slice đó dựng màn hình *mới* (lịch sử, xuất bản). Dựng chúng sau
khi khung đã port là dựng một lần; dựng trước là dựng hai lần.

**Đo trước khi lập kế hoạch (2026-09-04):**

| Câu hỏi | Kết quả |
|---|---|
| Có cổng nào ép DOM dùng `v3-*`? | **Không.** Hai dòng `v3-` trong `packages/architecture-tests` đều là chú thích. Xoá sạch `v3-` khỏi TSX vẫn xanh |
| App dùng bao nhiêu lớp prototype? | **7 / 113** (7 lớp của modal import, `d743f1b`) |
| Bán kính ảnh hưởng | 6 tệp e2e bám **41** selector `builder-*`; `globals.css` có **47** quy tắc `builder-*` |

⇒ Task SV-1 phải là **cổng**, không phải code. Port trước rồi mới canh là lặp lại đúng sai lầm
đã sinh ra slice này: `studio.css` có thể nằm trong `globals.css` mà không ai dùng một dòng nào.

**Nguyên tắc chi phối slice:** mỗi màn hình là **một lượt duy nhất** — port DOM và khôi phục
tính năng đã mất của màn đó trong cùng một Task. Tách ra thành "khôi phục trước, port sau" là
viết mỗi tính năng hai lần.

- [ ] **Task SV-1 — cổng trước tiên.** `ARCH-MAILCRAFT-DOM`: với mỗi màn MC-UI, đọc các lớp
      `v3-*` mà component tương ứng trong `studio.tsx` dùng, và đòi tệp repo tương ứng cũng
      dùng. Lớp cố ý không dùng phải có mục loại trừ **mang địa chỉ** (số ADR hoặc số Task),
      đúng khuôn ADR-044 điều 4. Viết đỏ trước; mutation-test bằng cách xoá một lớp khỏi màn
      đã port. Ban đầu **mọi màn trừ MC-UI-006 đều là loại trừ mang địa chỉ `SV-2…SV-5`** — cổng
      xanh nhưng nợ được ghi rõ, thay vì vô hình như trước.
- [x] **Task SV-2 — khung editor + chủ đề (MC-UI-001, MC-UI-007).** Port `v3-app` `v3-header`
      `v3-head-actions` `v3-rail` `v3-left` `v3-work` `v3-canvas` `v3-canvas-area` `v3-stage`
      `v3-inspector` `v3-inspect-head` `v3-inspect-scroll`. Chủ đề chuyển từ danh sách phẳng
      trong inspector sang `v3-sheet` + `v3-theme-work` + `v3-theme-preview`, với `Segment` cho
      chiều rộng và `range` cho cỡ chữ như prototype. **Cần quyết định trước khi làm — xem §Ba
      quyết định.** Giữ nguyên `role="tree"` và điều hướng bàn phím: đó là thứ repo làm **tốt
      hơn** prototype, ADR-044 đã ghi không coi là sai lệch.
- [x] **Task SV-3 — chèn khối + cấu trúc (MC-UI-002, MC-UI-003).** Port `v3-presets` `v3-shapes`
      `v3-row-layouts` `v3-block-scroll` `v3-library-filters` `v3-search` `v3-atomic-note`
      `v3-layer*` `v3-node` `v3-leaf` `v3-empty-col` `v3-empty-section`. **Khôi phục:** 5 nhóm
      khối có đếm số, ô tìm kiếm, 6 mẫu tỷ lệ cột; nút ẩn/hiện và khoá từng dòng trong cây, và
      "+ Section" trên thanh công cụ. Thuần frontend, không đụng hợp đồng.
- [x] **Task SV-4 — khối tái dùng + asset (MC-UI-004, MC-UI-005).** Port `v3-reusable-*`
      `v3-assets` `v3-asset-filterbar` `v3-resource` `v3-upload` `v3-media-empty` `v3-brand-kit`.
      **Khôi phục:** ô xem trước trên hàng khối tái dùng, hướng dẫn 3 bước ở trạng thái rỗng,
      thanh lọc ảnh/logo, mục brand kit. **Chặn bởi một thay đổi hợp đồng** — `Asset` hôm nay
      chỉ có `id`/`url`/`filename`/kiểu suy từ magic bytes, không có khái niệm `logo` vs `image`,
      nên thanh lọc chưa dựng được. Xem §Ba quyết định.
- [x] **Task SV-5 — preview/soát nội dung + HTML tuỳ chỉnh (MC-UI-008, MC-UI-011).** Port
      `v3-preview-work` `v3-inbox` `v3-email` `v3-issues` `v3-review-filters` `v3-review-summary`
      `v3-code-work` `v3-code-tabs` `v3-code-result` `v3-pipeline` `v3-apply-code`. Giữ
      `<iframe sandbox="">` thay cho `dangerouslySetInnerHTML` của prototype — ADR-044 đã ghi
      đây là chỗ repo làm tốt hơn. Cân nhắc chồng lấn với S8 Task 49 (`run_content_review`) để
      không làm hai lần.
- [x] **Task SV-6 — nghiệm thu.** Mọi loại trừ trong `ARCH-MAILCRAFT-DOM` còn lại đều mang địa
      chỉ; e2e chuyển selector từ `builder-*` sang `v3-*` (41 chỗ, 6 tệp); ảnh 3 viewport cho
      từng màn đã port; dọn quy tắc `builder-*` đã chết khỏi `globals.css` (47 quy tắc — kiểm
      từng cái, một số có thể còn dùng ngoài Mailcraft); `pnpm check` xanh; `state.json`.

**SV-6 đã làm gì (2026-09-05), và ba con số của chính dòng trên đều sai:**

- **"47 quy tắc `builder-*` chết" — thật ra là 3.** Đo lại: `globals.css` có **123** quy tắc mà
  selector nhắc tới `.builder-*`, và **48** tên lớp riêng biệt. Con số 47 đo ngày 2026-09-04, khi
  plan *dự đoán* SV-2…SV-5 sẽ giết chúng. Thực tế ngược lại: ba slice đó cố ý **giữ** `builder-*`
  cạnh `v3-*` (lớp kép) để hoà giải hình học, nên chúng vẫn sống. Chỉ `builder-canvas-area`
  (placeholder của S3), `builder-node-button-chip` (SV-5 thay bằng thẻ `<a>` thật) và
  `builder-structure-chevron` (SV-3 thay bằng `v3-layer`) là chết thật; thêm hai selector dùng
  chung bị cắt bớt phần đã chết. Không cái nào nằm trong tệp handoff EOW nên `ARCH-HANDOFF` không
  bị đụng — đã kiểm trước khi xoá.
- **Suýt xoá một quy tắc còn sống, đúng kiểu bẫy đã cắn slice này bốn lần.** Phép rà đầu tiên báo
  `builder-node-row` là chết vì tên đó **không xuất hiện nguyên văn ở đâu cả** — canvas viết
  `` `builder-node-${node.kind}` ``. Xoá `.builder-node-row>.builder-node-children` sẽ làm mọi
  hàng trên canvas hết xếp cạnh nhau, và không test nào bắt được. Đã ghi cảnh báo ngay cạnh quy
  tắc đó trong `globals.css` để lần rà sau không đọc nhầm lần nữa.
- **"41 selector → `v3-*`" chỉ đúng một phần, và phần còn lại *không nên* chuyển.** Chuyển 7 chỗ
  ở 4 tệp, đúng những nơi phần tử thật sự mang lớp `v3-*` của prototype: `builder-structure-tree`
  → `v3-layer-scroll`, `builder-inspector` → `v3-inspector` (3), `builder-canvas` → `v3-canvas`
  (2), `builder-custom-html-editor` → `v3-code-work`. Số còn lại **không có tương đương**:
  `builder-node-${kind}`, `builder-inspector-field`, `builder-title-field`, `builder-library-grid`,
  `builder-asset-thumb`, `builder-custom-html-report`, `builder-reusable-rename` là móc riêng của
  EOW mà prototype không hề có. Đặt tên `v3-*` cho chúng chính là bịa tên lớp — thứ ADR-044 sinh
  ra để chặn. `builder-canvas-area` trong `templates-builder.spec.ts` hoá ra chỉ nằm trong một
  **chú thích**, không phải selector.

**Hai lỗi SV-6 tìm ra, và cả hai chỉ lộ ra khi chạy thật:**

1. **Hồi quy duy nhất của SV-5**, đúng như dự đoán: SV-5 đổi nhãn nút thành "Xác thực với máy chủ"
   (vì panel giờ tự kiểm khi gõ, nên "Xác thực" trần không còn nói rõ nút nào), và
   `templates-builder-s4-task22-acceptance.spec.ts` khớp `exact: true`. Spec đã cập nhật, và nhân
   tiện mở rộng để nghiệm thu luôn chrome MC-UI-011: 4 bậc `v3-pipeline`, hai tab, và tab CSS
   (gõ `@import` → banner đỏ + nút xác thực bị khoá; sửa lại → về vàng).
2. **Thông báo khổ hẹp trỏ vào một nút mà chính CSS đã port ẩn đi.** Dưới 1024px builder đổi
   workspace lấy `.builder-narrow-notice`, và câu chữ của nó nói *"Dùng “Xem trước” để xem nội
   dung"*. Nhưng `studio.css` (chép nguyên văn ở SV-2) có
   `@media(max-width:720px){.v3-head-actions>button:not(.v3-lang):not(.v3-avatar){display:none}}` —
   đúng cho prototype vốn chỉ chạy desktop, sai ở đây. Đo ở 390px: thông báo hiện, nút
   `display:none`. Cách duy nhất đọc template trên điện thoại trỏ vào thứ không tồn tại. Khối
   "Task SV-6 ADDITIONS" cho nút preview hiện lại ở khổ đó; **"Xuất bản" vẫn ẩn** — không thứ gì
   trên điện thoại nên cách một chạm với một version bất biến. **Lần vá đầu thiếu đúng một điểm
   đặc hiệu** và không đổi gì trên màn hình trong khi trông đúng trong diff.

**Một điều về khả năng kiểm của rail, ghi lại vì nó sẽ cắn spec sau:** nút "Soát lỗi" là đích rail
duy nhất có tên tiếp cận **thay đổi theo trạng thái** — SV-2 gắn huy hiệu số lỗi vào nó, và `<em>`
đó nhập vào tên nút. Đo được: cùng một `getByRole('button', { name: 'Soát lỗi', exact: true })`
chạy được trước khi phân tích trả về và hết giờ 20 dòng sau đó. Huy hiệu là cố ý và đáng giá hơn
sự tiện tay, nên spec dùng tiền tố tên thay vì khớp chính xác.

**Nghiệm thu:** spec mới `templates-builder-sv5-review-preview.spec.ts` — 3 test hành vi (dòng lint
nhảy đúng khối *và* nêu được phần tử nhận cú click; dòng không gắn khối thì không cho nhảy; chọn
người nhận thì **HTML render đổi**, không chỉ đổi nhãn) + 6 ảnh bằng chứng 3 viewport cho hai màn
SV-5. Ảnh chỉ ghi trong thư mục của slice này, **không** quét `visual-capture` toàn bộ — lần chạy
full suite ghi đè 258 PNG của M1–M6 và đã được hoàn tác. Bộ Mailcraft: **32/32 xanh** (trước SV-6
là 21). Hai test `templates-builder-conflict` đỏ trong lần chạy chung nhưng **xanh khi chạy riêng**
— autosave hết 10s dưới tải, không liên quan thay đổi nào ở đây.

**SV-5 đã làm gì (2026-09-05), và vì sao phạm vi khác dòng đăng ký:**

- **Sổ đăng ký gán sai lần thứ tư và thứ năm.** Entry #1 của `ARCH-MAILCRAFT-DOM` nhận 26 lớp
  cho MC-UI-008/011. Đo bằng cách gán mỗi `className` trong `studio.tsx` về hàm bao ngoài nó thì
  chỉ **10** thuộc hai màn ấy — đúng bằng danh sách chính dòng Task SV-5 này đã ghi. Hai chỗ sai
  nặng nhất: `v3-view-note` nằm ở dòng 944, nhánh **templates** (dòng đếm "N mẫu sẵn sàng"), chứ
  không phải "the preview sheet's caveat line" như chú thích viết; và `v3-context-card` là **một**
  thẻ ở đầu sheet biến nêu dữ liệu xem trước, không phải "thẻ mỗi biến". Nhóm biến
  (`scope-tabs`/`var-group`/`context-card`) thuộc nhánh **variables** — màn khác, và đích của nó
  SV-2 quyết định 4 đã dựng sẵn thành panel rail, nên chỉ thiếu chrome. `v3-email-fallback` là
  chú thích cuối nhóm "Bề mặt nâng cao" mà chính dòng `widths|surface-presets` đã bác.
- **Chồng lấn S8 Task 49: gộp vào SV-5, làm một lượt.** Plan mô tả sai hiện trạng — ba action
  MC-UI-008 **không** còn "chỉ có comment tag", S4 đã nối thật (`data-mc-action` trên device
  toggle, iframe và danh sách lint). Task 49 chỉ còn nợ hai thứ, và cả hai chính là chrome SV-5
  vẽ ra: `missingKeys` (BR-TPL-005) thuộc `v3-preview-work`, và "6 mã lint bấm-để-nhảy" (§2.8)
  chính là `v3-issues` — prototype vẽ mỗi dòng là `<button>` "Đi tới khối và sửa →". Cả hai đã
  làm ở đây. **Task 49 rút còn nghiệm thu.**
- **Ba quyết định phạm vi (người dùng chốt 2026-09-05):**
  1. **Canvas vẽ hình thật, trừ `custom`.** `CanvasLeafPreview` vẽ nút, ảnh, logo, mạng xã hội,
     khoảng trắng và **bảng thật** sau các lớp `v3-p-*`/`v3-table`. `v3-custom` giữ tóm tắt và
     thành loại trừ **có địa chỉ**: vẽ nó cần `dangerouslySetInnerHTML` trên canvas, đúng thứ
     ADR-044 ghi là chỗ repo làm tốt hơn nhờ `<iframe sandbox="">`.
  2. **Tách sổ + port phần rẻ.** Nợ còn lại mang địa chỉ thật: `v3-parameter` (nút "Tham số hóa"
     trên vùng bôi đen — canvas EOW không sửa chữ tại chỗ, port nó là dựng lại mô hình soạn thảo,
     ngoài phạm vi ADR-044) và `v3-custom`.
  3. **Preview dùng `listRecipients` thật.** Cột "Người nhận" liệt kê người thật của tenant; chọn
     một người thì preview render bằng dữ liệu của chính họ. `preview-recipients.ts` chép đúng ba
     luật của `recipient-variable-context.ts` phía máy chủ — chỉ merge `email`/`first_name`/
     `last_name`/custom field (**không** merge `department`), **bỏ qua** khoá không có giá trị để
     `missingKeys` nói thật, và giữ mẫu cho khoá mà lần gửi luôn tự sinh (`unsubscribe_url`).
- **Một thay đổi model, có chủ ý:** `Node.css` cho khối `customHtml`, để tab CSS của
  `v3-code-tabs` có thứ đứng sau. Khác với `v3-widths`/`v3-surface-presets` bị bác vì sanitizer
  lột sạch: CSS ở đây **sống sót** — đo trong trình duyệt, `POST /templates/analyze` trả về
  `<p class="lead" style="color:#173f33">` từ `<style>.lead{color:#173f33}</style>`, tức sanitizer
  **inline** nó vào `style=""`. Đụng `document.ts` + `emitter.ts`, không đụng hợp đồng API.
- **Hai lỗi hình học chỉ trình duyệt thấy, mọi test xanh** (lần thứ ba trong slice này):
  `.v3-code-work` là `height:calc(100dvh - 100px)` vì prototype mở nó thành sheet toàn màn — trong
  inspector 451px nó cao 800px, thò ra 358px và ô báo cáo nằm dưới đáy; và `.v3-p-social` là
  `display:flex` không wrap vì prototype vẽ **icon** cỡ cố định, còn EOW viết **tên** kênh (ADR-044
  port DOM và tên lớp, không port hình vẽ) nên năm tên tràn cột. Cả hai vá trong khối
  "Task SV-5 ADDITIONS" cuối `globals.css`, không sửa dòng nào của `studio.css`.

**Ba quyết định — đã chốt 2026-09-04, không còn chặn gì:**

1. **✅ RAIL 10 MỤC.** Theo đúng ADR-044 điều 3. Thêm *Kho mẫu · Chủ đề · Nhập HTML · Biến ·
   Soát lỗi · Lịch sử*. **Lưu ý khi làm:** sáu mục này **đều đã tồn tại ở nơi khác trong EOW**,
   nên mục rail phải **dẫn tới thứ đã có**, không được dựng bản sao thứ hai — *Nhập HTML* trỏ về
   modal import của `TemplatesScreen` (vẫn `origin: imported`, ADR-037 §3 vẫn cấm import vào
   builder), *Lịch sử* trỏ về modal version history, *Soát lỗi* dùng 6 mã lint đã có. Hai bản sao
   của cùng một tính năng chính là kiểu trôi mà ADR-044 sinh ra để chặn.
2. **✅ CHỦ ĐỀ DÙNG SHEET.** `v3-sheet` + `v3-theme-work` + `v3-theme-preview`, có ô xem trước
   sống. Widget theo prototype: `Segment` cho chiều rộng (600/640/720) thay `<select>`, thanh
   trượt 12–18px cho cỡ chữ thay ô số, `<select>` 4 lựa chọn cho font thay ô text tự do. Giá trị
   mặc định trong `defaultTheme` **đã khớp prototype**, không đổi.
3. **✅ THÊM LOẠI ASSET VÀO HỢP ĐỒNG.** `Asset` nhận thêm một trường phân loại `logo|image`.
   **Đây không phải content type** — content type đã có và do magic bytes quyết định (ADR-043 §4).
   Đây là **phân loại do người dùng chọn**, nên phải đặt được lúc upload và sửa được sau. Đụng:
   contracts + `openapi.d.ts` sinh lại + `contracts:compat-check` + migration + entity +
   repository + service + client. Kiểm RLS bằng `testAppDatabaseUrl()`, **không** phải
   `testDatabaseUrl()` (role owner, bypass RLS).

**SV-4 đã làm gì, và hai chỗ plan chưa lường:**

- **Hợp đồng `Asset` thêm `kind: logo|image`** (quyết định 3) — migration 078, `PATCH /assets/{id}`,
  trường `kind` tuỳ chọn khi upload, và replace **giữ nguyên phân loại** (mặc định về `image` ở đó
  sẽ âm thầm làm rỗng bộ nhận diện mỗi lần ai đó cắt lại logo). RLS kiểm bằng `testAppDatabaseUrl()`
  chứ không phải `testDatabaseUrl()` — bộ e2e HTTP chạy dưới role owner nên **không thể** thấy
  rò rỉ chéo tenant, đúng điểm mù đã để lọt bug của 077.
- **Chỗ plan chưa lường:** ô xem trước trên hàng khối tái dùng cần số cột/số element mà
  `ReusableBlockSummary` không có. Thêm hai số dẫn xuất vào listing (server đã giữ `node` trong
  hàng đang chiếu, nên không tốn truy vấn; `node` vẫn nằm ngoài listing theo ADR-035).
- **Sai lệch có địa chỉ:** `v3-assets` của prototype là lưới thẻ hai cột vì sheet của nó *chỉ để
  chọn*; panel EOW là chính thư viện, mỗi hàng mang bốn nút (gán, thay, lưu trữ, đổi phân loại) —
  không nhét vừa dưới ảnh 104px. Hàng giữ bố cục danh sách, mặc chrome của prototype bên trong.
- **Hai lỗi CSS chỉ trình duyệt mới thấy, mọi test đều xanh:** `.v3-assets img{width:100%}` thắng
  `.builder-asset-thumb{width:40px}` về độ đặc hiệu → thumbnail phình 275px, thư viện trượt ngang;
  và `.builder-reusable-insert` vốn là cột nên xếp chồng dải xem trước lên trên tên.

**Bốn quyết định SV-2 đã trả lời khi làm (2026-09-04), ghi lại vì cả bốn đều là "có dựng bản
sao thứ hai không":**

1. **Header.** Port `v3-header` `v3-brand` `v3-doc` `v3-head-actions` `v3-history` lên chính
   header của focus mode (ADR-041 giao header cho AppShell, và header của MC-UI-001 *là* header
   đó). `v3-avatar` dựng vỏ trỏ về menu tài khoản đã có — focus mode ẩn utility bar, nên trước
   đó muốn đăng xuất phải rời trình soạn. `v3-lang` **bỏ**: EOW một ngôn ngữ, không có i18n
   runtime, một nút đổi ngôn ngữ không đổi gì là tệ hơn không có nút. `v3-history` nối vào
   `engine.undo/redo` đã có test từ S2 mà chưa từng có nút nào gọi.
2. **Kho mẫu.** Dựng panel trái thật, đọc từ `listTemplates` của chính tenant — không phải
   `templatePresets` cứng của prototype, và không phải bản sao `TemplatesScreen`: footer
   `v3-library-footer` dẫn về đó. Bộ lọc theo `status` vì `EmailTemplateSummary` không có khái
   niệm hr/internal/event. "Dùng mẫu" đi qua `engine.replaceDocument` (mới, có test) chứ **không**
   `loadProjectData` — cái sau xoá lịch sử, nghĩa là nút "thử một mẫu" sẽ là cửa một chiều.
3. **Inspector 3 tab.** Mỗi trường mang `tab` trong `inspector-fields.ts` (dữ liệu, không phải
   đoán theo tên khoá trong JSX). Tab rỗng nói ra mình rỗng, đúng luật Task 17 đặt cho đích rail
   chưa dựng.
4. **Biến / Soát lỗi.** Cả hai **chuyển** vào panel rail, không nhân đôi: danh sách biến rời khỏi
   đáy inspector, danh sách lint rời khỏi đáy màn. Rail đeo huy hiệu số lỗi nên cảnh báo vẫn thấy
   được khi panel đóng.

**Một sai lệch hình học, có địa chỉ:** `v3-app`/`v3-work` giữ tên lớp nhưng EOW viết lại lưới của
chúng (khối "Task SV-2 ADDITIONS" cuối `globals.css`). Prototype là một trang trọn vẹn
`min-width:980px` không có responsive; builder EOW nằm trong focus mode của ADR-041 và phải giữ
ba bậc của conventions spec §2.2. Mọi thứ *bên trong* hai lưới đó vẫn do `studio.css` tạo kiểu.

**Cổng tự nó có lỗ, tìm ra bằng đột biến:** xoá `className="v3-theme-grid"` khỏi `BuilderScreen`
mà `ARCH-MAILCRAFT-DOM` vẫn xanh — tên lớp còn nằm trong một chú thích và một tên test.
`webSourceText()` giờ bỏ tệp `.test.*` và cắt chú thích trước khi so. Vá xong thì cổng đỏ ngay
`v3-icon`, một lớp thật sự chưa port mà trước đó "được dùng" trong chú thích.

**Chi phí, nói thẳng:** SV-2 đụng `BuilderScreen.tsx` (hơn 1300 dòng) và làm chết phần lớn 47
quy tắc `builder-*`. SV-6 phải sửa 41 selector trong 6 tệp e2e. Đây là làm lại tầng thị giác
của bốn slice đã đóng, đã có test, đã qua cổng. Đổi lại là thứ ADR-044 mua: từ nay một khối
biến mất khỏi thiết kế sẽ làm đỏ, thay vì im lặng suốt bốn slice như `contact`.

---

### S8 — MC-UI-008 Preview/soát nội dung + MC-UI-009 Lịch sử phiên bản đầy đủ

**Phủ:** MC-UI-008 (`switch_device` `render_variables` `run_content_review`) và MC-UI-009 (`compare` `preview` `create_draft`).

**Trạng thái thật, do cổng Task 21 phát hiện — bảng phủ §5.2 của spec đang *lạc quan quá*:** spec ghi UI-08/MC-UI-009 là "✅ đã có". Đọc code thì `TemplateEditorScreen.tsx:281-283` tự nhận: `compare` và `preview` **chưa làm**; modal chỉ liệt kê metadata và khôi phục thành nháp mới. Đây là gap thật, không phải tài liệu chậm cập nhật. **Sửa bảng §5.2 của spec trong cùng commit với Task 47.**

**Backend đã sẵn — S8 gần như thuần UI:**

- `GET /template-versions/:versionId` (`apps/web/src/api/templates.ts:100`) trả nội dung một version.
- `POST /template-versions/:versionId/preview` (dòng 147) render một version cụ thể kèm `mergeData`.
- ⇒ `preview` của MC-UI-009 **không cần backend mới**; `compare` cũng chỉ cần gọi endpoint đầu hai lần.

- [x] **Task 47:** MC-UI-009 `preview` — render một version đã xuất bản, dùng `previewTemplateVersion` đã có. Nhắc lại §2.10: **không** có nút "Sửa version này".
- [x] **Task 48:** MC-UI-009 `compare` — so hai version. Tiền lệ trình bày đã có: `conflictExcerpt` + `.compose-conflict-diff` (`TemplateEditorScreen.tsx:59, 480`). Dùng lại, đừng dựng bộ diff thứ hai. **Nửa sau của câu đó sai và đã đo:** lưới `.compose-conflict-diff` dùng lại được, nhưng `conflictExcerpt` thì **không** — xem khối "S8 đã làm gì" dưới đây.
- [x] **Task 49 — ĐÃ LÀM TRONG SV-5 (2026-09-05), rút còn nghiệm thu.** Mô tả cũ ("hiện chỉ có comment tag") **sai hiện trạng**: S4 đã nối cả ba action thật. Hai việc còn nợ — `missingKeys` (BR-TPL-005) trong preview và 6 mã lint **bấm-để-nhảy** (§2.8) — chính là chrome `v3-preview-work` và `v3-issues` mà SV-5 port, nên làm một lượt theo nguyên tắc "mỗi màn một lượt duy nhất". Device toggle vẫn dùng `mail-preview-stage` như cũ. **Còn lại ở S8:** chỉ xác nhận trong Task 51.
- [x] **Task 50:** state `permission_denied` của MC-UI-008 — chỉ đọc **vẫn xem được** preview và lint (§2.1: "nội dung hiện đầy đủ"), chỉ khoá gửi thử. **Đo ra là gần như đã đúng sẵn**, và builder không có nút gửi thử nào để khoá.
- [x] **Task 51:** nghiệm thu — cổng chuyển `compare`/`preview` sang touch point thật; `pnpm check`.

**S8 đã làm gì (2026-09-05), và một chỉ dẫn của chính dòng Task 48 đã sai:**

- **`conflictExcerpt` KHÔNG dùng lại được cho hai version đã xuất bản, và đây là số đo.** Dòng
  Task 48 bảo dùng lại `conflictExcerpt` + `.compose-conflict-diff`. Vế sau đúng; vế trước sai.
  Emitter của builder (`emitter.ts:299`) ghi một tiền tố **cố định 367 ký tự** trước mọi nội dung
  node, còn `templateConflictExcerpt` cắt ở **120**. Hai version khác nhau ở *mọi chữ nhìn thấy
  được* vẫn cho ra excerpt **giống hệt nhau từng byte** — chạy thử và xác nhận, không suy diễn.
  Một màn "So sánh" dựng trên đó sẽ hiện hai ô y hệt rồi tuyên bố đã so sánh. Người dùng chốt
  phương án **diff theo dòng** (2026-09-05) ⇒ module thuần mới `version-diff.ts`, làm bằng TDD
  (LCS tự viết, không thêm dependency), 28 test. Lưới `.compose-conflict-diff` thì dùng lại
  nguyên vẹn, và `conflictExcerpt` **vẫn dùng** cho ba field ngắn (`subject`/`textBody`/
  `variableSchema`) vì lỗi tiền tố không chạm tới chúng — chỉ `html` là không.
- **Cùng cái mù đó suýt tái diễn ở chỗ khác, qua một cơ chế khác.** Bản đầu của
  `truncateLineDiff` cắt `limit` **entry đầu tiên**, kể cả `unchanged`. Tiền tố 367 ký tự chuẩn
  hoá ra đúng **10 dòng không đổi**, nên một ô cỡ 6–10 dòng chỉ hiện `<!doctype html>`, `<html>`,
  `<head>`… và không bao giờ tới dòng đã đổi. Test khi đó không bắt được: ca chứng minh tự tay
  lọc `op !== 'unchanged'` trước khi khẳng định, còn ca end-to-end dùng fixture mà **mọi** dòng
  đều đổi. Đã sửa để ưu tiên dòng đã đổi rồi mới lấp ngữ cảnh gần nhất kiểu hunk `diff -U`, và
  `hiddenCount` đếm *thay đổi* bị giấu chứ không phải entry.
- **Task 49 xác nhận: đã đóng trong SV-5, không có việc nào còn lại.**
- **Task 50 đo ra là gần như đã đúng sẵn.** Rà toàn bộ hơn 70 chỗ dùng `readOnly` trong
  `BuilderScreen`: preview và lint đều **không** bị khoá, mọi đường ghi đều khoá. Và builder
  **không có nút gửi thử nào** để khoá — `sendTemplateVersionTest` chỉ được gọi ở
  `SendPreviewPanel` và `TemplatesScreen`. Không bịa thêm một nút chỉ để có cái mà khoá. Thay đổi
  duy nhất: `title`/`aria-label` cho nút "Tạo bản nháp mới" khi chỉ đọc, vì banner
  `permission_denied` của shell nằm **sau** lớp phủ của chính sheet lịch sử nên người chỉ đọc
  đứng trong sheet không thấy lý do nút bị mờ. Một dòng trên đúng control, không phải banner
  thứ hai.
- **Ba sai lệch có địa chỉ khi port chrome dòng 950:** tab **"Hoạt động"** bỏ (EOW không có
  audit log — `grep` `auditLog|activityLog` ra 0, API không có route audit; port nó là vẽ tab
  rỗng, đúng lý do SV-2 bỏ `v3-lang`); **hàng 0 "Bản nháp hiện tại"** không dựng (danh sách EOW
  chỉ gồm version bất biến; bản nháp là canvas người dùng đang đứng); và câu bất biến **rút khỏi
  hai vỏ** vì `v3-immutable` đã nói đúng câu đó.
- **Một lỗi CSS chỉ trình duyệt thấy, mọi test xanh — lần thứ tư trong dự án này.**
  `--workspace-accent`/`--workspace-accent-soft` chỉ được `studio.css` đặt trên `.v3-sheet-bg`.
  Builder có ancestor đó; `TemplateEditorScreen` gắn **cùng** component vào `ModalFrame` thì
  không, nên `color-mix()` tính ra invalid và tab active + nút chính **mất màu âm thầm**. Hook
  mới `.v3-history-embed` chép đúng hai giá trị của `.v3-sheet-bg.sheet-history`. Cùng loại:
  `.template-preview-frame` không có quy tắc nền không-scope nào, nên iframe preview trong sheet
  sẽ co về ~300×150 — vá bằng chiều cao cố định, theo đúng cách `.send-preview` đã giải cùng bài
  toán, chứ không tái áp giả định flex vào chỗ không có cha flex.
- **Cổng bắt được một thứ ngoài dự kiến: tỉ lệ chú thích.** Sau bốn bước,
  `TemplateVersionHistory.tsx` còn **48.3% là mã** — chạm sàn 50% mà `ARCH-MAILCRAFT-FIDELITY`
  đặt ra để phát hiện lỗi bộ strip. Hạ sàn là làm yếu guard; đã cắt chú thích (403 → 335 dòng),
  giữ mọi dữ kiện đo được.
- **Sáu mục `deferred('S8')` chuyển thành check thật**, và `MC-UI-009.compare` làm mạnh hơn
  `markup`: nó khẳng định excerpt cũ *thật sự mù* với cặp dữ liệu đó, `version-diff` phân biệt
  được, **và** thứ ô hiển thị nhận được vẫn mang thay đổi. Đột biến hai lần — xoá điểm chạm, và
  hoàn nguyên `truncateLineDiff` về cắt thô — cả hai đều đỏ, cái sau đỏ với đúng thông điệp
  `expected '<!doctype html>|<html>|<head>|…' to contain 'Gia 199'`.
- **Trước S8 không có spec e2e nào chạm UI lịch sử phiên bản** (`grep` "Khôi phục" trong
  `apps/web/e2e/` ra 0). Spec mới `templates-version-history-s8.spec.ts`.

---

### S9 — MC-UI-010 Publish handoff + ghim chiến dịch

**Phủ:** MC-UI-010 · states `publish_validating` `publishing` `published` `publish_failed` `registration_pending` · actions `validate` `publish` `retry_registration`.

**Cổng thoát của cả vertical slice** (spec §5.3): một người mở Mailcraft từ EOW, dựng email onboarding có chữ/ảnh-URL/nút/biến, lưu, xuất bản một version bất biến, và **một chiến dịch gửi đúng version đó**.

**Đã có, chỉ cần nối:** `POST /templates/:id/publish` (`templates.ts:121`); nút Publish trong builder (S3); version bất biến (`PATCH` → `405`); `campaign.templateVersionId` xuyên suốt API/service/`campaign-completeness.ts`; outbox (ADR-012); snapshot chiến dịch (ADR-013/029). **S9 không dựng backend mới.**

**`retry_registration` — bẫy duy nhất trong slice này:** action đến từ mô hình Mailcraft-là-service-riêng (đăng ký template với một connector từ xa). Trong kiến trúc đã chọn **không có bước đăng ký nào**, đúng như spec §5.1 nói về ADM-01/02/05. ⇒ Đây là **`excludedReason` chính đáng**, không phải việc phải làm. Nhưng theo Task 24, exclusion phải mang địa chỉ: ghi rõ *"không áp dụng — không tiêu chí nào trong năm tiêu chí §3.3 đang đúng"*, và tương ứng `registration_pending` cũng không phải state phải dựng. **Đây là action duy nhất trong 38 cái mà kiến trúc bác bỏ hẳn** — mọi cái khác đều phải làm hoặc đã làm.

- [x] **Task 52:** `validate` — màn tổng kết trước khi xuất bản: biến chưa khai báo (`UNKNOWN_VARIABLE` **chặn** publish, không chặn lưu nháp — §2.9), 6 mã lint, kích thước HTML (cảnh báo ≥512 KB, từ chối ≥5 MB), thiếu `unsubscribe_url` (BR-TPL-008 — cảnh báo, vì thiếu nó email bulk chết ở khâu **gửi**, không phải khâu soạn), thiếu `textBody` (BR-TPL-007).
- [x] **Task 53:** `publish` với đủ 4 state dựng được (`publish_validating` `publishing` `published` `publish_failed`); `published` hiện số hiệu version và lối đi thẳng sang chọn chiến dịch.
- [x] **Task 54:** ghim chiến dịch — chọn version trong màn chiến dịch; khẳng định version **đã ghim không đổi** khi có version mới hơn (BR-TPL-012, đây chính là nghiệm thu S9).
- [x] **Task 55:** `retry_registration` → `excludedReason` có địa chỉ; **không** dựng UI cho nó.
- [x] **Task 56:** nghiệm thu vertical slice — e2e xuyên suốt từ "Soạn bằng Mailcraft" tới chiến dịch gửi đúng version; ảnh 3 viewport; `ARCH-MAILCRAFT-FIDELITY` với **0 exclusion không có địa chỉ slice**; `pnpm check`; `state.json`.

**S9 đã làm gì (2026-09-07), và hai địa chỉ trong chính tài liệu này đã sai:**

- **"Tiêu chí ADR-008" không tồn tại.** Sáu chỗ trong repo trích dẫn nó — hai dòng của chính
  Task 55 ở trên, hai dòng của spec (§5.1 và bảng §3), lý do loại trừ `retry_registration` trong
  `ARCH-MAILCRAFT-FIDELITY`, và **mã nguồn API thật** (`asset-storage.ts`, quyết định đặt khoá đối
  tượng theo prefix tenant). Nhưng `docs/adr/adr-008-background-processing.md` là quyết định dùng
  **BullMQ**; nó không chứa một tiêu chí tách service nào. Năm tiêu chí thật (nhịp release · nghẽn
  tài nguyên · đội ngũ riêng · bán độc lập · cách ly tenant) nằm **chỉ ở §3.3 của spec**. Task 55
  nói "exclusion phải mang địa chỉ" — một địa chỉ trỏ nhầm tài liệu thì không phải địa chỉ, và ở
  đây nó đã lan sang mã sản phẩm. Đã sửa cả sáu.
- **`v3-flow` bị bác, không phải hoãn** (người dùng chốt 2026-09-06). Nó vẽ
  "Mailcraft → HTML + metadata → **EOW Provider API**": một bước nhảy giữa hai hệ thống. Chỉ có
  một hệ thống — ADR-001 giữ một codebase, publish là một lần ghi vào chính cơ sở dữ liệu đó.
  Chuyển sang `kind: 'rejected'`, cùng căn cứ với `retry_registration`/`registration_pending`.
- **`v3-resource` giữ hình, đổi ruột** (cùng quyết định). Bốn ô của prototype ghi "Provider:
  mailcraft / Resource: email_template" — một registry không tồn tại. Bốn ô thật lấy từ
  `freezeSummary`: **phiên bản sắp tạo · số biến · kích thước HTML · số khối**. Đo trên trình
  duyệt: `v1 · 1 · 42 B · 0`, mỗi số đối chiếu được với chính fixture.
- **Một mục `deferred` nữa hoá ra là nợ chết.** `MC-UI-011.preview` trỏ vào `S8` — một slice **đã
  đóng mà không làm việc đó**, tức địa chỉ vĩnh viễn không thanh toán được. Đọc mã thì nó chưa bao
  giờ là nợ: `CustomHtmlEditor` ghi rõ preview cấp-khối cố ý không dựng vì "sẽ chỉ là bản sao tệ
  hơn của cùng một lần render". Chuyển thành check **thật**: khẳng định `emitNode` phát nguyên văn
  HTML của khối vào tài liệu, nên nếu ai làm hỏng điều đó thì preview toàn tài liệu âm thầm ngừng
  hiện khối và quyết định kia không còn đúng.
- **Ngưỡng 5 MB: tôi đã đo sai một lần, và bản ghi này sửa lại.** Lần đo đầu (giới hạn grep vào
  đúng tệp lint) kết luận "không có ngưỡng 5 MB nào". Sai: `MAX_TEMPLATE_HTML_BYTES` ở
  `template-html-sanitizer.ts:4`, kiểm bằng `Buffer.byteLength` ở dòng 367, và
  `asset-validation.ts` cố ý dùng chung con số (ADR-043 §4). Sanitizer chạy ở **mọi** lần lưu
  (§2.12) nên HTML quá 5 MB không lưu nổi, chứ không chỉ không xuất bản được. Phép kiểm trong
  `publish-readiness.ts` vì thế là bản sao phòng vệ của một luật có thật.
- **Task 52 có hai lỗ thật:** cảnh báo thiếu `unsubscribe_url` (BR-TPL-008 — bảng của chính spec
  ghi "⚠️ một phần") chưa từng tồn tại; và `UNKNOWN_VARIABLE` đã được **máy chủ** chặn
  (`templates.service.ts:274`) nhưng chỉ báo *sau* cú bấm. Sheet đưa cả hai lên trước.
- **Task 54 theo nhu cầu người dùng nêu (2026-09-06):** ghim bản mới nhất **lúc gắn**, cho đổi có
  chủ ý **trước khi gửi**, không bao giờ tự trôi. Trước S9 màn chiến dịch **không hiện số hiệu
  version nào** — nó nạp `templateVersion` chỉ để tính biến ghi đè. Giờ hiện "Đang gửi bản v2", và
  khi có bản mới thì thêm "Đã có bản v4" + một nút. Đổi chỉ xảy ra trong `onClick`, đi qua đúng
  `change({ templateVersionId })` mà bộ chọn template đã dùng — một đường ghi duy nhất.
- **Nghiệm thu:** spec mới `templates-publish-handoff-s9.spec.ts` 4/4, gồm cổng thoát §5.3. Ba
  khẳng định cần trình duyệt: nút header **mở tổng kết chứ không xuất bản** (0 version sau cú bấm
  header, 1 version sau xác nhận trong sheet); biến chưa khai báo **khoá** nút và nêu đúng tên,
  còn template sạch thì mở — hai đầu đều nêu; và BR-TPL-012 hai chiều — ghim v1, xuất bản v2, vẫn
  v1 kèm lời mời, bấm mới sang v2. Bộ Mailcraft **36/36 không flaky**. `pnpm check` **xanh hoàn
  toàn, exit 0**: 267 tệp / 2095 test, kể cả `@eow/api` 136/136 — lần đầu trong cả slice không tệp
  nào rớt vì tải.
- **Còn đúng hai loại trừ trong `ARCH-MAILCRAFT-FIDELITY`**, cả hai kiểu `architecture-rejects`:
  `retry_registration` và `registration_pending`. **0 loại trừ kiểu slice.** Đúng như dòng Task 55
  dự đoán: đây là hành động duy nhất trong 38 cái mà kiến trúc bác bỏ hẳn.

---

### Ngoài phạm vi vertical slice — còn lại đúng hai mục

Sau khi S5–S9 xong, `screen-catalog.yaml` được phủ hết trừ những mục kiến trúc bác bỏ. Hai việc sau vẫn nằm ngoài:

- **Import HTML *vào builder*** (dựng ngược cây component từ HTML). S7 chỉ làm báo cáo phân tích; import vẫn vào code editor. ADR-037 §3 đã cấm cách làm sai.
- **Tách Mailcraft thành service riêng** — chỉ khi một trong năm tiêu chí ở §3.3 thành hiện thực. Hôm nay chưa cái nào. Đây cũng là điều kiện duy nhất khiến ADM-01/02/05 và `retry_registration` có nghĩa.

**Media query thật (hướng A)** vẫn cần spike có bằng chứng render hộp thư trước khi xét (§3.2) — không thuộc slice nào ở trên.
