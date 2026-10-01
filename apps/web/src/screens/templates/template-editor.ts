import type { TemplateVariableCatalogueItem } from '../../api/templates.js';
import { hasPermission, PERMISSIONS } from '../../auth/permissions.js';

export type TemplateEditorField = 'subject' | 'html' | 'textBody';

export function insertTemplateVariable(value: string, start: number | null, end: number | null, key: string): { value: string; caret: number } {
  const token = `{{${key}}}`;
  const safeStart = Math.max(0, Math.min(start ?? value.length, value.length));
  const safeEnd = Math.max(safeStart, Math.min(end ?? safeStart, value.length));
  return { value: `${value.slice(0, safeStart)}${token}${value.slice(safeEnd)}`, caret: safeStart + token.length };
}

export function groupTemplateCatalogue(items: readonly TemplateVariableCatalogueItem[]) {
  const order: TemplateVariableCatalogueItem['source'][] = ['system', 'global', 'recipient', 'template'];
  return order.map((source) => ({ source, items: items.filter((item) => item.source === source).sort((left, right) => left.label.localeCompare(right.label, 'vi')) }));
}

export type TemplateEditorTab = 'preview' | 'code' | 'text';

/**
 * Once the plain-text body lives behind a tab, the author can no longer see
 * that it is empty, so the tab label has to say so.
 *
 * This reads the draft directly rather than the server lint. `TEXT_BODY_EMPTY`
 * does now come back from `POST /templates/analyze` when the editor sends an
 * empty `textBody`, but that answer is a debounced round-trip behind the
 * keystroke, and a tab label that lags what the author just typed is worse than
 * one computed locally. The server code stays the signal for anything that only
 * sees a saved draft -- campaign preflight lints the published version the same
 * way. Publishing backfills the fallback (templates.service.ts:236), which is
 * why this is a note and not a warning: nothing is lost, the text is just
 * generated rather than written.
 *
 * `trim()` matches the server's own definition of empty in
 * template-content-lint.ts:29, so the two never disagree about the same draft.
 */
export function textBodyIsEmpty(textBody: string): boolean {
  return textBody.trim().length === 0;
}

/**
 * `permission_denied` for the template screens (the editor and the library
 * that leads to it), which
 * docs/frontend/mailcraft-integration-requirements.md §5.1 (from
 * design-reference/ui-source-contract.yaml → required_states) requires to be a
 * *read-only editor with an explanation*, not a blank screen and not a bare
 * 403. `content:read` is what lets such a caller load the content there is to
 * show read-only; `content:manage` is what lets them change it
 * (073_content_read_permission.sql).
 *
 * This is presentation only. Every control it disables is independently
 * enforced by the API's PermissionGuard, which is the real boundary
 * (BR-AUTH-004: "API kiem quyen phia server, khong dua vao viec an nut tren
 * UI") -- re-enabling a button in devtools buys a 403, not an edit.
 */
export function templateContentIsReadOnly(granted: readonly string[] | undefined): boolean {
  return !hasPermission(granted, PERMISSIONS.CONTENT_MANAGE);
}

/**
 * Field labels and cell text for the revision-conflict comparison (spec §2.7).
 * Shared by both editors: `TemplateEditorScreen` (origin `imported`) had them
 * privately, and `BuilderScreen` needs the same two on the same conflict, so a
 * second copy would be two ways to describe one server response.
 *
 * `projectData` is builder-only and has no readable one-line form -- it is the
 * component tree. The label says so instead of pretending an excerpt of JSON
 * tells the user anything.
 */
export const TEMPLATE_CONFLICT_FIELD_LABEL: Record<string, string> = {
  name: 'Tên template',
  subject: 'Tiêu đề email',
  html: 'Nội dung HTML',
  textBody: 'Văn bản thuần',
  projectData: 'Bố cục khối trên canvas',
};

/** A whole HTML body in a conflict cell is unreadable; the first line of it is enough to tell the two versions apart. */
export function templateConflictExcerpt(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > 120 ? `${collapsed.slice(0, 120)}…` : collapsed || '(trống)';
}

/**
 * ADR-041: `origin` decides which editor opens, and the shell must choose its
 * chrome before any template is fetched -- a single route dispatching on
 * `origin` would make layout depend on data the shell has no business
 * fetching. `TemplatesScreen` uses this everywhere it used to hardcode
 * `/edit` (Task 13); `/templates/:id/edit` uses it too, to redirect a stale
 * link for a `builder` template rather than open the wrong editor.
 */
export function editorPathFor(template: { id: string; origin: 'imported' | 'builder' }): string {
  return template.origin === 'builder' ? `/templates/${template.id}/build` : `/templates/${template.id}/edit`;
}

export type TemplateLoadFailure = 'permissionDenied' | 'loadError';

/**
 * Which failure card the editor shows when the initial GET never lands.
 *
 * A 403 here is not a broken template: it means the session's permissions no
 * longer cover reading this one -- a role changed server-side while the cached
 * `GET /auth/me` that let RequirePermission pass is still in hand. Telling that
 * user to retry a load that will keep failing is the "loi 403 tho" §5.1 rules
 * out, so it gets the permission wording instead. Everything else (404,
 * network, 5xx) is a genuine load failure and keeps the retry card.
 */
export function templateLoadFailure(status: number | undefined): TemplateLoadFailure {
  return status === 403 ? 'permissionDenied' : 'loadError';
}

/**
 * BR-TPL-005 wants the preview rendered against "recipient thật hoặc dữ liệu
 * mẫu". No audience picker belongs on an authoring surface, so one named sample
 * recipient stands in. Any custom or template variable the draft references is
 * deliberately absent from these keys, so the server reports its real name in
 * `missingKeys` instead of the preview quietly inventing a value -- which makes
 * the key set itself load-bearing and user-visible. Adding a key here removes a
 * line the author is meant to see.
 *
 * One sample, four surfaces: `TemplateEditorScreen`, `BuilderScreen` (when no
 * real recipient is picked), `TemplateVersionHistory`, and the `an` entry of
 * the picker below. They had four copies that had already drifted apart in
 * shape, so "the sample recipient" is one person everywhere it appears.
 */
const PREVIEW_SAMPLE_AN = {
  first_name: 'Minh An',
  last_name: 'Nguyễn',
  email: 'minh.an@acme.vn',
  unsubscribe_url: 'https://app.example.test/u/sample-an',
} as const;

export const TEMPLATE_PREVIEW_SAMPLE: Record<string, string> = PREVIEW_SAMPLE_AN;

/**
 * `TemplatesScreen`'s preview overlay switches between two samples, matching
 * the handoff's own composePreview sample-switch pattern. `label` is the
 * picker's option text and is not merge data -- the overlay strips it before
 * rendering; see the note at its `sendTest` call for the one place that does
 * not.
 */
export const TEMPLATE_PREVIEW_SAMPLES = {
  an: { label: 'Nguyễn Minh An · Marketing', ...PREVIEW_SAMPLE_AN },
  ha: { label: 'Trần Thu Hà · Sales', first_name: 'Thu Hà', last_name: 'Trần', email: 'thu.ha@acme.vn', unsubscribe_url: 'https://app.example.test/u/sample-ha' },
} as const;

export type TemplatePreviewSampleKey = keyof typeof TEMPLATE_PREVIEW_SAMPLES;
