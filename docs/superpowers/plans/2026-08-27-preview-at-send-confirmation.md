# Preview at send confirmation — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the email preview out of the compose screen's right-hand tab and into `SendConfirmOverlay` and `ScheduleSendOverlay`, rendered from a real sampled recipient plus the campaign's `variableOverrides`, with iframe containment throughout.

**Architecture:** A new pure module (`send-preview.ts`) owns two decisions that must exactly mirror the server: which sampled audience entry to preview, and how a campaign override merges against the recipient's own data. A new shared component (`SendPreviewPanel.tsx`) does the three-call fetch chain (`audience/preview` → `recipients/:id` → `template-versions/:id/preview`) and renders the result inside a sandboxed iframe, reusing `TemplatePreviewOverlay`'s layout classes. Both overlays mount it. `TemplatePreviewOverlay` itself is converted from `dangerouslySetInnerHTML` to the same iframe technique `TemplateEditorScreen.tsx` already uses (`template-preview-frame`). `ComposeDraftScreen`'s entire right-hand context panel (both "Xem trước" and "Biến dữ liệu") is deleted, per the product owner's decision that a campaign with no content of its own has nothing for that tab to point at.

**Tech Stack:** React 18 + TypeScript (apps/web), Vitest for pure-logic unit tests (this codebase has zero `.test.tsx` component tests — every existing test targets an extracted pure module, and this plan follows that convention rather than introducing React Testing Library).

**Decisions already made by the product owner (2026-08-27), do not re-litigate:**
1. `ScheduleSendOverlay` gets the same real-data preview as `SendConfirmOverlay`.
2. The "Biến dữ liệu" tab is dropped entirely, along with the whole right-hand context panel — not repurposed.
3. The preview renders the **first actionable entry** in the audience sample (no recipient picker).

**Critical, non-obvious finding from tracing the real send path** (`apps/api/src/campaigns/recipient-variable-context.ts`): at real send/snapshot time, the merge order is `{ ...configuredValues (globals < template defaults < campaign overrides), email, unsubscribe_url, first_name, last_name, ...customData }` — **the recipient's own custom-field value wins over a campaign override on a colliding key**, because `customData` is spread in last. The design spec's own prose (`{ ...recipientFields, ...variableOverrides }`) has this backwards. This plan's `buildPreviewMergeData` uses `{ ...variableOverrides, ...recipientFields }` (recipient spread last) so the preview's collision behavior matches production exactly. Task 2's tests pin this.

---

### Task 1: Add `getRecipient` to the recipients API client

**Files:**
- Modify: `apps/web/src/api/recipients.ts`
- Test: `apps/web/src/api/recipients.test.ts`

The server route (`GET /recipients/:id`, `apps/api/src/recipients/recipients.controller.ts:66`) already exists and requires only `RECIPIENT_READ`, which every role that can reach `CAMPAIGN_MANAGE` (Operator, Admin) already holds (`apps/api/src/common/permissions.ts:36`). No permission gap. The web client has no function for it yet.

- [ ] **Step 1: Write the failing test**

Add to `apps/web/src/api/recipients.test.ts`:

```ts
import { getRecipient, listRecipients } from './recipients.js';
```

(replace the existing `import { listRecipients } from './recipients.js';` line with the one above), then add a new `describe` block at the end of the file:

```ts
describe('getRecipient', () => {
  afterEach(() => vi.restoreAllMocks());

  it('fetches /recipients/:id and returns the parsed recipient', async () => {
    const body = { id: 'r1', email: 'a@x.test', firstName: 'A', lastName: null, phone: null, department: null, title: null, location: null, subscriptionStatus: 'active', customData: {}, unsubscribedAt: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await getRecipient('r1');

    expect(String(fetchMock.mock.calls[0][0])).toContain('/recipients/r1');
    expect(result.email).toBe('a@x.test');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @eow/web exec vitest run src/api/recipients.test.ts --maxWorkers=2`
Expected: FAIL — `getRecipient` is not exported from `./recipients.js`.

- [ ] **Step 3: Implement `getRecipient`**

In `apps/web/src/api/recipients.ts`, add after `deleteRecipient` (end of file):

```ts

/** GET /recipients/:id — recipient:read, same floor every CAMPAIGN_MANAGE role already holds. */
export async function getRecipient(id: string): Promise<Recipient> {
  const response = await fetch(`${base}/recipients/${id}`, { credentials: 'include' });
  if (!response.ok) await parseErrorResponse(response);
  return response.json();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @eow/web exec vitest run src/api/recipients.test.ts --maxWorkers=2`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/api/recipients.ts apps/web/src/api/recipients.test.ts
git commit -m "feat(web): add getRecipient to the recipients API client"
```

---

### Task 2: `send-preview.ts` — sample selection and the merge-precedence fix

**Files:**
- Create: `apps/web/src/overlays/send-preview.ts`
- Create: `apps/web/src/overlays/send-preview.test.ts`

This is the module that pins the acceptance criterion: *"Typing a value in 'Tùy chỉnh nội dung cho lượt gửi này' changes what the preview renders."* The original defect was that `ComposePreviewPanel` never passed `variableOverrides` into the merge data at all — an override could not reach the preview under any circumstance. The regression test below proves it now does. A second test proves the collision direction matches the real send path, not the spec prose's naive guess (see the plan header).

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/overlays/send-preview.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildPreviewMergeData, pickPreviewRecipient } from './send-preview.js';
import type { AudienceResolution } from '../api/campaigns.js';

describe('pickPreviewRecipient', () => {
  const actionable: AudienceResolution['sample'][number] = { recipientId: 'r2', normalizedEmail: 'b@x.test', displayName: 'B', subscriptionStatus: 'active', skipReason: null };
  const skipped: AudienceResolution['sample'][number] = { recipientId: 'r1', normalizedEmail: 'a@x.test', displayName: 'A', subscriptionStatus: 'unsubscribed', skipReason: 'status_unsubscribed' };

  it('returns the first sample entry with no skip reason, even when it is not first in the array', () => {
    expect(pickPreviewRecipient([skipped, actionable])?.recipientId).toBe('r2');
  });

  it('returns null when every sampled entry is skipped -- resolveAudience does not sort actionable-first, so an all-skipped sample is possible even when the full audience has actionable recipients beyond the sample limit', () => {
    expect(pickPreviewRecipient([skipped])).toBeNull();
  });

  it('returns null for an empty sample', () => {
    expect(pickPreviewRecipient([])).toBeNull();
  });
});

describe('buildPreviewMergeData (BR-CMP-005/008 preview parity with recipient-variable-context.ts)', () => {
  const recipient = { id: 'r1', email: 'minh.an@acme.vn', firstName: 'Minh An', lastName: null as string | null, customData: { department: 'Sales' } };

  it('carries a campaign override through for a key the recipient has no value for -- the defect this work fixes (ComposePreviewPanel never passed variableOverrides at all)', () => {
    const merged = buildPreviewMergeData(recipient, { cta_label: 'Đăng ký ngay' }, 'https://app.example.test');
    expect(merged.cta_label).toBe('Đăng ký ngay');
  });

  it("lets the recipient's own data win over a campaign override on a colliding key -- apps/api/src/campaigns/recipient-variable-context.ts spreads configuredValues (which includes overrides) first and customData last, so the recipient wins at real send time and the preview must match", () => {
    const merged = buildPreviewMergeData(recipient, { department: 'Marketing (giá trị mặc định)' }, 'https://app.example.test');
    expect(merged.department).toBe('Sales');
  });

  it('includes email and first_name, and omits last_name entirely when the recipient has none -- matching recipientVariableContext, so the renderer sees it as genuinely missing rather than the literal string "null"', () => {
    const merged = buildPreviewMergeData(recipient, {}, 'https://app.example.test');
    expect(merged.email).toBe('minh.an@acme.vn');
    expect(merged.first_name).toBe('Minh An');
    expect('last_name' in merged).toBe(false);
  });

  it('builds unsubscribe_url from the given web origin and recipient id, trimming a trailing slash the same way unsubscribeUrlFor does', () => {
    expect(buildPreviewMergeData(recipient, {}, 'https://app.example.test/').unsubscribe_url).toBe('https://app.example.test/unsubscribe/r1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @eow/web exec vitest run src/overlays/send-preview.test.ts --maxWorkers=2`
Expected: FAIL — cannot find module `./send-preview.js`.

- [ ] **Step 3: Implement `send-preview.ts`**

Create `apps/web/src/overlays/send-preview.ts`:

```ts
import type { AudienceResolution } from '../api/campaigns.js';
import type { Recipient } from '../api/recipients.js';

/**
 * apps/api/src/campaigns/audience-resolution.ts's resolveAudience() pushes
 * sample entries in query order, not actionable-first, so an all-skipped
 * prefix is possible even when the audience has actionable recipients
 * beyond the sample limit. Returning null in that case (rather than
 * silently falling back to a skipped entry) is deliberate -- see
 * SendPreviewPanel's noSampleRecipient state.
 */
export function pickPreviewRecipient(sample: readonly AudienceResolution['sample'][number][]): AudienceResolution['sample'][number] | null {
  return sample.find((entry) => entry.skipReason === null) ?? null;
}

/**
 * Mirrors apps/api/src/campaigns/recipient-variable-context.ts's real
 * send-time merge order exactly: campaign overrides seed the object, then
 * the recipient's actual fields are layered on top and win on a colliding
 * key. That file spreads `configuredValues` (which already contains
 * campaign overrides) first and `email`/`unsubscribe_url`/`first_name`/
 * `last_name`/`customData` after, so the recipient's own value beats an
 * override there -- a preview that resolved the opposite way would show an
 * override "winning" over data it will actually lose to at send time.
 *
 * `unsubscribe_url` is a best-effort reconstruction: the real one is built
 * from the server's WEB_ORIGIN config
 * (apps/api/src/campaigns/recipient-variable-context.ts's unsubscribeUrlFor),
 * which this client cannot read. `webOrigin` should be the browser's own
 * origin, which matches WEB_ORIGIN in every deployment this app targets.
 */
export function buildPreviewMergeData(
  recipient: Pick<Recipient, 'id' | 'email' | 'firstName' | 'lastName' | 'customData'>,
  variableOverrides: Readonly<Record<string, unknown>>,
  webOrigin: string,
): Record<string, unknown> {
  const recipientFields: Record<string, unknown> = {
    email: recipient.email,
    unsubscribe_url: `${webOrigin.replace(/\/$/, '')}/unsubscribe/${recipient.id}`,
  };
  if (recipient.firstName !== null) recipientFields.first_name = recipient.firstName;
  if (recipient.lastName !== null) recipientFields.last_name = recipient.lastName;
  for (const [key, value] of Object.entries(recipient.customData)) recipientFields[key] = value;
  return { ...variableOverrides, ...recipientFields };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @eow/web exec vitest run src/overlays/send-preview.test.ts --maxWorkers=2`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/overlays/send-preview.ts apps/web/src/overlays/send-preview.test.ts
git commit -m "feat(web): add send-preview merge logic matching real send-time precedence"
```

---

### Task 3: Convert `TemplatePreviewOverlay` from `dangerouslySetInnerHTML` to an iframe

**Files:**
- Modify: `apps/web/src/screens/templates/TemplatesScreen.tsx:118-173` (`TemplatePreviewOverlay`)
- Modify: `apps/web/src/app/globals.css`

This is trap #1 from the design doc: the richer-looking preview is the weaker one. `TemplateEditorScreen.tsx` already solved this with a `template-preview-frame` iframe class (`apps/web/src/app/globals.css:401`); reuse that exact pattern here instead of inventing a new one.

- [ ] **Step 1: Replace the `<article>` render with an iframe**

In `apps/web/src/screens/templates/TemplatesScreen.tsx`, inside `TemplatePreviewOverlay` (around line 159-165), replace:

```tsx
            <section className="template-preview-rendered" aria-label="Nội dung email đã render">
              <header><span>Nội dung người nhận sẽ thấy</span><b>{result.subject || 'Chưa có tiêu đề email'}</b></header>
              <div className={`mail-preview-stage ${device}`}>
              {/* result.html is server-sanitized (structural allowlist, no scripts/event handlers/unsafe schemes) both when the draft was saved and again by the strict-mode renderer, so re-rendering it here is safe. */}
                <article dangerouslySetInnerHTML={{ __html: result.html }} />
              </div>
            </section>
```

with:

```tsx
            <section className="template-preview-rendered" aria-label="Nội dung email đã render">
              <header><span>Nội dung người nhận sẽ thấy</span><b>{result.subject || 'Chưa có tiêu đề email'}</b></header>
              <div className={`mail-preview-stage ${device}`}>
              {/* Sandboxed and isolated from the app's own CSS -- unlike the previous
                  dangerouslySetInnerHTML render, the app's global stylesheet cannot
                  cascade into the email markup, so this shows what a recipient's
                  own mail client will actually render. sandbox="" grants nothing
                  back (no scripts, no same-origin, no forms, no top-level
                  navigation); result.html was already sanitized when saved and
                  again by the strict-mode renderer. */}
                <iframe className="template-preview-frame" title="Bản xem trước email" sandbox="" srcDoc={result.html} />
              </div>
            </section>
```

- [ ] **Step 2: Add the iframe's CSS, scoped to this overlay**

In `apps/web/src/app/globals.css`, find line 172 (the `.action-overlay.template-preview-overlay{...}` block ending in `...preflight-blockers small{color:var(--color-text-muted)}`). Immediately after that closing `}` on the same line, insert (before the `@media(max-width:900px)` block that currently follows on line 173):

```css
.template-preview-overlay .template-preview-frame{display:block;width:100%;height:100%;margin:0 auto;border:0;border-radius:var(--radius-md);background:#fff;box-shadow:0 8px 30px rgba(41,29,34,.1)}.template-preview-overlay .mail-preview-stage.mobile .template-preview-frame{width:360px;max-width:100%}
```

- [ ] **Step 3: Verify manually (no automated test — no RTL harness exists in this codebase; see plan header)**

Run `pnpm --filter @eow/web exec tsc --noEmit` to confirm the JSX/prop types are sound (no `result.html` typing issue, no unused `device` variable — `device` is still read in the `mail-preview-stage ${device}` class and the toolbar, so it stays in use).
Expected: no new type errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/screens/templates/TemplatesScreen.tsx apps/web/src/app/globals.css
git commit -m "fix(web): render TemplatePreviewOverlay in a sandboxed iframe instead of dangerouslySetInnerHTML"
```

---

### Task 4: `SendPreviewPanel.tsx` — the shared real-recipient preview component

**Files:**
- Create: `apps/web/src/overlays/SendPreviewPanel.tsx`
- Modify: `apps/web/src/app/globals.css`

- [ ] **Step 1: Write the component**

Create `apps/web/src/overlays/SendPreviewPanel.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { previewCampaignAudience, type CampaignAudience } from '../api/campaigns.js';
import { getRecipient, type Recipient } from '../api/recipients.js';
import { ApiError } from '../api/problem.js';
import { previewTemplateVersion, type TemplatePreview } from '../api/templates.js';
import { buildPreviewMergeData, pickPreviewRecipient } from './send-preview.js';

/**
 * The send/schedule confirmation's "is this what they'll actually get"
 * check (docs/superpowers/specs/2026-08-27-preview-at-send-confirmation-design.md).
 * Renders the campaign's pinned template against the first actionable
 * recipient in the live audience sample, with settings.variableOverrides
 * applied using the same precedence the real send uses -- see
 * send-preview.ts. No audience picker: the product owner chose "first
 * actionable sample entry" over a recipient picker (2026-08-27).
 */
export function SendPreviewPanel({ campaignId, audience, templateVersionId, variableOverrides }: {
  campaignId: string;
  audience: CampaignAudience;
  templateVersionId: string | null;
  variableOverrides: Record<string, unknown> | undefined;
}) {
  const [recipient, setRecipient] = useState<Recipient | null>(null);
  const [noSampleRecipient, setNoSampleRecipient] = useState(false);
  const [result, setResult] = useState<TemplatePreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setRecipient(null);
    setNoSampleRecipient(false);
    setResult(null);
    setError(null);
    if (!templateVersionId) return;
    let cancelled = false;
    previewCampaignAudience(campaignId, audience)
      .then((resolution) => {
        const sampled = pickPreviewRecipient(resolution.sample);
        if (!sampled) { if (!cancelled) setNoSampleRecipient(true); return null; }
        return getRecipient(sampled.recipientId);
      })
      .then((found) => { if (!cancelled && found) setRecipient(found); })
      .catch((cause) => { if (!cancelled) setError(cause instanceof ApiError ? cause.message : 'Không thể tải người nhận mẫu để xem trước.'); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId, templateVersionId, JSON.stringify(audience)]);

  useEffect(() => {
    setResult(null);
    if (!templateVersionId || !recipient) return;
    let cancelled = false;
    const mergeData = buildPreviewMergeData(recipient, variableOverrides ?? {}, window.location.origin);
    previewTemplateVersion(templateVersionId, mergeData)
      .then((preview) => { if (!cancelled) setResult(preview); })
      .catch((cause) => { if (!cancelled) setError(cause instanceof ApiError ? cause.message : 'Không thể tạo bản xem trước.'); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateVersionId, recipient, JSON.stringify(variableOverrides ?? {})]);

  if (!templateVersionId) return <div className="template-preview-layout send-preview"><p className="compose-variable-state" role="status">Chưa chọn template nên chưa có nội dung để xem trước.</p></div>;
  if (error) return <div className="template-preview-layout send-preview"><p className="login-error" role="alert">{error}</p></div>;
  if (noSampleRecipient) return <div className="template-preview-layout send-preview"><p className="compose-variable-state" role="status">Không tìm thấy người nhận đủ điều kiện trong mẫu để xem trước. Vẫn có thể tiếp tục gửi nếu số liệu người nhận ở trên hợp lệ.</p></div>;
  if (!recipient || !result) return <div className="template-preview-layout send-preview"><p className="compose-variable-state" role="status">Đang tạo bản xem trước…</p></div>;

  const recipientLabel = recipient.firstName ? `${recipient.firstName}${recipient.lastName ? ` ${recipient.lastName}` : ''} · ${recipient.email}` : recipient.email;

  return <div className="template-preview-layout send-preview">
    <aside className="template-preview-summary">
      <div className="mail-preview-meta">
        <div><span>Người nhận</span><b>{recipientLabel}</b></div>
        <div><span>Tiêu đề</span><b>{result.subject || 'Chưa có tiêu đề'}</b></div>
      </div>
      {/* BR-TPL-005: the server decides what is missing; hiding missingKeys
          would turn a preview that cannot be rendered for this real
          recipient into one that looks complete. */}
      {result.missingKeys.length > 0
        ? <p className="template-warning" role="status">Thiếu dữ liệu cho: {result.missingKeys.join(', ')}</p>
        : <p className="template-preview-ready" role="status">✓ Dữ liệu người nhận đã được thay đầy đủ.</p>}
    </aside>
    <section className="template-preview-rendered" aria-label="Nội dung email đã render">
      <header><span>Xem trước</span><b>{result.subject || 'Chưa có tiêu đề email'}</b></header>
      <div className="mail-preview-stage">
        {/* Same sandboxed-iframe containment as TemplatePreviewOverlay -- see
            that component for the full rationale. */}
        <iframe className="template-preview-frame" title="Bản xem trước email gửi thật" sandbox="" srcDoc={result.html} />
      </div>
    </section>
  </div>;
}
```

- [ ] **Step 2: Add scoped CSS for the panel's iframe sizing**

In `apps/web/src/app/globals.css`, append this rule near the end of the file (any line is fine — this is an additive, self-contained rule):

```css
.send-preview .mail-preview-stage{min-height:0}.send-preview .template-preview-frame{display:block;width:100%;height:340px;margin:0 auto;border:0;border-radius:var(--radius-md);background:#fff;box-shadow:0 8px 30px rgba(41,29,34,.1)}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @eow/web exec tsc --noEmit`
Expected: no errors from the new file.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/overlays/SendPreviewPanel.tsx apps/web/src/app/globals.css
git commit -m "feat(web): add SendPreviewPanel, a real-recipient email preview for terminal-commitment overlays"
```

---

### Task 5: Wire `SendPreviewPanel` into `SendConfirmOverlay`

**Files:**
- Modify: `apps/web/src/overlays/SendConfirmOverlay.tsx`

- [ ] **Step 1: Import and widen the dialog**

In `apps/web/src/overlays/SendConfirmOverlay.tsx`, add the import alongside the existing ones (top of file):

```ts
import { SendPreviewPanel } from './SendPreviewPanel.js';
```

Change the dialog's className (currently `className="action-overlay"` on line 106) to:

```tsx
    <section role="dialog" aria-modal="true" aria-labelledby="send-confirm-title" className="action-overlay modal-large" onMouseDown={(event) => event.stopPropagation()}>
```

- [ ] **Step 2: Render the panel beside the existing summary**

Immediately after the `send-summary` block (after the closing `)}` for the `{validation && (<div className="send-summary">...)}` block, i.e. right after line 120's `)}`), add:

```tsx
        {validation && <SendPreviewPanel campaignId={campaignId} audience={draft.audience} templateVersionId={draft.templateVersionId} variableOverrides={draft.settings.variableOverrides} />}
```

Gating on `validation` (rather than mounting unconditionally) means the preview's own audience-sample call doesn't race ahead of `load()`'s own `validateCampaignAudience` call, and keeps the panel appearing in the same reading order as the rest of the readiness data.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @eow/web exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/overlays/SendConfirmOverlay.tsx
git commit -m "feat(web): show the real-recipient email preview in SendConfirmOverlay"
```

---

### Task 6: Wire `SendPreviewPanel` into `ScheduleSendOverlay`

**Files:**
- Modify: `apps/web/src/overlays/ScheduleSendOverlay.tsx`

Per the product owner's decision: scheduling is the other terminal-commitment path, so it gets the same gate.

- [ ] **Step 1: Import and widen the dialog**

Add the import in `apps/web/src/overlays/ScheduleSendOverlay.tsx`:

```ts
import { SendPreviewPanel } from './SendPreviewPanel.js';
```

Change the dialog's className (currently `className="action-overlay"` around line 154) to:

```tsx
    <section role="dialog" aria-modal="true" aria-labelledby="schedule-send-title" className="action-overlay modal-large" onMouseDown={(event) => event.stopPropagation()}>
```

- [ ] **Step 2: Render the panel beside the schedule form**

Immediately after the closing `</div>` of `.schedule-send-form` (right after the `{blockers.length > 0 && ...}` block, before the `{validation && validation.missingCount > 0 && (...)}` variable-resolution block — i.e. right after line 210's `</div>`), add:

```tsx
        {validation && <SendPreviewPanel campaignId={campaignId} audience={draft.audience} templateVersionId={draft.templateVersionId} variableOverrides={draft.settings.variableOverrides} />}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @eow/web exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/overlays/ScheduleSendOverlay.tsx
git commit -m "feat(web): show the real-recipient email preview in ScheduleSendOverlay too"
```

---

### Task 7: Remove the compose screen's right-hand context panel entirely

**Files:**
- Modify: `apps/web/src/screens/compose/ComposeDraftScreen.tsx`
- Modify: `apps/web/src/app/globals.css`
- Delete: `apps/web/src/screens/compose/variable-catalogue.ts`
- Delete: `apps/web/src/screens/compose/variable-catalogue.test.ts`

Per the product owner: drop the whole tab system, not just "Xem trước" — a campaign owns no content of its own, so "Biến dữ liệu" (which only ever listed tokens with nowhere to type them) loses its reason to exist alongside it. `buildVariableCatalogue` becomes dead code once this lands (confirmed via grep: its only callers are this screen and its own test) and is deleted rather than left orphaned.

- [ ] **Step 1: Remove now-unused imports**

In `apps/web/src/screens/compose/ComposeDraftScreen.tsx`, delete these two import lines (currently lines 4-5):

```ts
import { listGlobalVariables, type ConfiguredVariable } from '../../api/configuredVariables.js';
import { listCustomFields, type CustomField } from '../../api/customFields.js';
```

Remove `getTemplateVersion, ... previewTemplateVersion, ... type TemplatePreview,` from the templates import (line 6). It currently reads:

```ts
import { getTemplateVersion, listTemplates, previewTemplateVersion, type TemplatePreview, type TemplateVersion } from '../../api/templates.js';
```

`getTemplateVersion` and `TemplateVersion` are still needed (for `overridableVariables`). Change it to:

```ts
import { getTemplateVersion, listTemplates, type TemplateVersion } from '../../api/templates.js';
```

Remove the now-unused catalogue import (line 23):

```ts
import { buildVariableCatalogue, type ComposeVariable } from './variable-catalogue.js';
```

- [ ] **Step 2: Delete `VariableRows`, `PREVIEW_SAMPLES`, `ComposePreviewPanel`**

Delete the `VariableRows` function (lines 160-161), the block comment + `PREVIEW_SAMPLES` const + `PreviewSampleKey` type (lines 164-177), and the block comment + `ComposePreviewPanel` function (lines 179-237) in full — everything from:

```ts
function VariableRows({ title, variables }: { title: string; variables: ComposeVariable[] }) {
```

down through `ComposePreviewPanel`'s closing:

```ts
}
```

(the one that ends the function right before `function stateFrom`).

- [ ] **Step 3: Remove the panel state and its supporting derived values**

In the `ComposeDraftScreen` function body, delete these lines:
- `const [query, setQuery] = useState('');`
- `const [panel, setPanel] = useState<'variables' | 'preview'>('variables');`
- `const [fields, setFields] = useState<CustomField[] | null>(null);`
- `const [globalVariables, setGlobalVariables] = useState<ConfiguredVariable[] | null>(null);`
- `const [fieldError, setFieldError] = useState<string | null>(null);`
- The `loadFields` callback:
  ```ts
  const loadFields = useCallback(async () => {
    setFieldError(null);
    try {
      const [customFields, configuredVariables] = await Promise.all([listCustomFields(), listGlobalVariables()]);
      setFields(customFields.items);
      setGlobalVariables(configuredVariables.items);
    } catch (cause) {
      setFieldError(cause instanceof ApiError ? cause.message : 'Không thể tải danh mục biến.');
    }
  }, []);
  ```
- `useEffect(() => { void loadFields(); }, [loadFields]);`
- `const catalogue = useMemo(() => buildVariableCatalogue(fields ?? []), [fields]);`
- The `configuredCatalogue` and `templateCatalogue` `useMemo` blocks:
  ```ts
  const configuredCatalogue = useMemo(() => (globalVariables ?? []).map((variable) => ({
    key: variable.key,
    label: variable.label,
    required: false,
    defaultValue: variable.defaultValue,
  })), [globalVariables]);
  const templateCatalogue = useMemo(() => Object.entries(templateVersion?.variableSchema.configured ?? {})
    .filter(([, definition]) => definition.scope === 'template')
    .map(([key, definition]) => ({
      key,
      label: definition.label,
      required: templateVersion?.variableSchema.required.includes(key) ?? false,
      defaultValue: templateVersion?.variableSchema.defaults?.[key] ?? null,
    })), [templateVersion]);
  ```
- `const matches = (variable: ComposeVariable) => !query.trim() || \`${variable.label} ${variable.key}\`.toLocaleLowerCase('vi-VN').includes(query.trim().toLocaleLowerCase('vi-VN'));`

Keep `templateVersion` itself and its loading `useEffect` (`overridableVariables` still depends on it), and keep `overridableVariables` unchanged.

- [ ] **Step 4: Delete the `<aside>` and change the wrapping grid to single-column**

Find the line rendering `<section className="compose-card" ...>...</section><aside className="context-panel" ...>...</aside></div></div>` (the long single JSX line containing `context-panel`). Replace:

```tsx
</section><aside className="context-panel" aria-label="Biến dữ liệu và xem trước"><div className="panel-switch"><button className={panel === 'variables' ? 'active' : ''} onClick={() => setPanel('variables')}>Biến dữ liệu</button><button className={panel === 'preview' ? 'active' : ''} onClick={() => setPanel('preview')}>Xem trước</button></div>{panel === 'variables' ? <><div className="panel-search"><UiIcon name="search" size={16} /><input aria-label="Tìm biến" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Tìm biến dữ liệu" /></div>{(fields === null || globalVariables === null) && !fieldError && <p className="compose-variable-state" role="status">Đang tải biến…</p>}{fieldError && <div className="compose-variable-state" role="alert"><p>{fieldError}</p><button className="secondary-button" onClick={() => void loadFields()}>Thử lại</button></div>}{fields !== null && globalVariables !== null && !fieldError && <><VariableRows title="HỆ THỐNG" variables={catalogue.system.filter(matches)} />{configuredCatalogue.length > 0 && <VariableRows title="DÙNG CHUNG" variables={configuredCatalogue.filter(matches)} />}{templateCatalogue.length > 0 && <VariableRows title="THEO TEMPLATE" variables={templateCatalogue.filter(matches)} />}{catalogue.custom.length ? <VariableRows title="DỮ LIỆU NGƯỜI NHẬN" variables={catalogue.custom.filter(matches)} /> : <p className="compose-variable-state">Chưa có biến dữ liệu người nhận phù hợp.</p>}</>}</> : <ComposePreviewPanel templateVersionId={state.draft.templateVersionId ?? null} frozen={frozen} onPickTemplate={() => setTemplatePickerOpen(true)} />}</aside></div></div>
```

with just:

```tsx
</section></div></div>
```

Then change the wrapping div's opening tag on the same overall line, from:

```tsx
<div className="email-workspace-body"><div className="compose-grid"><section className="compose-card" ref={composeCardRef}>
```

to:

```tsx
<div className="email-workspace-body"><div className="compose-grid compose-grid--single"><section className="compose-card" ref={composeCardRef}>
```

- [ ] **Step 5: Add the single-column grid override**

In `apps/web/src/app/globals.css`, append (same additive-rule approach as Task 4 Step 2 — this must not touch the base `.compose-grid` rule, which `TemplateEditorScreen.tsx` still uses as a two-column layout):

```css
.compose-grid.compose-grid--single{grid-template-columns:1fr}
```

- [ ] **Step 6: Delete the now-dead catalogue module and its test**

```bash
git rm apps/web/src/screens/compose/variable-catalogue.ts apps/web/src/screens/compose/variable-catalogue.test.ts
```

- [ ] **Step 7: Typecheck and run the full web test suite**

Run: `pnpm --filter @eow/web exec tsc --noEmit`
Expected: no errors. In particular, confirm no other file imports `variable-catalogue.js` (already checked via grep during planning — only this screen and its own test did).

Run: `pnpm --filter @eow/web exec vitest run --maxWorkers=2`
Expected: all tests pass; `variable-catalogue.test.ts` no longer exists so it won't be collected.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/screens/compose/ComposeDraftScreen.tsx apps/web/src/app/globals.css
git commit -m "refactor(web): remove the compose screen's right-hand context panel

The preview moved to send/schedule confirmation (real recipient data
instead of two fictional samples). Biến dữ liệu had no target once a
campaign owns no content of its own to type variables into -- product
owner decision, 2026-08-27."
```

---

### Task 8: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Full web test suite**

Run: `pnpm --filter @eow/web exec vitest run --maxWorkers=2`
Expected: all tests pass, including the new `send-preview.test.ts` and `recipients.test.ts` additions.

- [ ] **Step 2: Full typecheck**

Run: `pnpm --filter @eow/web exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Repo-wide check per CLAUDE.md**

Run: `pnpm check`
Expected: passes. (Per this repo's own memory: bare `pnpm test` fails two unrelated API boot tests without a build first — use `pnpm check`, not `pnpm test`, to verify.)

- [ ] **Step 4: Manual browser verification (frontend change — required, not optional)**

Using `.claude/launch.json`'s dev server config (start infra first: `pnpm infra:up`, never `pnpm deploy:up` — this machine is RAM-constrained), sign in as `admin@demo.local` in the **Demo Workspace** tenant and:

1. Open an existing campaign draft (or create one) with a published template that has at least one `allowCampaignOverride` variable and at least one actionable recipient in its audience.
2. Confirm the compose screen's right-hand panel is gone entirely — no "Biến dữ liệu" or "Xem trước" tabs, single-column layout, no empty gutter on the right.
3. Type a value into a "Tùy chỉnh nội dung cho lượt gửi này" field.
4. Click "Xem lại & xác nhận gửi" to open `SendConfirmOverlay`. Confirm the preview section appears below the readiness counts, shows a real recipient's name/email, and that the typed override actually appears in the rendered iframe content — **this is the regression check**.
5. If that recipient also happens to have their own value for the same field, confirm the recipient's value wins (matching Task 2's precedence test) — pick a template/override key that collides with a custom field if the seed data allows it; otherwise this step is covered by the unit test alone.
6. Close, click "Hẹn giờ" to open `ScheduleSendOverlay`, confirm the same preview appears there too.
7. Go to Templates, open "Xem trước email" on any template, confirm it still renders (now via iframe) and that browser dev tools show the preview `<iframe>` has its own isolated document (Elements panel: the app's `<body>` has no injected email markup outside the iframe).

Take a screenshot of the `SendConfirmOverlay` preview for the completion report.

- [ ] **Step 5: Report completion**

Summarize: what changed, the merge-precedence correction versus the spec's literal prose (and why), and confirmation that all three product-owner decisions were implemented as answered.
