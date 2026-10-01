# Template Editor Layout Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trả lại chiều cao cho bề mặt soạn thảo template, để preview và CodeMirror hiển thị thật thay vì bị bóp còn 77px và 29px.

**Architecture:** Trường "Văn bản thuần" chuyển thành tab thứ ba nên mỗi lúc chỉ một bề mặt tồn tại. `.template-editor-fields` đổi từ flex column sang grid `auto / minmax(0,1fr) / auto`, khiến khung soạn thảo nhận toàn bộ phần dư thay vì bị các anh em có `min-height` cứng bóp chết. Đổi tên lớp để rule modal cũ thôi khớp, và **chỉ thêm** block CSS mới vì `ARCH-HANDOFF` cấm sửa dòng đã duyệt trong `globals.css`.

**Tech Stack:** React 18 + TypeScript, Vitest, CSS thuần trong `apps/web/src/app/globals.css`, CodeMirror 6 nạp lười.

**Spec:** `docs/superpowers/specs/2026-08-26-template-editor-layout-and-thumbnails-design.md` §1.1, §2, §3, §4.

---

## Bối cảnh bắt buộc đọc trước

Ba điều sẽ khiến bạn làm sai nếu không biết:

1. **`ARCH-HANDOFF` cấm sửa bất kỳ dòng đã duyệt nào của `apps/web/src/app/globals.css`.** Thêm rule mới ở cuối tệp thì được. Nối thêm selector vào một rule có sẵn thì **không** — nó bị tính là redesign. Vì vậy kế hoạch này không đụng vào dòng 306 và dòng 352; nó ghi đè bằng block mới ở cuối tệp, nơi thứ tự nguồn giúp rule mới thắng ở cùng độ đặc hiệu.

2. **Không tin exit code.** Chạy `pnpm check` rồi **đọc số `Test Files` / `Tests`**. Một lần chạy nền từng trả exit 0 trong khi 2 test đang đỏ.

3. **Test xanh không chứng minh gì ở đây.** Toàn bộ suite đang xanh trong khi preview bị cắt sạch khỏi màn hình. Task 5 là cổng nghiệm thu thật, và nó đo trên ứng dụng chạy thật. Không được bỏ.

## File Structure

| Tệp | Trách nhiệm |
|---|---|
| `apps/web/src/screens/templates/template-editor.ts` | Hàm thuần: kiểu tab, và quyết định có cảnh báo bản text hay không. Không DOM, test được độc lập. |
| `apps/web/src/screens/templates/template-editor.test.ts` | Test cho hàm thuần trên. |
| `apps/web/src/screens/templates/TemplateEditorScreen.tsx` | Ba tab, gom phần đuôi vào một khối, đổi lớp, gỡ style inline của iframe. |
| `apps/web/src/app/globals.css` | **Chỉ append** một block mới ở cuối tệp. |

---

### Task 1: Hàm thuần cho tab và cảnh báo bản text

**Files:**
- Modify: `apps/web/src/screens/templates/template-editor.ts`
- Test: `apps/web/src/screens/templates/template-editor.test.ts`

- [ ] **Step 1: Viết test đỏ**

Thêm vào cuối `apps/web/src/screens/templates/template-editor.test.ts`, bên trong tệp nhưng **ngoài** `describe` đang có:

```ts
describe('template editor tabs', () => {
  it('flags the text tab when lint reports an empty text body', () => {
    expect(textBodyNeedsAttention([{ code: 'TEXT_BODY_EMPTY' }])).toBe(true);
  });

  it('ignores lint codes that belong to other fields', () => {
    expect(textBodyNeedsAttention([{ code: 'IMAGE_ALT_MISSING' }, { code: 'LINK_PLACEHOLDER' }])).toBe(false);
  });

  it('treats a missing analysis as nothing to flag', () => {
    expect(textBodyNeedsAttention(undefined)).toBe(false);
    expect(textBodyNeedsAttention([])).toBe(false);
  });
});
```

Sửa dòng import đầu tệp thành:

```ts
import { groupTemplateCatalogue, insertTemplateVariable, textBodyNeedsAttention } from './template-editor.js';
```

- [ ] **Step 2: Chạy test để chắc chắn nó đỏ**

```bash
pnpm --filter @eow/web test template-editor
```

Kỳ vọng: FAIL — `textBodyNeedsAttention is not a function` hoặc lỗi biên dịch vì export không tồn tại.

Lưu ý: dạng `pnpm --filter <pkg> test -- <tên>` **không lọc** — dấu `--` bị truyền nguyên văn và vitest bỏ qua, khiến bạn chạy cả suite. Dùng đúng dạng ở trên.

- [ ] **Step 3: Viết cài đặt tối thiểu**

Thêm vào cuối `apps/web/src/screens/templates/template-editor.ts`:

```ts
export type TemplateEditorTab = 'preview' | 'code' | 'text';

/**
 * `TEXT_BODY_EMPTY` là mã lint duy nhất nói về bản text thuần. Khi bản text
 * nằm sau một tab, người dùng không còn nhìn thấy nó trống, nên cảnh báo phải
 * nổi lên chính cái nhãn tab đang che nó.
 */
export function textBodyNeedsAttention(lint: readonly { code: string }[] | undefined): boolean {
  return (lint ?? []).some((issue) => issue.code === 'TEXT_BODY_EMPTY');
}
```

- [ ] **Step 4: Chạy lại test để chắc chắn nó xanh**

```bash
pnpm --filter @eow/web test template-editor
```

Kỳ vọng: PASS, 5 test trong tệp (2 cũ + 3 mới).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/screens/templates/template-editor.ts apps/web/src/screens/templates/template-editor.test.ts
git commit -m "feat(web): flag an empty text body on the tab that hides it"
```

---

### Task 2: Ba tab và gom phần đuôi

**Files:**
- Modify: `apps/web/src/screens/templates/TemplateEditorScreen.tsx`

Không có test tự động ở task này — bố cục không kiểm được bằng unit test, đó chính là lý do §1.1 của spec tồn tại. Task 5 là cổng nghiệm thu.

- [ ] **Step 1: Mở rộng import và kiểu state**

Sửa dòng import từ `./template-editor.js` (hiện ở cuối khối import) thành:

```ts
import { groupTemplateCatalogue, insertTemplateVariable, textBodyNeedsAttention, type TemplateEditorField, type TemplateEditorTab } from './template-editor.js';
```

Đổi khai báo state tab (hiện là `const [tab, setTab] = useState<'preview' | 'code'>('preview');`) thành:

```ts
const [tab, setTab] = useState<TemplateEditorTab>('preview');
```

- [ ] **Step 2: Tính cờ cảnh báo**

Thêm ngay dưới các `useState`, cạnh các giá trị dẫn xuất khác:

```ts
const textNeedsAttention = textBodyNeedsAttention(analysis?.lint);
```

- [ ] **Step 3: Thay toàn bộ khối `.editor-shell` và trường văn bản thuần**

Tìm khối bắt đầu bằng `<div className="editor-shell">` và kết thúc ở dòng `</label>` của trường `template-code-field` (khối liền kề ngay sau `</div>` đóng `.editor-shell`). Thay **cả hai** bằng:

```tsx
          <div className="editor-shell template-editor-surface">
            <div className="editor-head">
              <div className="view-switch">
                <button className={tab === 'preview' ? 'active' : ''} onClick={() => setTab('preview')}>Trình soạn thảo</button>
                <button className={tab === 'code' ? 'active' : ''} onClick={() => { setTab('code'); setActiveField('html'); }}>&lt;/&gt; HTML</button>
                <button className={tab === 'text' ? 'active' : ''} onClick={() => { setTab('text'); setActiveField('textBody'); }}>
                  Văn bản thuần{textNeedsAttention && <i className="tab-warning-dot" role="img" aria-label="chưa có nội dung">●</i>}
                </button>
              </div>
              <span>{saveStatusText}</span>
            </div>
            {tab === 'preview' && <div className="compose-preview">
                  <div className="compose-preview-toolbar">
                    <div className="preview-sample-recipient"><span>Người nhận mẫu</span><b>{PREVIEW_SAMPLE.email}</b></div>
                    <div className="device-switch">
                      <button className={device === 'desktop' ? 'active' : ''} onClick={() => setDevice('desktop')}>▱ Desktop</button>
                      <button className={device === 'mobile' ? 'active' : ''} onClick={() => setDevice('mobile')}>▯ Mobile</button>
                    </div>
                  </div>
                  {savePending && <p className="field-help" role="status">Bản xem trước đang hiển thị nội dung đã lưu gần nhất; thay đổi mới sẽ xuất hiện sau khi tự động lưu xong.</p>}
                  {previewError && <p className="login-error" role="alert">{previewError}</p>}
                  {!previewError && !preview && <div className="template-preview-loading" role="status">Đang tạo bản xem trước…</div>}
                  {preview && <>
                    {/* BR-TPL-005: the server decides what is missing. Hiding
                        missingKeys would turn a preview that cannot be rendered
                        for a real recipient into one that looks complete. */}
                    {preview.missingKeys.length > 0
                      ? <div className="validation-list" role="status"><p><i>!</i>Thiếu dữ liệu mẫu cho: {preview.missingKeys.join(', ')}. Người nhận thật sẽ nhận giá trị của chính họ.</p></div>
                      : <p className="template-preview-ready" role="status">✓ Dữ liệu mẫu đã được thay đầy đủ.</p>}
                    <div className={`mail-preview-stage ${device}`}>
                      {/* srcDoc into a fully sandboxed frame: `sandbox=""` grants
                          nothing back (no scripts, no same-origin, no forms, no
                          top-level navigation), and the HTML itself was already
                          sanitized on save and again by the strict-mode renderer.
                          Nothing here can reach the app's origin or its session. */}
                      <iframe
                        className="template-preview-frame"
                        title="Bản xem trước email"
                        sandbox=""
                        srcDoc={preview.html}
                      />
                    </div>
                  </>}
                </div>}
            {tab === 'code' && <TemplateCodeView
                  value={html}
                  ranges={codeRanges}
                  onChange={(value) => { setActiveField('html'); change({ html: value }); }}
                  onCaretChange={(offset) => { htmlCaret.current = offset; }}
                />}
            {tab === 'text' && <label className="modal-field template-text-panel">
              <span>Nội dung văn bản thuần</span>
              <textarea ref={textRef} value={textBody} onFocus={() => setActiveField('textBody')} onChange={(event) => change({ textBody: event.target.value })} />
              <small className="field-help">Dùng cho hộp thư không hiển thị HTML. Để trống sẽ được hệ thống tạo lại từ HTML khi lưu.</small>
            </label>}
          </div>
```

Bốn thay đổi có chủ đích trong khối trên, đừng "sửa lại cho giống cũ":
- `rows={6}` bị gỡ khỏi textarea — CSS đã ghi đè nó từ lâu, giữ lại chỉ đánh lừa người đọc.
- `className="template-code-field"` → `template-text-panel`, để rule `:first-of-type{min-height:360px}` **không còn khớp gì cả**.
- `<label>` bọc "Người nhận mẫu" → `<div className="preview-sample-recipient">`, vì nó không có control nào để trỏ tới.
- iframe bỏ toàn bộ `style={{...}}` inline, thay bằng `className="template-preview-frame"`.

- [ ] **Step 4: Gom phần đuôi vào một khối**

Grid ba hàng cần đúng ba con trực tiếp. Bọc mọi thứ sau `.editor-shell` (từ `{analysisStale && ...}` cho tới `{actionError && ...}`) vào một khối. Mở ngay sau `</div>` đóng `.editor-shell`:

```tsx
          <div className="template-editor-trailing">
```

và đóng ngay trước `</section>` kết thúc `.template-editor-fields`:

```tsx
          </div>
```

Nội dung bên trong giữ **nguyên văn**, không sửa gì.

- [ ] **Step 5: Typecheck**

```bash
pnpm --filter @eow/web exec tsc --noEmit
```

Kỳ vọng: không lỗi. Nếu báo `textRef` không dùng nữa thì bạn đã xoá nhầm textarea — nó phải còn.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/screens/templates/TemplateEditorScreen.tsx
git commit -m "feat(web): give the plain-text body its own tab instead of the preview's space"
```

---

### Task 3: Block CSS mới

**Files:**
- Modify: `apps/web/src/app/globals.css` (**chỉ append vào cuối tệp**)

- [ ] **Step 1: Append block**

Thêm vào **cuối** `apps/web/src/app/globals.css`, sau rule `.template-version-row>button` hiện là dòng cuối:

```css
/* Template editor surface — the routed editor, not the modal it grew out of.
   The modal-era rules above assume a container with a definite height whose
   flex column scrolls. In a route the column shrinks its children instead, so
   the one child with a hard min-height (the plain-text field) won and the
   preview was clipped to nothing. Grid with minmax(0,1fr) reverses that: the
   authoring surface takes the leftover space and owns the only scroll region.
   ARCH-HANDOFF: these are new rules, not edits to approved ones. */
.template-editor-fields{display:grid;grid-template-rows:auto minmax(0,1fr) auto;align-content:stretch;overflow:visible;padding-right:0}
.template-editor-trailing{min-height:0;max-height:38%;overflow-y:auto;overscroll-behavior:contain;display:flex;flex-direction:column;gap:14px}
.template-editor-surface{min-height:0;display:flex;flex-direction:column}
.template-editor-surface>.editor-head{flex-shrink:0}
.template-editor-surface>.compose-preview{min-height:0;flex:1;padding:12px}
.template-editor-surface .mail-preview-stage{min-height:0;flex:1;padding:14px;overflow:auto}
.template-editor-surface .template-preview-frame{display:block;width:100%;height:100%;margin:0 auto;border:0;border-radius:var(--radius-md);background:#fff;box-shadow:0 8px 30px rgba(41,29,34,.1)}
.template-editor-surface .mail-preview-stage.mobile .template-preview-frame{width:390px;max-width:100%}
.template-editor-surface>.template-code-view{min-height:0;flex:1;border:0;border-radius:0}
.template-editor-surface>.template-code-view .cm-editor{height:100%;max-height:none}
.template-editor-surface>.template-code-fallback{min-height:0;flex:1;border:0;border-radius:0;resize:none}
.template-editor-surface>.template-text-panel{min-height:0;flex:1;padding:12px;display:flex;flex-direction:column;gap:6px}
.template-editor-surface>.template-text-panel textarea{min-height:0;flex:1;box-sizing:border-box;resize:none;border:1px solid var(--line);border-radius:10px;padding:11px;background:var(--surface);color:var(--ink);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.55}
.template-editor-surface>.template-text-panel small{flex-shrink:0}
.tab-warning-dot{margin-left:5px;color:var(--amber);font-style:normal;font-size:9px;vertical-align:middle}
.preview-sample-recipient{display:flex;align-items:center;gap:9px}
.preview-sample-recipient>span{font-size:var(--ui-xs);font-weight:700}
@media(max-width:900px){.template-editor-trailing{max-height:46%}}
```

Ba điểm đáng chú ý, đừng rút gọn:
- `.template-editor-trailing` có `max-height:38%` là **chốt chặn có chủ đích**. Một hàng `auto` không giới hạn sẽ lại bóp hàng `1fr` — đúng cái bẫy đã gây ra lỗi này. Khối xung đột cao tuỳ số trường đang sửa, nên nó phải tự cuộn.
- `.cm-editor{height:100%;max-height:none}` là bắt buộc. Rule đã duyệt ở dòng 352 chỉ đặt `max-height:520px` mà **không** đặt `height`, nên CodeMirror tự co theo nội dung và vẫn cao 29px kể cả sau khi khung đã đúng.
- `background:#fff` trên `.template-preview-frame` giữ canvas email luôn sáng kể cả trong dark mode, theo §5.3 tài liệu tích hợp Mailcraft. Không thay bằng `var(--surface)`.

- [ ] **Step 2: Chạy architecture tests**

```bash
pnpm --filter @eow/architecture-tests test
```

Kỳ vọng: PASS, `ARCH-HANDOFF` xanh. Bộ này chạy ~10 phút — đây là lần chạy bắt buộc vì ta vừa đụng `globals.css`.

Nếu `ARCH-HANDOFF` đỏ: bạn đã sửa một dòng có sẵn thay vì thêm dòng mới. Chạy `git diff apps/web/src/app/globals.css` và xác nhận diff **chỉ có dòng thêm ở cuối tệp**, không có dòng nào bị đổi.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/globals.css
git commit -m "fix(web): stop the modal-era rules from clipping the routed editor"
```

---

### Task 4: Kiểm chứng toàn bộ

**Files:** không sửa gì.

- [ ] **Step 1: Chạy `pnpm check`**

```bash
pnpm check
```

Kỳ vọng: xanh. **Đọc số `Test Files` và `Tests`**, đừng tin exit code. Mốc so sánh gần nhất là 1263 passed / 0 skipped trên 210 tệp; con số của bạn phải ở mức đó cộng 3 test mới ở Task 1.

Nếu `campaign-snapshot-immutability.test.ts` bỏ qua cả suite 23 test thì đó là flake dưới tải máy, chạy lại tệp đó trước khi điều tra.

- [ ] **Step 2: Commit nếu có gì thay đổi**

Nếu không có tệp nào đổi thì bỏ qua bước này.

---

### Task 5: Cổng nghiệm thu — đo trên ứng dụng chạy thật

**Files:** không sửa gì.

Đây là task quan trọng nhất của kế hoạch. Toàn bộ suite đã xanh trong suốt thời gian preview bị cắt sạch, nên "test xanh" không chứng minh được gì ở đây.

- [ ] **Step 1: Dựng stack**

```bash
pnpm deploy:up
```

Mở `http://localhost:8080`, đăng nhập `admin@example.test` / `Admin@123`, mở một template bất kỳ ở `/templates/:id/edit`.

- [ ] **Step 2: Đo ở 1440×900**

Đặt viewport 1440×900, ở tab "Trình soạn thảo", chạy trong console trình duyệt:

```js
(()=>{
 const shell=document.querySelector('.editor-shell');
 const ifr=document.querySelector('.mail-preview-stage iframe');
 const sr=shell.getBoundingClientRect(), ir=ifr.getBoundingClientRect();
 let el=ifr, scrolls=[];
 while(el && el!==document.body){const cs=getComputedStyle(el);
  if(/(auto|scroll)/.test(cs.overflowY)) scrolls.push(el.className.split(' ')[0]); el=el.parentElement;}
 return {shellH:Math.round(sr.height),
  iframeVisible:Math.round(Math.max(0,Math.min(sr.bottom,ir.bottom)-Math.max(sr.top,ir.top))),
  scrollChain:scrolls};
})()
```

| Chỉ số | Trước khi sửa | Ngưỡng đạt |
|---|---|---|
| `shellH` | 77 | > 400 |
| `iframeVisible` | **0** | > 300 |
| `scrollChain.length` | 4 | 1 |

- [ ] **Step 3: Đo tab HTML**

Bấm sang tab `</> HTML`, chạy:

```js
Math.round(document.querySelector('.cm-editor').getBoundingClientRect().height)
```

| Trước khi sửa | Ngưỡng đạt |
|---|---|
| 29 | > 300 |

- [ ] **Step 4: Đo ở 768×1024 và 390×844**

Lặp lại Step 2 ở cả hai khổ.

| Khổ | `shellH` trước | Ngưỡng đạt |
|---|---|---|
| 768×1024 | **2** | > 250 |
| 390×844 | 748 | > 250, và không sinh cuộn ngang |

Kiểm cuộn ngang: `document.documentElement.scrollWidth > innerWidth` phải là `false`.

- [ ] **Step 5: Kiểm tab văn bản thuần và huy hiệu**

Bấm sang tab "Văn bản thuần". Textarea phải lấp đầy khung, không phải 360px cố định giữa một khoảng trống.

Xoá sạch nội dung bản text, chờ autosave và phân tích chạy xong. Nhãn tab phải xuất hiện chấm cảnh báo màu hổ phách.

- [ ] **Step 6: Kiểm dark mode**

Bật dark mode. Chrome tối đi, nhưng **canvas email trong iframe phải vẫn nền sáng**. Nếu canvas tối theo thì `background:#fff` ở Task 3 đã bị sửa mất.

- [ ] **Step 7: Kiểm đủ sáu trạng thái bắt buộc**

`design-reference/ui-source-contract.yaml` quy định sáu trạng thái. Bố cục mới đổi cách chia chiều cao nên phải xem lại từng cái — một hàng grid rỗng trông rất khác một hàng flex rỗng.

| Trạng thái | Cách dựng | Phải thấy |
|---|---|---|
| `loading` | Tải lại trang, nhìn khoảnh khắc trước khi `GET` trả về | "Đang tải template…", khung không nhảy giật khi dữ liệu về |
| `empty` | Xoá sạch HTML lẫn bản text | Khung vẫn giữ đúng chiều cao, không xẹp về 0 |
| `error` | DevTools → chặn `GET /api/v1/templates/*`, tải lại | Thẻ lỗi kèm nút "Thử lại" và "Quay lại thư viện" |
| `success` | Gõ một ký tự, chờ autosave | Trạng thái lưu ở góc phải `.editor-head` đổi sang đã lưu |
| `permission_denied` | Đăng nhập tài khoản không có `content:manage` | Editor **chỉ đọc có giải thích**, không phải màn trắng hay 403 thô |
| `reconnecting` | DevTools → Offline, gõ một ký tự | Trạng thái lưu báo lỗi, nội dung đang gõ **không bị mất** |

Ngoài ra kiểm màn so sánh xung đột, vì nó là thứ chốt chặn `max-height:38%` ở Task 3 sinh ra để bảo vệ: mở cùng template ở hai tab, sửa ở tab A, rồi sửa ở tab B để ép `412`. Khối xung đột phải **tự cuộn trong hàng dưới** và **không được bóp lại khung soạn thảo** — đo lại `shellH` trong lúc khối xung đột đang hiện, nó vẫn phải > 400.

- [ ] **Step 8: Push**

Chỉ push sau khi mọi ngưỡng ở Step 2–7 đều đạt.

```bash
git push origin main
```

---

## Ngoài phạm vi

Thumbnail thư viện và projection nhẹ cho `GET /templates` — đó là Phần 2 của spec, có kế hoạch riêng và triển khai sau khi kế hoạch này đã lên `main`.

Assets API · ảnh chụp phía máy chủ · ba quyết định sanitizer của Mailcraft.
