import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

import { autosaveReducer, type AutosaveState } from '../../../apps/web/src/api/autosave-reducer.js';
import { BLOCK_CATALOG } from '../../../apps/web/src/screens/templates/builder/blocks.js';
import { KINDS, LEAF_KINDS, defaultTheme, type Doc, type Node } from '../../../apps/web/src/screens/templates/builder/document.js';
import { THEME_FONT_OPTIONS, THEME_FONT_SIZE_RANGE, THEME_WIDTHS } from '../../../apps/web/src/screens/templates/builder/theme-sheet.js';
import { collapseAllIds, expandAllIds, moveFocus, toggleExpanded, visibleTreeRows } from '../../../apps/web/src/screens/templates/builder/structure-tree.js';
import { ancestorsOf, bindAsset, findNode, insertNode, markDecorative, withFreshIds } from '../../../apps/web/src/screens/templates/builder/tree-ops.js';
import { emitNode } from '../../../apps/web/src/screens/templates/builder/emitter.js';
import { missingAssetNodes } from '../../../apps/web/src/screens/templates/builder/assets.js';
import { missingImportedImages } from '../../../apps/web/src/screens/templates/imported-image-sources.js';
import { lintTemplateContent, LINT_CODES } from '../../../apps/api/src/templates/template-content-lint.js';
import { sanitizeTemplateHtml } from '../../../apps/api/src/templates/template-html-sanitizer.js';
import { filterReusableBlocks } from '../../../apps/web/src/screens/templates/builder/reusable-blocks.js';
import { templateConflictExcerpt, templateContentIsReadOnly } from '../../../apps/web/src/screens/templates/template-editor.js';
import { changedVersionFields, diffVersionHtml, truncateLineDiff, versionsAreIdentical } from '../../../apps/web/src/screens/templates/version-diff.js';
import { freezeSummary, publishReadiness, LINT_ORDER } from '../../../apps/web/src/screens/templates/builder/publish-readiness.js';
import { LINT_MESSAGE } from '../../../apps/web/src/screens/templates/lint-messages.js';
// Type-only: `api/templates.ts` reads `import.meta.env` at module scope, and a
// type import is erased before this file ever runs.
import type { TemplateVersion } from '../../../apps/web/src/api/templates.js';

/**
 * ARCH-MAILCRAFT-FIDELITY -- rebuilt in S4 Task 24 because the first version
 * (Task 21) was green and blocked nothing.
 *
 * Two mutations measured against that version on 2026-09-03:
 *
 *   deleting the whole `section` block from BLOCK_CATALOG,
 *     leaving its doc comment           -> GREEN 40/40   (should have been red)
 *   keeping all 15 blocks, rewording
 *     one doc comment                   -> RED           (should have been green)
 *
 * The cause: it asserted `sourceFile.includes(actionName)`, and 21 of its 23
 * "touch points" existed only inside doc comments. It measured prose, inverted.
 * It also never read `screen-catalog.yaml` (its `CATALOG` was a hand copy whose
 * drift guards compared it to literals in the same file, so they could only ever
 * agree with themselves), and it checked no `states` at all -- which is why it
 * could not see that MC-UI-001's required `revision_conflict` state is broken in
 * `BuilderScreen.tsx`.
 *
 * What replaces it:
 *
 *  1. The catalog is PARSED from `design-reference/mailcraft-screen-catalog.yaml`
 *     (a vendored copy of the handoff's file). Every action and state the
 *     document declares must be registered below or the gate fails -- so
 *     re-syncing the vendored file surfaces new requirements instead of hiding
 *     them.
 *  2. Every requirement gets one of four checks, none of which a comment can
 *     satisfy:
 *       - `behaviour`  -- runs the real pure module and asserts what it does.
 *       - `markup`     -- requires an explicit `data-mc-action` /
 *                         `data-mc-state` attribute in the screen source, read
 *                         AFTER comments are stripped.
 *       - `unreachable`-- the state cannot occur, plus an assertion proving why.
 *       - `deferred`   -- carries a slice id that must resolve in the plan's
 *                         slice map. Not a free-text excuse.
 *  3. Deleting an implementation now turns this red; editing a comment does not.
 */

const REPO_ROOT = resolve(__dirname, '../../..');
const CATALOG_PATH = 'design-reference/mailcraft-screen-catalog.yaml';
const PLAN_PATH = 'docs/superpowers/plans/2026-08-31-mailcraft-builder-vertical-slice.md';

const BUILDER = 'apps/web/src/screens/templates/builder';
const SCREENS = 'apps/web/src/screens/templates';
/** Frozen input for the S7 report checks. See the header inside the file for why it must not be edited. */
const LOSSY_IMPORT_SAMPLE = '.agents/runs/2026-08-31-mailcraft-builder/evidence/s7-task43/lossy-import-sample.html';

function read(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), 'utf8');
}

/**
 * Removes `//`, block and `{/* JSX *\/}` comments while leaving string and
 * template literals intact, so `'https://x'` and `data-mc-action="..."` survive.
 * This is the single change that inverts the mutation result above: with it, an
 * action name written only in a comment no longer counts as evidence of
 * anything. Verified by its own tests at the bottom of this file, and by a
 * per-file sanity floor in `attributePresent` -- a stripper that ran away and
 * swallowed real code would otherwise show up as a confident false red.
 */
export function stripComments(source: string): string {
  type Mode = 'code' | 'line' | 'block' | 'single' | 'double' | 'template';
  let mode: Mode = 'code';
  let out = '';
  let i = 0;
  while (i < source.length) {
    const rest = source.slice(i, i + 2);
    const char = source[i]!;
    if (mode === 'code') {
      if (rest === '//') { mode = 'line'; i += 2; continue; }
      if (rest === '/*') { mode = 'block'; i += 2; continue; }
      if (char === "'") mode = 'single';
      else if (char === '"') mode = 'double';
      else if (char === '`') mode = 'template';
      out += char; i += 1; continue;
    }
    if (mode === 'line') {
      if (char === '\n') { mode = 'code'; out += '\n'; }
      i += 1; continue;
    }
    if (mode === 'block') {
      if (rest === '*/') { mode = 'code'; i += 2; continue; }
      if (char === '\n') out += '\n';
      i += 1; continue;
    }
    // inside a string literal: copy verbatim, honour escapes, close on the quote.
    if (char === '\\') { out += source.slice(i, i + 2); i += 2; continue; }
    if ((mode === 'single' && char === "'") || (mode === 'double' && char === '"') || (mode === 'template' && char === '`')) mode = 'code';
    out += char; i += 1;
  }
  return out;
}

const strippedCache = new Map<string, string>();
function stripped(relativePath: string): string {
  let value = strippedCache.get(relativePath);
  if (value === undefined) {
    const source = read(relativePath);
    value = stripComments(source);
    // A stripper that mistook JSX prose for a string literal could silently eat
    // the rest of a file and turn every later check into a false red. Nothing in
    // this repo comes close to half comments, so this floor only trips on a bug
    // in `stripComments`, never on ordinary code.
    expect(value.length / source.length, `stripComments() removed over half of ${relativePath} -- that is a stripper bug, not a fidelity finding`).toBeGreaterThan(0.5);
    strippedCache.set(relativePath, value);
  }
  return value;
}

function attributePresent(relativePath: string, attribute: string, qualifiedName: string): boolean {
  return stripped(relativePath).includes(`${attribute}="${qualifiedName}"`);
}

// --- catalog -----------------------------------------------------------------

type CatalogScreen = { id: string; name: string; states?: string[]; actions?: string[] };
type Catalog = { screens: CatalogScreen[] };

const catalog = load(read(CATALOG_PATH)) as Catalog;

// --- checks ------------------------------------------------------------------

/** Slice ids a `deferred` check may name. Each must resolve in the plan's slice map. */
const SLICES = ['S5', 'S6', 'S7', 'S8', 'S9', 'architecture-rejects'] as const;
type Slice = (typeof SLICES)[number];

type Check =
  | { kind: 'behaviour'; assert: () => void }
  | { kind: 'markup'; file: string }
  | { kind: 'unreachable'; reason: string; proof: () => void }
  | { kind: 'deferred'; slice: Slice; reason: string };

const behaviour = (assert: () => void): Check => ({ kind: 'behaviour', assert });
const markup = (file: string): Check => ({ kind: 'markup', file });
const unreachable = (reason: string, proof: () => void): Check => ({ kind: 'unreachable', reason, proof });
const deferred = (slice: Slice, reason: string): Check => ({ kind: 'deferred', slice, reason });

// --- fixtures for the behaviour checks ---------------------------------------

const node = (id: string, kind: Node['kind'], children?: Node[]): Node => ({ id, kind, visible: true, ...(children ? { children } : {}) });
const docWith = (...nodes: Node[]): Doc => ({ title: 'Fidelity fixture', nodes, theme: defaultTheme, variables: [] });
const emptyDoc = (): Doc => docWith();
const nestedDoc = (): Doc => docWith(node('s1', 'section', [node('r1', 'row', [node('c1', 'column', [node('t1', 'text')])])]));

const autosaveStart = (): AutosaveState<{ id: string }, { subject?: string }> => ({ draft: { id: 't1' }, pending: null, inFlight: null, status: 'saved' });

/** Drives the shared reducer to a given status the way the screens do. */
function autosaveStatusAfter(...actions: Parameters<typeof autosaveReducer>[1][]): string {
  let state: AutosaveState<{ id: string }, { subject?: string }> = autosaveStart();
  for (const action of actions) state = autosaveReducer(state, action as never) as typeof state;
  return state.status;
}

const blockOfKind = (kind: string) => BLOCK_CATALOG.find((entry) => entry.kind === kind);

/** A reusable-block listing row, for the MC-UI-004 search check. */
// `columns`/`elements` arrive with ADR-044 Task SV-4: the row preview's bar
// count and label. Irrelevant to what this fixture is for -- MC-UI-004.search
// sorts and filters by name -- but the type carries them now.
const block = (name: string) => ({ id: `id-${name}`, name, columns: 1, elements: 1, createdBy: null, createdByName: null, createdAt: '2026-09-03T00:00:00.000Z', updatedAt: '2026-09-03T00:00:00.000Z' });

/** A container block is only an `insert_section`/`_row`/`_column` if it can actually hold children. */
function assertContainerBlock(kind: 'section' | 'row' | 'column'): void {
  const entry = blockOfKind(kind);
  expect(entry, `BLOCK_CATALOG has no "${kind}" entry -- MC-UI-002 cannot insert it`).toBeDefined();
  const created = entry!.createNode();
  expect(created.kind).toBe(kind);
  expect(Array.isArray(created.children), `a "${kind}" block must be a container`).toBe(true);
  expect(insertNode(emptyDoc(), null, created).nodes).toHaveLength(1);
}

// --- the registry ------------------------------------------------------------

const ACTIONS: Record<string, Check> = {
  'MC-UI-002.insert_section': behaviour(() => { assertContainerBlock('section'); }),
  'MC-UI-002.insert_row': behaviour(() => { assertContainerBlock('row'); }),
  'MC-UI-002.insert_column': behaviour(() => { assertContainerBlock('column'); }),
  'MC-UI-002.insert_element': behaviour(() => {
    // Every leaf the model declares must be insertable, not just the ones
    // someone remembered to add -- this is the check that the earlier gate's
    // comment match could not make.
    const missing = LEAF_KINDS.filter((kind) => !blockOfKind(kind));
    expect(missing, `leaf kind(s) in document.ts with no BLOCK_CATALOG entry: ${missing.join(', ')}`).toEqual([]);
    // Inserting a leaf with nothing selected must still land it in the tree:
    // `insertNode` builds the missing section > row > column chain around it
    // rather than dropping a bare leaf at the document root, which the emitter
    // could not lay out. Asserting the ancestry is what proves the wrap happened.
    const created = blockOfKind('text')!.createNode();
    const after = insertNode(emptyDoc(), null, created);
    expect(findNode(after, created.id), 'a leaf inserted with no selection never reached the tree').toBeDefined();
    expect(ancestorsOf(after, created.id).map((ancestor) => ancestor.kind)).toEqual(['section', 'row', 'column']);
  }),

  'MC-UI-003.select_node': behaviour(() => {
    const rows = visibleTreeRows(nestedDoc(), expandAllIds(nestedDoc()));
    expect(rows.map((row) => row.id)).toContain('t1');
    expect(moveFocus(rows, 's1', 'down')).toBe('r1');
    expect(moveFocus(rows, 'r1', 'up')).toBe('s1');
  }),
  'MC-UI-003.expand_node': behaviour(() => {
    const doc = nestedDoc();
    expect(visibleTreeRows(doc, new Set()).map((row) => row.id)).toEqual(['s1']);
    expect(visibleTreeRows(doc, toggleExpanded(new Set(), 's1')).map((row) => row.id)).toEqual(['s1', 'r1']);
  }),
  'MC-UI-003.collapse_node': behaviour(() => {
    const doc = nestedDoc();
    const expanded = toggleExpanded(new Set(), 's1');
    expect(visibleTreeRows(doc, toggleExpanded(expanded, 's1')).map((row) => row.id)).toEqual(['s1']);
  }),
  'MC-UI-003.expand_all': behaviour(() => {
    const doc = nestedDoc();
    expect([...expandAllIds(doc)].sort()).toEqual(['c1', 'r1', 's1']);
    expect(visibleTreeRows(doc, expandAllIds(doc))).toHaveLength(4);
  }),
  'MC-UI-003.collapse_all': behaviour(() => {
    expect([...collapseAllIds()]).toEqual([]);
    expect(visibleTreeRows(nestedDoc(), collapseAllIds()).map((row) => row.id)).toEqual(['s1']);
  }),

  'MC-UI-006.upload_html': markup(`${SCREENS}/TemplatesScreen.tsx`),
  'MC-UI-006.analyze': markup(`${SCREENS}/TemplatesScreen.tsx`),
  /**
   * S7 Task 46. Run for real against a frozen sample rather than checked as
   * markup, because a report that renders and says the wrong thing is worse than
   * no report -- and that is exactly what the first version did: it claimed
   * `<td>`, `<tr>` and `<body>` had been deleted when they were still in the
   * output, because it counted tag names written inside an HTML comment.
   *
   * The sample is closed on purpose (Task 43 decision 4.2). The design's own
   * acceptance said "name all 16", counted from the block audit; ADR-040 gave 3
   * of those back, ADR-042 another 4, and S2 fixed the rest in the emitter, so
   * that number now measures nothing. This asserts a fixed set against fixed
   * input instead, which cannot rot as the allowlist moves.
   */
  'MC-UI-006.review_report': behaviour(() => {
    const changes = sanitizeTemplateHtml(read(LOSSY_IMPORT_SAMPLE)).changes;

    // One line per loss, all six kinds, nothing invented. Written as a whole set
    // rather than as `toContain` spot-checks: a spurious extra line is the
    // failure mode this gate exists to catch.
    expect(changes).toEqual([
      'Đã loại bỏ 1 biểu định kiểu <style> vì chứa tài nguyên hoặc biểu thức không an toàn.',
      'Đã loại bỏ 1 quy tắc @media — email sẽ dùng cùng một bố cục trên mọi thiết bị.',
      'Đã loại bỏ 1 thẻ <iframe>.',
      'Đã loại bỏ 1 thẻ <script>.',
      'Đã loại bỏ nguồn của 1 ảnh không dùng https — tải ảnh lên thư viện rồi chèn lại.',
      'Đã loại bỏ thuộc tính aria-label trên 1 phần tử — dùng title.',
      'Đã loại bỏ 1 khai báo background — dùng background-color.',
      'Đã loại bỏ 1 khai báo border-top — dùng một hàng bảng có height và background-color.',
      'Đã loại bỏ 1 khai báo font — tách thành font-size, font-weight và font-family.',
      'Đã loại bỏ 1 khai báo opacity — dùng display:none để ẩn hẳn.',
    ]);

    // Silence on clean input matters as much: a report that always says
    // something teaches people to ignore it.
    expect(sanitizeTemplateHtml('<html><body><p style="color:#111">Xin chào</p></body></html>').changes).toEqual([]);

    expect(attributePresent(`${SCREENS}/TemplatesScreen.tsx`, 'data-mc-action', 'MC-UI-006.review_report')).toBe(true);
  }),
  'MC-UI-006.create_draft': markup(`${SCREENS}/TemplatesScreen.tsx`),

  // ADR-044 Task SV-2 (decision 2) moved MC-UI-007 out of the inspector's
  // generic Document field list -- which no longer exists -- and into the
  // prototype's theme sheet. These four checks moved with it, and they check
  // two things per action on purpose: the values the widget offers, and the
  // key it writes. A Segment showing three widths that patches nothing would
  // pass a screenshot and fail a reader.
  'MC-UI-007.change_width': behaviour(() => {
    expect(THEME_WIDTHS, 'MC-UI-007 change_width: the theme sheet Segment must offer the prototype three widths').toEqual([600, 640, 720]);
    expect(stripped(`${BUILDER}/BuilderScreen.tsx`), 'the width Segment does not patch `width`').toContain("onPatch('width'");
  }),
  'MC-UI-007.change_typography': behaviour(() => {
    expect(THEME_FONT_OPTIONS.length, 'MC-UI-007 change_typography: no font stacks to choose from').toBeGreaterThan(1);
    expect(THEME_FONT_SIZE_RANGE).toEqual({ min: 12, max: 18 });
    const source = stripped(`${BUILDER}/BuilderScreen.tsx`);
    expect(source).toContain("onPatch('fontFamily'");
    expect(source).toContain("onPatch('baseFontSize'");
  }),
  'MC-UI-007.change_surface': behaviour(() => {
    const source = stripped(`${BUILDER}/BuilderScreen.tsx`);
    expect(source, 'MC-UI-007 change_surface: the theme sheet does not patch the outer background').toContain("onPatch('outerBg'");
    expect(source, 'MC-UI-007 change_surface: the theme sheet does not patch the content background').toContain("onPatch('contentBg'");
  }),
  'MC-UI-007.change_responsive_rules': behaviour(() => {
    expect(stripped(`${BUILDER}/BuilderScreen.tsx`), 'MC-UI-007 change_responsive_rules: no `stackColumns` control -- see EmailTheme.stackColumns').toContain("onPatch('stackColumns'");
  }),

  'MC-UI-008.switch_device': markup(`${BUILDER}/BuilderScreen.tsx`),
  'MC-UI-008.render_variables': markup(`${BUILDER}/BuilderScreen.tsx`),
  'MC-UI-008.run_content_review': markup(`${BUILDER}/BuilderScreen.tsx`),

  // S8 Task 48. Markup alone would prove only that a button carrying the touch
  // point exists. The claim worth gating is that comparing two versions really
  // does distinguish them: the plan told this task to reuse
  // `templateConflictExcerpt`, and that reuse was measured and rejected -- the
  // builder emitter writes a fixed 367-character preamble before any content,
  // so the excerpt's 120-character budget never reaches the part that differs.
  // Both halves are asserted, so restoring the excerpt for `html`, regressing
  // the truncation back to a first-N-lines cut, or dropping the button, each
  // fail here.
  'MC-UI-009.compare': behaviour(() => {
    const version = (over: Partial<TemplateVersion>): TemplateVersion => ({
      id: 'v', templateId: 't', version: 1, subject: 'Chao', html: '', textBody: '',
      variableSchema: { required: [], optional: [] }, contentHash: 'h',
      publishedAt: '2026-09-01T00:00:00.000Z', ...over,
    });
    const preamble = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background-color:${defaultTheme.outerBg};font-family:${defaultTheme.fontFamily};font-size:${defaultTheme.baseFontSize}px"><table role="presentation" width="100%"><tr><td align="center"><table role="presentation" width="${defaultTheme.width}" style="width:100%;max-width:${defaultTheme.width}px;background-color:${defaultTheme.contentBg}">`;
    const left = version({ contentHash: 'a', html: `${preamble}<p>Gia 199</p></table></td></tr></table></body></html>` });
    const right = version({ contentHash: 'b', html: `${preamble}<p>Gia 149</p></table></td></tr></table></body></html>` });

    // The excerpt really is blind here; without this the rest proves nothing.
    expect(templateConflictExcerpt(left.html)).toBe(templateConflictExcerpt(right.html));

    expect(versionsAreIdentical(left, right)).toBe(false);
    expect(changedVersionFields(left, right)).toContain('html');
    // What a display cell actually receives still carries the change -- a cut
    // that kept the first N entries would show only the shared preamble.
    const shown = truncateLineDiff(diffVersionHtml(left, right), 8).entries.map((entry) => entry.line).join('|');
    expect(shown).toContain('Gia 199');
    expect(shown).toContain('Gia 149');

    expect(attributePresent(`${SCREENS}/TemplateVersionHistory.tsx`, 'data-mc-action', 'MC-UI-009.compare')).toBe(true);
  }),
  // S8 Task 47. Wiring an endpoint that already existed
  // (POST /template-versions/:id/preview) into the shared history component --
  // markup is the right check, the same one `create_draft` below uses.
  'MC-UI-009.preview': markup(`${SCREENS}/TemplateVersionHistory.tsx`),
  'MC-UI-009.create_draft': markup(`${SCREENS}/TemplateEditorScreen.tsx`),

  // S9 Task 52. The header button no longer posts -- it opens the summary
  // sheet. Markup alone would only prove a button carries the touch point, so
  // the rule that summary exists to enforce is asserted too: an undeclared
  // variable refuses publication BEFORE the request, which is what §2.9 asks
  // for and what `templates.service.ts` would otherwise answer with a 4xx
  // after the click.
  'MC-UI-010.validate': behaviour(() => {
    // ADR-050: a footer with a real address, so this draft also clears the
    // MISSING_POSTAL_ADDRESS gate -- this check is about MC-UI-010/BR-TPL-008,
    // not about postal-address coverage, which `publish-readiness.test.ts`
    // owns.
    const footerDoc: Doc = { title: 't', nodes: [{ id: 'footer', kind: 'footer', visible: true, footer: { companyName: 'Alta Software', address: '123 Duong Lang, Ha Noi' } } as Node], variables: [] };
    const draft = { name: 'Chao mung', subject: 'Chao {{first_name}}', html: '<p>Chao {{first_name}} -- {{unsubscribe_url}}</p>', textBody: 'Chao', doc: footerDoc };
    const clean = { validation: { warnings: [], errors: [], changes: [] }, unknownVariables: [], lint: [] };
    expect(publishReadiness(draft, clean).canPublish).toBe(true);

    const undeclared = { ...clean, unknownVariables: [{ field: 'html' as const, key: 'ten_sep', start: 0, end: 0, classification: 'unknown' as const, source: 'unknown' as const, label: null, suggestedActions: [] }] };
    const blocked = publishReadiness(draft, undeclared);
    expect(blocked.canPublish).toBe(false);
    expect(blocked.blocking.some((item) => item.message.includes('ten_sep'))).toBe(true);

    // This used to assert the opposite, on the reasoning that "BR-TPL-008's
    // missing unsubscribe link fails at send time, not at authoring time".
    // Measured 2026-09-11: no send-time gate exists anywhere in apps/api or
    // apps/worker, so that deferral meant nobody checked. ADR-049 built the
    // opt-out route that makes the requirement real, and the check blocks.
    const noUnsubscribe = publishReadiness({ ...draft, html: '<p>Chao</p>', textBody: 'Chao' }, clean);
    expect(noUnsubscribe.canPublish).toBe(false);
    expect(noUnsubscribe.blocking.some((item) => item.id === 'MISSING_UNSUBSCRIBE_URL')).toBe(true);

    // The four boxes that replaced the prototype's Provider/Resource table
    // have to carry real numbers, or the deviation bought nothing.
    const summary = freezeSummary({ currentVersion: 2, doc: nestedDoc(), html: '<p>x</p>', variableKeys: ['first_name', 'first_name'] });
    expect(summary.nextVersion).toBe(3);
    expect(summary.variableCount).toBe(1);

    expect(attributePresent('apps/web/src/app/AppShell.tsx', 'data-mc-action', 'MC-UI-010.validate')).toBe(true);
  }),
  'MC-UI-010.publish': markup(`${BUILDER}/BuilderScreen.tsx`),
  'MC-UI-010.retry_registration': deferred('architecture-rejects', 'there is no registration step to retry: this action assumes Mailcraft is a separate service registering through a connector, and none of the five extraction criteria in spec §3.3 is true (see also §5.1). Plan Task 55 records it rather than building it.'),

  'MC-UI-011.edit_sanitized_html': markup(`${BUILDER}/BuilderScreen.tsx`),
  'MC-UI-011.validate': markup(`${BUILDER}/BuilderScreen.tsx`),
  // Twice wrong before this, in opposite directions. Task 21 recorded it as a
  // real touch point because "preview" occurs 25 times in BuilderScreen.tsx
  // (previewOpen, previewError, previewTemplateDraft) -- the gate asserting
  // the reverse of the code. The correction then filed it as `deferred('S8')`,
  // which S8 closed without building, leaving an address pointing at a
  // finished slice: debt that can never clear, exactly what ARCH-MAILCRAFT-DOM
  // refuses in its own register.
  //
  // Neither is right, because the action is not missing. `CustomHtmlEditor`'s
  // own comment states the decision: a node-scoped preview "would just be a
  // worse copy of the same render", since the header's preview already renders
  // the whole document with this node emitted verbatim inside it. So this is a
  // behaviour check on that claim -- if the emitter ever stopped putting the
  // block's html in the document, the header preview would silently stop
  // showing it and the decision would no longer hold.
  'MC-UI-011.preview': behaviour(() => {
    const custom: Node = { id: 'c1', kind: 'customHtml', visible: true, html: '<p>Xin chao</p>' };
    expect(emitNode(custom)).toContain('<p>Xin chao</p>');
    // And with a stylesheet, still the author's own markup -- not a summary,
    // not a placeholder.
    expect(emitNode({ ...custom, css: '.lead{color:#173f33}' })).toContain('<p>Xin chao</p>');
    // The mechanism that renders it: the document preview's own iframe.
    expect(attributePresent(`${BUILDER}/BuilderScreen.tsx`, 'data-mc-action', 'MC-UI-008.render_variables')).toBe(true);
  }),

  // S5 built these. `search` is the one with real logic outside the component
  // (local filtering, Vietnamese collation), so it gets a behaviour check; the
  // other four are surfaces, tagged in the panel.
  'MC-UI-004.search': behaviour(() => {
    const library = [block('Zulu'), block('Ảnh bìa'), block('Chân trang')];
    expect(filterReusableBlocks(library, '').map((item) => item.name)).toEqual(['Ảnh bìa', 'Chân trang', 'Zulu']);
    expect(filterReusableBlocks(library, 'chan').map((item) => item.name)).toEqual(['Chân trang']);
    expect(attributePresent(`${BUILDER}/BuilderScreen.tsx`, 'data-mc-action', 'MC-UI-004.search')).toBe(true);
  }),
  'MC-UI-004.insert': markup(`${BUILDER}/BuilderScreen.tsx`),
  'MC-UI-004.rename': markup(`${BUILDER}/BuilderScreen.tsx`),
  'MC-UI-004.delete': markup(`${BUILDER}/BuilderScreen.tsx`),
  'MC-UI-004.save_current_tree': behaviour(() => {
    // Inserting a saved block must not duplicate ids: two inserts of one block
    // would otherwise collide on every id-keyed operation.
    const saved: Node = { id: 'a', kind: 'section', visible: true, children: [{ id: 'b', kind: 'text', visible: true }] };
    const first = withFreshIds(saved);
    const second = withFreshIds(saved);
    expect(first.id).not.toBe(saved.id);
    expect(first.id).not.toBe(second.id);
    expect(first.children?.[0]?.id).not.toBe(second.children?.[0]?.id);
    expect(attributePresent(`${BUILDER}/BuilderScreen.tsx`, 'data-mc-action', 'MC-UI-004.save_current_tree')).toBe(true);
  }),
  // MC-UI-005 (S6). `upload` and `replace` are network calls with no pure
  // surface to run, so they are markup checks. `bind` and `mark_decorative` are
  // document operations, so they are run for real -- and `mark_decorative` is
  // run through all four layers it has to survive, because Task 39 measured
  // that it was silently dying at the third.
  'MC-UI-005.upload': markup(`${BUILDER}/BuilderScreen.tsx`),
  'MC-UI-005.replace': markup(`${BUILDER}/BuilderScreen.tsx`),
  'MC-UI-005.bind': behaviour(() => {
    const image: Node = { id: 'img-1', kind: 'image', visible: true };
    const doc: Doc = { title: 'T', nodes: [image], variables: [], theme: defaultTheme };
    const url = 'https://app.example.test/api/v1/assets/0f9a1c3e-2b7d-4a51-9c8e-6d4b2f0a7e13/logo.png';
    expect(findNode(bindAsset(doc, 'img-1', url), 'img-1')).toMatchObject({ src: url });
    // The refusals are the point: binding a source the sanitizer strips would
    // manufacture the missing_assets state this same screen reports.
    expect(bindAsset(doc, 'img-1', 'http://cdn.test/logo.png')).toBe(doc);
    expect(bindAsset({ ...doc, nodes: [{ id: 'img-1', kind: 'text', visible: true }] }, 'img-1', url).nodes[0]).not.toHaveProperty('src');
    expect(attributePresent(`${BUILDER}/BuilderScreen.tsx`, 'data-mc-action', 'MC-UI-005.bind')).toBe(true);
  }),
  'MC-UI-005.mark_decorative': behaviour(() => {
    const image: Node = { id: 'img-1', kind: 'image', visible: true, src: 'https://cdn.example.test/a.png', alt: 'Ảnh sản phẩm' };
    const doc: Doc = { title: 'T', nodes: [image], variables: [], theme: defaultTheme };
    const marked = findNode(markDecorative(doc, 'img-1', true), 'img-1')!;

    // 1. the model carries the flag, and keeps the words so unmarking restores them
    expect(marked).toMatchObject({ decorative: true, alt: 'Ảnh sản phẩm' });
    // 2. the emitter turns it into BOTH halves -- an empty alt alone is ambiguous
    const emitted = emitNode(marked);
    expect(emitted).toContain('alt=""');
    expect(emitted).toContain('role="presentation"');
    // 3. the sanitizer keeps them. This is the layer that was silently dropping
    //    `role` until Task 39 measured it, which made ADR-043 §8 unimplementable.
    const { html } = sanitizeTemplateHtml(emitted);
    expect(html).toContain('role="presentation"');
    // 4. and the lint agrees it is deliberate rather than forgotten
    expect(lintTemplateContent({ html, textBody: 'Nội dung' }).map((issue) => issue.code)).not.toContain('IMAGE_ALT_MISSING');
    // ...while an undescribed image is still called out
    expect(lintTemplateContent({ html: sanitizeTemplateHtml(emitNode({ ...image, alt: '' })).html, textBody: 'Nội dung' }).map((issue) => issue.code)).toContain('IMAGE_ALT_MISSING');

    expect(attributePresent(`${BUILDER}/BuilderScreen.tsx`, 'data-mc-action', 'MC-UI-005.mark_decorative')).toBe(true);
  }),
};

const STATES: Record<string, Check> = {
  // MC-UI-001 -- the shared autosave reducer is the pure surface behind five of
  // these six, so they are checked against what it actually computes.
  'MC-UI-001.clean': behaviour(() => { expect(autosaveStatusAfter({ type: 'saved', draft: { id: 't1' } })).toBe('saved'); }),
  'MC-UI-001.dirty': behaviour(() => { expect(autosaveStatusAfter({ type: 'change', patch: { subject: 'x' } })).toBe('idle'); }),
  'MC-UI-001.saving': behaviour(() => { expect(autosaveStatusAfter({ type: 'change', patch: { subject: 'x' } }, { type: 'start' })).toBe('saving'); }),
  'MC-UI-001.save_failed': behaviour(() => {
    expect(autosaveStatusAfter({ type: 'change', patch: { subject: 'x' } }, { type: 'start' }, { type: 'failed', conflict: false })).toBe('error');
  }),
  // The state the Task 21 gate structurally could not see, because it checked no
  // states at all. The reducer reaches 'conflict' correctly; the builder screen
  // is what has to hold there and offer the comparison (spec §2.7 -- five
  // autosave states, and "khong duoc lang le ghi de"), so this needs both halves.
  'MC-UI-001.revision_conflict': behaviour(() => {
    expect(autosaveStatusAfter({ type: 'change', patch: { subject: 'x' } }, { type: 'start' }, { type: 'failed', conflict: true })).toBe('conflict');
    expect(
      attributePresent(`${BUILDER}/BuilderScreen.tsx`, 'data-mc-state', 'MC-UI-001.revision_conflict'),
      'BuilderScreen.tsx has no revision_conflict surface. Spec §2.7 requires a fifth autosave state and a comparison the user chooses from; reloading the server copy behind a toast is the silent overwrite that section forbids.',
    ).toBe(true);
  }),
  'MC-UI-001.permission_denied': behaviour(() => {
    expect(templateContentIsReadOnly(['content:read'])).toBe(true);
    expect(templateContentIsReadOnly(['content:read', 'content:manage'])).toBe(false);
    expect(attributePresent(`${BUILDER}/BuilderScreen.tsx`, 'data-mc-state', 'MC-UI-001.permission_denied')).toBe(true);
  }),

  'MC-UI-002.loading': unreachable('BLOCK_CATALOG is a static pure module -- the Insert panel has nothing to fetch', () => {
    expect(BLOCK_CATALOG.length).toBeGreaterThan(0);
  }),
  'MC-UI-002.empty': unreachable('the block library can never be empty: it is asserted to cover every kind the model declares', () => {
    expect([...BLOCK_CATALOG].map((entry) => entry.kind).sort()).toEqual([...KINDS].sort());
  }),
  'MC-UI-002.success': markup(`${BUILDER}/BuilderScreen.tsx`),

  'MC-UI-003.loading': unreachable('the tree is derived synchronously from the in-memory document, never fetched', () => {
    expect(visibleTreeRows(nestedDoc(), new Set())).toHaveLength(1);
  }),
  'MC-UI-003.empty': behaviour(() => {
    expect(visibleTreeRows(emptyDoc(), new Set())).toEqual([]);
    expect(attributePresent(`${BUILDER}/BuilderScreen.tsx`, 'data-mc-state', 'MC-UI-003.empty')).toBe(true);
  }),
  'MC-UI-003.success': markup(`${BUILDER}/BuilderScreen.tsx`),

  'MC-UI-007.clean': behaviour(() => { expect(autosaveStatusAfter({ type: 'saved', draft: { id: 't1' } })).toBe('saved'); }),
  'MC-UI-007.dirty': behaviour(() => { expect(autosaveStatusAfter({ type: 'change', patch: { subject: 'x' } })).toBe('idle'); }),
  'MC-UI-007.save_failed': behaviour(() => {
    expect(autosaveStatusAfter({ type: 'change', patch: { subject: 'x' } }, { type: 'start' }, { type: 'failed', conflict: false })).toBe('error');
  }),

  'MC-UI-008.loading': markup(`${BUILDER}/BuilderScreen.tsx`),
  'MC-UI-008.success': markup(`${BUILDER}/BuilderScreen.tsx`),
  'MC-UI-008.error': markup(`${BUILDER}/BuilderScreen.tsx`),
  'MC-UI-008.permission_denied': behaviour(() => {
    // Spec §2.1: read-only shows everything, and only disables the write paths --
    // preview and lint must stay visible, so this shares MC-UI-001's surface.
    expect(templateContentIsReadOnly(undefined)).toBe(true);
    expect(attributePresent(`${BUILDER}/BuilderScreen.tsx`, 'data-mc-state', 'MC-UI-001.permission_denied')).toBe(true);
  }),

  'MC-UI-011.clean': behaviour(() => { expect(autosaveStatusAfter({ type: 'saved', draft: { id: 't1' } })).toBe('saved'); }),
  'MC-UI-011.dirty': behaviour(() => { expect(autosaveStatusAfter({ type: 'change', patch: { subject: 'x' } })).toBe('idle'); }),
  'MC-UI-011.error': markup(`${BUILDER}/BuilderScreen.tsx`),
  'MC-UI-011.permission_denied': behaviour(() => {
    // Same single read-only surface as MC-UI-001/008: spec §2.1 is explicit that
    // read-only shows the whole screen and disables only the write paths, so a
    // per-workspace permission banner would be three notices for one condition.
    expect(templateContentIsReadOnly([])).toBe(true);
    expect(attributePresent(`${BUILDER}/BuilderScreen.tsx`, 'data-mc-state', 'MC-UI-001.permission_denied')).toBe(true);
  }),

  'MC-UI-006.file_selected': markup(`${SCREENS}/TemplatesScreen.tsx`),
  'MC-UI-006.import_analyzing': markup(`${SCREENS}/TemplatesScreen.tsx`),
  'MC-UI-006.error': markup(`${SCREENS}/TemplatesScreen.tsx`),
  // S7 Task 46. Both are rendering branches whose content is already proved by
  // `review_report` above, so markup is the right check for them.
  'MC-UI-006.import_partial': markup(`${SCREENS}/TemplatesScreen.tsx`),
  'MC-UI-006.import_fallback': markup(`${SCREENS}/TemplatesScreen.tsx`),
  /**
   * Run for real, exactly as MC-UI-005's version is, and for the same reason: it
   * is computed rather than rendered, so it is the one state here that can be
   * wrong while still looking perfectly fine on screen.
   *
   * Read from the HTML the author supplied. The sanitized copy has already had
   * these addresses removed and can only say how many went, never which -- and
   * ADR-043's rule is to list, never repair, which needs the address.
   */
  'MC-UI-006.missing_assets': behaviour(() => {
    const found = missingImportedImages(read(LOSSY_IMPORT_SAMPLE));
    expect(found).toEqual([{ src: 'http://cdn.example.test/hero.png', alt: 'Ảnh đầu thư' }]);

    // https and cid both survive sanitization, so neither is missing. This is
    // deliberately looser than the builder's https-only rule: the builder cannot
    // mint a cid reference, an imported newsletter legitimately can, and calling
    // that image missing would be a lie.
    expect(missingImportedImages('<img src="https://cdn.test/a.png"><img src="cid:logo">')).toEqual([]);

    // The three that look servable and are not, all measured against the real
    // sanitizer in Task 32. Asserted here because a rule that only catches
    // `http:` passes every other check on this page while leaving three ways for
    // an image to vanish silently -- which is the whole failure this state names.
    expect(missingImportedImages('<img src="//cdn.test/a.png"><img src="/api/v1/assets/x/a.png"><img src="data:image/png;base64,AAAA">'))
      .toHaveLength(3);

    expect(attributePresent(`${SCREENS}/TemplatesScreen.tsx`, 'data-mc-state', 'MC-UI-006.missing_assets')).toBe(true);
  }),

  'MC-UI-004.loading': markup(`${BUILDER}/BuilderScreen.tsx`),
  'MC-UI-004.empty': markup(`${BUILDER}/BuilderScreen.tsx`),
  'MC-UI-004.success': markup(`${BUILDER}/BuilderScreen.tsx`),
  'MC-UI-004.error': markup(`${BUILDER}/BuilderScreen.tsx`),
  // MC-UI-005 (S6 Task 38). Four library states are markup; `missing_assets` is
  // computed from the document, so it is run for real -- it is the only one of
  // the five that can be wrong while still rendering.
  ...Object.fromEntries((['loading', 'empty', 'success', 'error'] as const).map((state) => [
    `MC-UI-005.${state}`, markup(`${BUILDER}/BuilderScreen.tsx`),
  ])),
  'MC-UI-005.missing_assets': behaviour(() => {
    const doc: Doc = {
      title: 'T', variables: [], theme: defaultTheme,
      nodes: [
        { id: 'unbound', kind: 'image', visible: true },
        { id: 'stripped', kind: 'banner', visible: true, src: 'http://cdn.example.test/hero.png' },
        { id: 'fine', kind: 'image', visible: true, src: 'https://cdn.example.test/ok.png' },
        { id: 'wordmark', kind: 'logo', visible: true, content: 'ALTA' },
      ],
    };
    // The unbound image and the stripped banner, and nothing else: an https
    // source is fine wherever it is hosted, and a logo without a src falls back
    // to a real text wordmark rather than vanishing.
    expect(missingAssetNodes(doc).map((entry) => [entry.id, entry.reason])).toEqual([['unbound', 'unbound'], ['stripped', 'not_https']]);
    expect(attributePresent(`${BUILDER}/BuilderScreen.tsx`, 'data-mc-state', 'MC-UI-005.missing_assets')).toBe(true);
  }),
  // S8 Tasks 47/48 gave the version history the state model it never had: the
  // shared `TemplateVersionHistory` renders all four branches -- `empty` for
  // "nothing published yet", and `loading`/`error`/`success` for both the
  // preview fetch and the two-version compare fetch.
  ...Object.fromEntries((['loading', 'empty', 'success', 'error'] as const).map((state) => [
    `MC-UI-009.${state}`, markup(`${SCREENS}/TemplateVersionHistory.tsx`),
  ])),
  // S9 Task 53. All four now exist as branches of the publish sheet's own
  // flow state, each carrying its literal touch point -- written as separate
  // JSX branches rather than one element with a computed attribute, because
  // `attributePresent` greps the source for the literal string.
  ...Object.fromEntries((['publish_validating', 'publishing', 'published', 'publish_failed'] as const).map((state) => [
    `MC-UI-010.${state}`, markup(`${BUILDER}/BuilderScreen.tsx`),
  ])),
  'MC-UI-010.registration_pending': deferred('architecture-rejects', 'the pending half of retry_registration: no connector registration exists to be pending on (spec §5.1).'),
};

/**
 * ADR-044. The block set is read out of the vendored prototype rather than
 * copied into a list here, because a copied list is exactly how `contact` went
 * missing: `blocks.test.ts` carried a hand-written LAUNCH_KINDS whose own
 * comment said "the Mailcraft handoff is the acceptance standard and nothing
 * gets cut from it", and it had fifteen entries where the prototype has sixteen.
 * A list that agrees with itself cannot notice an omission.
 *
 * One rename is allowed, and it is spelled out rather than pattern-matched:
 * `custom` is `customHtml` here (MC-UI-011, S4 Task 20). Any other difference is
 * a block that was added or dropped without a decision, and this fails.
 */
const PROTOTYPE_KIND_RENAMES: Readonly<Record<string, string>> = { custom: 'customHtml' };

/**
 * Kinds EOW has that the prototype does not, each with an address.
 *
 * ADR-044 clause 4 is the rule: a deliberate deviation must be recorded with an
 * ADR or slice number, never left silent. This register is that record, and it
 * is deliberately not a loosening -- the gate below still fails for any kind
 * that is neither in the prototype nor named here, which is the case its own
 * comment exists to catch ("added or dropped without a decision").
 *
 * ADR-044 is a decision about VISUAL truth; `ARCH-MAILCRAFT-DOM` quotes it
 * saying so when it rejects `v3-widths` -- "the decision is purely visual and
 * does not touch the model or the emitter". A block kind the product needs is a
 * model decision, so it is in scope for an ADR of its own rather than barred by
 * this one.
 */
const ADDED_KINDS: Readonly<Record<string, string>> = {
  // ADR-048. The prototype has no list block at all; measured 2026-09-11, a
  // `<ul>` inside the `<p>` that `emitText` produces splits the paragraph and
  // orphans an empty `<p></p>`, so a list cannot be an inline mark either
  // (ADR-046 rejected that on the same measurement). It has to be a kind.
  list: 'adr-048-the-list-block.md',
  // ADR-050. The prototype has no footer/postal-address block either --
  // measured against studio.tsx's own `type Kind` union, which this test
  // parses directly. CAN-SPAM requires a physical address on commercial
  // email; audit backlog §4 found zero words about it anywhere in the repo.
  footer: 'adr-050-the-footer-block-and-postal-address.md',
};

function prototypeKinds(): string[] {
  const source = read('design-reference/mailcraft-ui-handoff-v1/source/app/studio.tsx');
  const union = /type Kind\s*=\s*([^;]+);/.exec(source);
  expect(union, 'studio.tsx no longer declares `type Kind` -- the gate cannot read the block set').not.toBeNull();
  return [...union![1].matchAll(/"([a-zA-Z]+)"/g)]
    .map((match) => PROTOTYPE_KIND_RENAMES[match[1]] ?? match[1])
    .sort();
}

describe('ARCH-MAILCRAFT-SOURCE: the block set matches the prototype it was ported from', () => {
  const expected = [...prototypeKinds(), ...Object.keys(ADDED_KINDS)].sort();

  it('declares every kind the prototype declares, and invents none without an ADR', () => {
    expect([...KINDS].sort()).toEqual(expected);
  });

  it('gives each of them a catalog entry, so a declared kind is actually insertable', () => {
    expect(BLOCK_CATALOG.map((entry) => entry.kind).sort()).toEqual(expected);
  });

  it('drops no prototype kind, whatever the register says', () => {
    // The register may only ADD. A prototype kind going missing is the failure
    // that let `contact` disappear, and no entry here may hide one.
    const missing = prototypeKinds().filter((kind) => !(KINDS as readonly string[]).includes(kind));
    expect(missing, `prototype kind(s) no longer declared: ${missing.join(', ')}`).toEqual([]);
  });

  it('points every added kind at an ADR that exists and names it', () => {
    for (const [kind, adr] of Object.entries(ADDED_KINDS)) {
      const text = read(`docs/adr/${adr}`);
      expect(text.length, `${adr} does not exist to justify the "${kind}" kind`).toBeGreaterThan(0);
      expect(text, `${adr} never mentions the "${kind}" kind it is cited for`).toContain(kind);
    }
  });
});

/**
 * ARCH-LINT-CODES (ADR-051). `LINT_ORDER` in `publish-readiness.ts` is a
 * plain array, not derived from `LINT_CODES` (`template-content-lint.ts`)
 * the way `KINDS`/`BLOCK_CATALOG` are checked against each other above --
 * nothing stopped a code added to one from never reaching the other, and
 * `LINT_MESSAGE`'s compiler-enforced `Record` would not catch it either
 * (`LINT_ORDER` filters `analysis.lint` by membership, so a code missing
 * from it simply never appears in the publish sheet -- no type error, no
 * runtime error, just a warning nobody sees). This is the mechanized version
 * of that check.
 */
describe('ARCH-LINT-CODES: every server lint code reaches the publish-readiness sheet', () => {
  it('LINT_ORDER carries exactly the codes LINT_CODES declares, order aside', () => {
    expect([...LINT_ORDER].sort()).toEqual([...LINT_CODES].sort());
  });

  it('LINT_MESSAGE has Vietnamese copy for every one (compiler already enforces this; pinned here so the gate does not silently start relying on the compiler alone)', () => {
    for (const code of LINT_CODES) expect(typeof LINT_MESSAGE[code], code).toBe('function');
  });
});

// --- the gate ----------------------------------------------------------------

function runCheck(label: string, check: Check, attribute: 'data-mc-action' | 'data-mc-state'): void {
  if (check.kind === 'behaviour') { check.assert(); return; }
  if (check.kind === 'unreachable') { check.proof(); return; }
  if (check.kind === 'deferred') {
    expect(SLICES).toContain(check.slice);
    expect(check.reason.trim().length, `${label}: a deferral needs a reason`).toBeGreaterThan(20);
    return;
  }
  expect(
    attributePresent(check.file, attribute, label),
    `${check.file} carries no ${attribute}="${label}". Tag the real element (comments do not count -- they are stripped before this reads the file), or move this to a deferral with a slice id.`,
  ).toBe(true);
}

describe('ARCH-MAILCRAFT-FIDELITY: every screen-catalog.yaml action and state is checked against real code', () => {
  it('parses the vendored catalog and finds the 11 workspaces it declares', () => {
    expect(catalog.screens.map((screen) => screen.id)).toEqual([
      'MC-UI-001', 'MC-UI-002', 'MC-UI-003', 'MC-UI-004', 'MC-UI-005', 'MC-UI-006',
      'MC-UI-007', 'MC-UI-008', 'MC-UI-009', 'MC-UI-010', 'MC-UI-011',
    ]);
  });

  for (const screen of catalog.screens) {
    for (const action of screen.actions ?? []) {
      const label = `${screen.id}.${action}`;
      it(`${label} (action)`, () => {
        const check = ACTIONS[label];
        expect(check, `${label} is declared in ${CATALOG_PATH} but has no check here. Add a behaviour/markup check, or a deferral naming the slice that picks it up.`).toBeDefined();
        runCheck(label, check!, 'data-mc-action');
      });
    }
    for (const state of screen.states ?? []) {
      const label = `${screen.id}.${state}`;
      it(`${label} (state)`, () => {
        const check = STATES[label];
        expect(check, `${label} is declared in ${CATALOG_PATH} but has no check here. States are half of the catalog; skipping them is how a broken revision_conflict hid through all of S4.`).toBeDefined();
        runCheck(label, check!, 'data-mc-state');
      });
    }
  }

  it('registers no check the catalog does not declare (drift the other way)', () => {
    const declared = new Set<string>();
    for (const screen of catalog.screens) {
      for (const action of screen.actions ?? []) declared.add(`${screen.id}.${action}`);
      for (const state of screen.states ?? []) declared.add(`${screen.id}.${state}`);
    }
    const orphanActions = Object.keys(ACTIONS).filter((key) => !declared.has(key));
    const orphanStates = Object.keys(STATES).filter((key) => !declared.has(key));
    expect({ orphanActions, orphanStates }).toEqual({ orphanActions: [], orphanStates: [] });
  });

  it('every deferral names a slice the plan actually schedules', () => {
    const plan = read(PLAN_PATH);
    const used = [...Object.values(ACTIONS), ...Object.values(STATES)]
      .filter((check): check is Extract<Check, { kind: 'deferred' }> => check.kind === 'deferred')
      .map((check) => check.slice);
    for (const slice of new Set(used)) {
      if (slice === 'architecture-rejects') {
        expect(plan, 'the plan must record why an action is rejected outright, not merely postponed').toContain('retry_registration');
        continue;
      }
      // The slice map row, e.g. "| **S7** | ... | ... | Task 43-46 |".
      expect(plan, `a deferral points at ${slice}, but the plan's slice map has no row for it`).toMatch(new RegExp(`\\|\\s*\\*\\*${slice}\\*\\*\\s*\\|`));
    }
  });
});

describe('stripComments: the change that makes a comment stop counting as evidence', () => {
  it('drops line, block and JSX comments', () => {
    expect(stripComments('const a = 1; // data-mc-action="X.y"')).not.toContain('data-mc-action');
    expect(stripComments('/* data-mc-action="X.y" */ const a = 1;')).not.toContain('data-mc-action');
    expect(stripComments('<div>{/* data-mc-action="X.y" */}</div>')).not.toContain('data-mc-action');
  });

  it('keeps real attributes and URLs inside string literals', () => {
    expect(stripComments('<b data-mc-action="MC-UI-008.switch_device" />')).toContain('data-mc-action="MC-UI-008.switch_device"');
    expect(stripComments("const u = 'https://example.test/a'; const b = 2;")).toContain('https://example.test/a');
    expect(stripComments('const u = `https://x/${id}`; const b = 2;')).toContain('https://x/');
  });

  it('does not let an escaped quote end a string early', () => {
    expect(stripComments('const a = "he said \\"// not a comment\\""; const b = 3;')).toContain('const b = 3;');
  });
});
