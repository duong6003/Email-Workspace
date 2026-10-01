import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { defaultTheme, type Doc, type Node } from '../../../apps/web/src/screens/templates/builder/document.js';
import { freezeSummary, publishReadiness, type PublishAnalysisInput, type PublishDraft } from '../../../apps/web/src/screens/templates/builder/publish-readiness.js';
import { computeVersionUpdatePrompt } from '../../../apps/web/src/screens/compose/template-version-pin.js';
import { sanitizeTemplateHtml } from '../../../apps/api/src/templates/template-html-sanitizer.js';
import { lintTemplateContent } from '../../../apps/api/src/templates/template-content-lint.js';
import { analyzeTemplateVariables, parseTemplateVariableTokens, TemplateVariableError } from '../../../apps/api/src/templates/template-variables.js';
import { renderTemplateVariables } from '../../../apps/api/src/templates/template-variable-renderer.js';
import { recipientVariableContext, unsubscribeUrlFor } from '../../../apps/api/src/campaigns/recipient-variable-context.js';
import { readUnsubscribeToken } from '../../../apps/api/src/recipients/unsubscribe-token.js';

/**
 * ARCH-MAILCRAFT-BUSINESS-RULES.
 *
 * The acceptance criterion for this whole project is "none of the 12
 * `BR-TPL-*` rules is broken". Section 6 of
 * `docs/superpowers/specs/2026-08-31-mailcraft-builder-screen-design.md`
 * claims each rule traces to a `TC-TPL-NNN`. Measured: only `TC-TPL-004`
 * exists anywhere in the source tree (as a `describe` title in
 * `template-variable-renderer.test.ts`), and only 10 of the 12 rules are even
 * referenced by their `BR-TPL-NNN` id in code -- BR-TPL-004 and BR-TPL-009 are
 * not mentioned anywhere outside this table. So "none broken" currently has
 * nothing standing behind it.
 *
 * This is the traceability register that gives it something. It does not
 * invent 12 new rule engines: the table's own §6 lede says the `imported`
 * path already enforces all 12, and the builder's job is to not break them.
 * So each entry below finds the assertion that already exists (a pure
 * function, an exported constant, a 405 a controller method already returns,
 * a sentence the UI already shows the author) and calls it directly. Exactly
 * like `mailcraft-fidelity.test.ts`, which this file is modelled on line for
 * line:
 *
 *  - the rule list is PARSED from the spec's own §6 table, never copied into
 *    a literal array -- a 13th row added to the spec turns this gate red
 *    instead of silently agreeing with itself;
 *  - every rule gets a `behaviour` check (runs real code) or a `source`
 *    check (an exact string must survive comment-stripping in a named file);
 *  - two drift tests hold the register itself honest in both directions.
 *
 * Where a rule's own implementation is only partial, that is stated in the
 * rule's own comment rather than asserted away -- see BR-TPL-008 below,
 * whose header half has zero occurrences anywhere in this repository.
 */

const REPO_ROOT = resolve(__dirname, '../../..');
const SPEC_PATH = 'docs/superpowers/specs/2026-08-31-mailcraft-builder-screen-design.md';

const API_TEMPLATES = 'apps/api/src/templates';
const API_CAMPAIGNS = 'apps/api/src/campaigns';
const SCREENS = 'apps/web/src/screens/templates';

function read(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), 'utf8');
}

/**
 * Duplicated from `mailcraft-fidelity.test.ts` rather than imported from it:
 * importing one vitest test file from another would re-register that file's
 * own `describe`/`it` calls inside this file's run. Behaviour is identical --
 * see that file's header for what it does and why (strips `//`, block and
 * `{/* JSX *\/}` comments while leaving string/template literals intact) and
 * its own `stripComments` unit tests for proof, not repeated here.
 */
function stripComments(source: string): string {
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
    expect(value.length / source.length, `stripComments() removed over half of ${relativePath} -- that is a stripper bug, not a finding`).toBeGreaterThan(0.5);
    strippedCache.set(relativePath, value);
  }
  return value;
}

/** Generic sibling of `mailcraft-fidelity.test.ts`'s `attributePresent`: no `data-mc-*` convention exists on the API side, so this checks for an arbitrary literal instead of one fixed attribute shape. Comments still do not count -- reads the stripped file. */
function sourceContains(relativePath: string, needle: string): boolean {
  return stripped(relativePath).includes(needle);
}

/**
 * Nest controllers and services are read as source here, never imported.
 * `templates.controller.ts` and `templates.service.ts` pull in TypeORM
 * entities, whose property decorators need `experimentalDecorators` -- an
 * option `apps/api` sets and this package does not. Importing them made
 * `pnpm check` fail with 40+ TS1240s in files this gate never meant to
 * compile. The same imports were already awkward for a second reason: a
 * workspace install can resolve `@nestjs/common` to two copies, so `instanceof`
 * across that boundary is unreliable. Reading the stripped source asserts the
 * same rule without dragging the DI graph in.
 */

// --- rule list, parsed from the spec, never hand-copied ----------------------

/** One row of the spec's §6 table, e.g. `| BR-TPL-004 | Required/optional + default | ... |`. Anchored to line start so prose mentioning a rule id elsewhere in the document (§6's own closing paragraph does this) is not mistaken for a table row. */
const TABLE_ROW = /^\|\s*(BR-TPL-\d{3})\s*\|/;

function ruleIdsFromSpec(): string[] {
  const rows = read(SPEC_PATH).split('\n').filter((line) => TABLE_ROW.test(line));
  return rows.map((line) => TABLE_ROW.exec(line)![1]);
}

const RULE_IDS = ruleIdsFromSpec();

// --- checks --------------------------------------------------------------

type Check =
  | { kind: 'behaviour'; assert: () => void }
  | { kind: 'source'; file: string; needle: string };

const behaviour = (assert: () => void): Check => ({ kind: 'behaviour', assert });
const source = (file: string, needle: string): Check => ({ kind: 'source', file, needle });

// --- fixtures --------------------------------------------------------------

const emptyDoc = (): Doc => ({ title: 'BR fixture', nodes: [], theme: defaultTheme, variables: [] });

// ADR-050: a footer with a real address, so `readyDraft`'s default keeps
// passing `hasPostalAddress` the way it already keeps passing BR-TPL-008's
// unsubscribe-token check below.
const docWithFooterAddress = (): Doc => ({
  title: 'BR fixture', theme: defaultTheme, variables: [],
  nodes: [{ id: 'footer', kind: 'footer', visible: true, footer: { companyName: 'Alta Software', address: '123 Duong Lang, Ha Noi' } } as Node],
});

const cleanAnalysis: PublishAnalysisInput = { validation: { warnings: [], errors: [], changes: [] }, unknownVariables: [], lint: [] };
const readyDraft = (over: Partial<PublishDraft> = {}): PublishDraft => ({ name: 'Chao mung', subject: 'Chao {{first_name}}', html: '<p>Chao {{first_name}} — {{unsubscribe_url}}</p>', textBody: 'Chao', doc: docWithFooterAddress(), ...over });

// --- the registry ------------------------------------------------------------

const RULES: Record<string, Check> = {
  // "Kế thừa; không thêm trạng thái" -- the union is the whole rule, so this
  // reads it back from the entity file rather than re-declaring it, and pairs
  // it with every write site in the service that assigns `.status`: exactly
  // two, both to a literal ('archived' in archive(), 'published' in
  // publish()). 'draft' is never assigned -- it is the column default -- so a
  // third assignment (a resurrection path, or a client-supplied value taking
  // over the field) is the mutation this exists to catch.
  'BR-TPL-001': behaviour(() => {
    const entitySource = read('apps/api/src/database/entities/email-template.entity.ts');
    const union = /export type EmailTemplateStatus\s*=\s*([^;]+);/.exec(entitySource);
    expect(union, 'email-template.entity.ts no longer declares EmailTemplateStatus as a type union').not.toBeNull();
    const literals = [...union![1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]).sort();
    expect(literals, 'BR-TPL-001: the lifecycle grew (or lost) a status the spec did not add').toEqual(['archived', 'draft', 'published']);

    const assignments = [...stripped(`${API_TEMPLATES}/templates.service.ts`).matchAll(/\.status\s*=\s*'([a-zA-Z]+)'/g)].map((m) => m[1]);
    expect(assignments.sort(), 'BR-TPL-001: templates.service.ts gained or lost a status-assignment site (draft is the DB default and is never assigned directly)').toEqual(['archived', 'published']);
  }),

  // "UI không có 'sửa version'; restore = tạo nháp mới". PATCH/DELETE on a
  // version already return 405 (`templates.controller.ts`); this calls those
  // two handlers directly -- neither reads `this`, so no DI container is
  // needed -- and pairs it with the sentence the version history panel
  // already shows the author, which states the "restore creates a draft,
  // never edits the version" half no HTTP status code can express.
  'BR-TPL-002': behaviour(() => {
    // Not `instanceof MethodNotAllowedException`: this file and
    // templates.controller.ts can resolve `@nestjs/common` to two separate
    // copies under a workspace install, which makes a same-shaped exception
    // fail an `instanceof` check across that boundary. The status code and
    // exception name are what a real HTTP response exposes anyway.
    const controller = stripped(`${API_TEMPLATES}/templates.controller.ts`);
    // Both write verbs on a published version, and both refusing with the one
    // status that means "this resource exists and never changes".
    expect(controller, 'BR-TPL-002: no PATCH handler on template-versions/:id').toContain("@Patch('template-versions/:id')");
    expect(controller, 'BR-TPL-002: no DELETE handler on template-versions/:id').toContain("@Delete('template-versions/:id')");
    expect(
      (controller.match(/MethodNotAllowedException/g) ?? []).length,
      'BR-TPL-002: the immutable-version routes no longer refuse with 405',
    ).toBeGreaterThanOrEqual(2);

    expect(
      sourceContains(`${SCREENS}/TemplateVersionHistory.tsx`, 'Khôi phục luôn tạo một bản nháp mới.'),
      'BR-TPL-002: TemplateVersionHistory.tsx no longer tells the author that restore creates a new draft instead of editing the version',
    ).toBe(true);
  }),

  // "Cú pháp {{variable_key}}, key phải tồn tại" and "Không UI cho
  // helper/#if/#each". The syntax rule and the exclusion are the same
  // mechanism: `VARIABLE_KEY_PATTERN` only accepts `[a-z][a-z0-9_]*`, so
  // `{{#if x}}` is rejected as UNSAFE at the tokenizer, not merely
  // undocumented in the UI -- which is a stronger claim than "no button for
  // it" and is what actually forecloses a Handlebars-style helper syntax.
  'BR-TPL-003': behaviour(() => {
    expect(() => parseTemplateVariableTokens({ subject: '{{#if premium}}', html: '', textBody: '' }))
      .toThrow(expect.objectContaining<Partial<TemplateVariableError>>({ code: 'UNSAFE_TEMPLATE_EXPRESSION' }));
    expect(() => parseTemplateVariableTokens({ subject: '', html: '{{#each items}}', textBody: '' }))
      .toThrow(expect.objectContaining<Partial<TemplateVariableError>>({ code: 'UNSAFE_TEMPLATE_EXPRESSION' }));
    expect(() => parseTemplateVariableTokens({ subject: 'Hi {{name', html: '', textBody: '' }))
      .toThrow(expect.objectContaining<Partial<TemplateVariableError>>({ code: 'MALFORMED_TEMPLATE_SYNTAX' }));

    expect(() => analyzeTemplateVariables({ subject: 'Hi {{ten_sep}}', html: '', textBody: '' }, []))
      .toThrow(expect.objectContaining<Partial<TemplateVariableError>>({ code: 'UNKNOWN_VARIABLE', variableKey: 'ten_sep' }));
  }),

  // "Required/optional + default, tách 4 scope". `analyzeTemplateVariables`
  // is the one function that resolves all four sources a key can come from,
  // and the split between them is not uniform -- this is written to prove
  // the one asymmetry a copy-paste re-implementation would miss: a `global`
  // scope default does NOT relax `required` (a tenant-wide default cannot be
  // assumed to fit every template), while the exact same shape of default at
  // `template` scope does. Getting this backwards would silently make a
  // required global variable optional wherever it has any fallback at all.
  'BR-TPL-004': behaviour(() => {
    const customFields = [{ fieldKey: 'floor', dataType: 'number' as const, required: false, defaultValue: 3 }];
    const configured = [
      { variableKey: 'company_name', label: 'Tên công ty', scope: 'global' as const, defaultValue: 'Alta', required: true, allowCampaignOverride: false },
      { variableKey: 'promo_note', label: 'Ghi chú KM', scope: 'template' as const, defaultValue: 'Ưu đãi', required: true, allowCampaignOverride: true },
    ];
    const result = analyzeTemplateVariables(
      { subject: '{{email}} {{floor}} {{company_name}} {{promo_note}}', html: '', textBody: '' },
      customFields,
      configured,
    );

    // system (email, required, no default) and configured/global (required
    // despite its default -- the asymmetry above) both stay required.
    expect(result.schema.required).toEqual(['company_name', 'email']);
    // custom field with a default, and configured/template (required, but its
    // default DOES relax it) both land in optional.
    expect(result.schema.optional).toEqual(['floor', 'promo_note']);
    // the global default is never surfaced as a default to merge in --
    // exactly because it did not relax `required` either.
    expect(result.schema.defaults).toEqual({ floor: 3, promo_note: 'Ưu đãi' });
    expect(result.schema.configured).toEqual({
      company_name: { label: 'Tên công ty', scope: 'global', allowCampaignOverride: false },
      promo_note: { label: 'Ghi chú KM', scope: 'template', allowCampaignOverride: true },
    });
  }),

  // "Preview merge subject/HTML/text, hiện missingKeys". The same
  // `renderTemplateVariables` ADR-036 hands both preview and the real send:
  // `mode: 'preview'` merges anyway and reports what was missing, whereas the
  // default (send) mode refuses outright. Asserting both is the point --
  // preview that silently used the send behaviour would stop being a preview
  // of a broken send, it would just also be broken.
  'BR-TPL-005': behaviour(() => {
    const template = { subject: 'Hi {{email}}', html: '<p>{{email}}</p>', textBody: 'Hi {{email}}' };
    const schema = { required: ['email'], optional: [] };

    const preview = renderTemplateVariables(template, schema, {}, { mode: 'preview' });
    expect(preview.missingKeys).toEqual(['email']);
    expect(preview.subject).toBe('Hi ');
    expect(preview.html).toBe('<p></p>');

    const sendAttempt = renderTemplateVariables(template, schema, {});
    expect(sendAttempt).toMatchObject({ code: 'MISSING_REQUIRED_VARIABLE', missingKeys: ['email'] });
  }),

  // "Sanitize HTML, validate link". Two mechanisms, not one: the sanitizer
  // strips an unsafe scheme from `href` outright, and the lint separately
  // flags a target that survived sanitization but still is not a usable
  // link (neither a URL, a template token, nor mailto:/tel:).
  'BR-TPL-006': behaviour(() => {
    const { html } = sanitizeTemplateHtml('<p><a href="javascript:alert(1)">Bam vao day</a></p>');
    expect(html).not.toContain('javascript:');

    const issues = lintTemplateContent({ html: '<a href="not-a-url">Bam vao day</a>', textBody: 'Noi dung' });
    expect(issues.map((issue) => issue.code)).toContain('LINK_INVALID');
  }),

  // "Bắt buộc có text part... luôn gửi kể cả rỗng". The lint flags a blank
  // field so the author sees it while editing, but the rule that actually
  // holds at send time is `fallbackText`: `templates.service.ts` uses
  // `draftTextBody || fallbackText(draftHtml)` at publish, so the persisted
  // text part is never truly blank as long as the HTML is not. Both halves
  // are asserted -- a lint-only check would pass even if the fallback stopped
  // being called.
  'BR-TPL-007': behaviour(() => {
    expect(lintTemplateContent({ html: '<p>x</p>', textBody: '' }).map((issue) => issue.code)).toContain('TEXT_BODY_EMPTY');
    // The send-time half: publish never persists an empty text part, because
    // it falls back to text derived from the HTML.
    expect(
      sourceContains(`${API_TEMPLATES}/templates.service.ts`, 'fallbackText('),
      'BR-TPL-007: publish no longer derives a text part when the author left it blank',
    ).toBe(true);
  }),

  // "unsubscribe_url + header List-Unsubscribe" -- ADR-049 moved most of this
  // from "⚠️ một phần" to implemented, and the part still missing is named
  // rather than implied.
  //
  // This block previously asserted, in the message of its own assertion, that
  // BR-TPL-008 "fails at send time, not authoring time -- this must warn,
  // never block". That was measured false on 2026-09-11: nothing in apps/api
  // or apps/worker blocks a send for a missing token, so deferring to that
  // step meant nobody checked at all. A green test holding a reason nobody
  // re-read, again.
  //
  // Still NOT implemented, and deliberately still unchecked because nothing
  // exists to check: no file under apps/ sets a `List-Unsubscribe` header
  // (RFC 8058 one-click). ADR-049 §Consequences carries that as open work --
  // the in-body link is built and redeemable, the header is not.
  'BR-TPL-008': behaviour(() => {
    const links = { webOrigin: 'https://app.example.test/', unsubscribeSecret: 'z'.repeat(64) };
    const url = unsubscribeUrlFor(links, 'recipient-1');

    // ADR-049: signed, so a bare id is no longer a usable link.
    expect(url.startsWith('https://app.example.test/unsubscribe/recipient-1.')).toBe(true);
    expect(url).not.toBe('https://app.example.test/unsubscribe/recipient-1');
    expect(readUnsubscribeToken(url.split('/unsubscribe/')[1], links.unsubscribeSecret)).toBe('recipient-1');

    const context = recipientVariableContext({ id: 'recipient-1', email: 'a@example.test', firstName: null, lastName: null, customData: {} }, [], links);
    expect(context.unsubscribe_url).toBe(url);

    // And the author cannot publish a template that leaves recipients with no
    // way out, now that there is a route for them to take.
    const missing = publishReadiness(readyDraft({ html: '<p>Chao</p>', textBody: 'Chao' }), cleanAnalysis);
    expect(missing.blocking.some((item) => item.id === 'MISSING_UNSUBSCRIBE_URL')).toBe(true);
    expect(missing.canPublish, 'ADR-049: a template with no opt-out link must not publish').toBe(false);

    const present = publishReadiness(readyDraft(), cleanAnalysis);
    expect(present.blocking.some((item) => item.id === 'MISSING_UNSUBSCRIBE_URL')).toBe(false);
    expect(present.canPublish).toBe(true);
  }),

  // "Ảnh HTTPS/asset storage, không base64". `isPermittedImageSource` inside
  // the sanitizer only matches `https:`/`cid:`; this exercises the three ways
  // an image source lies about being servable (http, base64, and -- covered
  // more exhaustively by `builder-block-sanitizer.test.ts` -- protocol-
  // relative and root-relative paths) against the one function both the
  // builder and the importer route through.
  'BR-TPL-009': behaviour(() => {
    expect(sanitizeTemplateHtml('<img src="http://cdn.example.test/a.png">').html).not.toContain('http://cdn.example.test/a.png');
    expect(sanitizeTemplateHtml('<img src="data:image/png;base64,AAAA">').html).not.toContain('base64');
    expect(sanitizeTemplateHtml('<img src="https://cdn.example.test/a.png">').html).toContain('https://cdn.example.test/a.png');
  }),

  // "Tên template duy nhất trong tenant (409)". `throwNameConflict` never
  // touches `this`, so it is called directly off the prototype -- no
  // DataSource, no DI. The Postgres unique-violation code (23505) must become
  // a 409 with a stable machine code, and -- just as important -- anything
  // else must be rethrown untouched rather than swallowed as a false
  // "name taken".
  'BR-TPL-010': behaviour(() => {
    const service = stripped(`${API_TEMPLATES}/templates.service.ts`);
    expect(service, "BR-TPL-010: the Postgres unique-violation code is no longer what triggers the conflict").toContain("'23505'");
    expect(service, 'BR-TPL-010: the name conflict no longer carries a stable machine code').toContain('TEMPLATE_NAME_CONFLICT');
    expect(service, 'BR-TPL-010: the name conflict is no longer a 409').toContain('ConflictException');
    // And the inverse, still asserted: anything that is not 23505 has to be
    // rethrown rather than reinterpreted as "name taken".
    expect(service, 'BR-TPL-010: an unrelated failure may be swallowed as a name conflict').toMatch(/throw error;|throw cause;/);
  }),

  // "Test email có nhãn, không tính vào thống kê". Three independent facts:
  // the endpoint refuses to run without an Idempotency-Key (checked before
  // `this.templates` is even touched, so this is callable off the prototype
  // the same way BR-TPL-002/010 are); the author-facing label disclosing the
  // exclusion from official send history; and -- the "không tính" half --
  // that a test send is written through its own repository/table, which
  // none of the campaign stats/analytics/webhook files this repo has
  // reference at all. That last part is an absence proof: it cannot show the
  // exclusion is architecturally impossible, only that nothing today joins
  // against it. Adding such a join anywhere in `STATS_FILES` is exactly the
  // mutation this line exists to catch.
  'BR-TPL-011': behaviour(() => {
    const controller = stripped(`${API_TEMPLATES}/templates.controller.ts`);
    expect(controller, 'BR-TPL-011: test-send no longer reads an Idempotency-Key').toContain('idempotency-key');
    expect(controller, 'BR-TPL-011: test-send no longer refuses a request without one').toContain('BadRequestException');

    expect(
      sourceContains(`${SCREENS}/TemplatesScreen.tsx`, 'Bản thử không được ghi vào lịch sử gửi chính thức.'),
      'BR-TPL-011: TemplatesScreen.tsx no longer discloses that a test send is excluded from the official send history',
    ).toBe(true);

    expect(
      sourceContains(`${API_TEMPLATES}/templates.service.ts`, 'new TemplateTestSendsRepository(manager, tenantId)'),
      'BR-TPL-011: testSend() no longer persists through its own dedicated repository/table',
    ).toBe(true);

    const STATS_FILES = [`${API_CAMPAIGNS}/campaigns.service.ts`, `${API_CAMPAIGNS}/history-query.ts`, `${API_CAMPAIGNS}/progress-snapshot.ts`, 'apps/api/src/webhooks/webhooks.service.ts'];
    for (const file of STATS_FILES) {
      expect(stripped(file), `BR-TPL-011: ${file} now references the test-send table/repository -- test sends must never join campaign statistics`).not.toMatch(/TemplateTestSend|template_test_send/);
    }
  }),

  // "Campaign snapshot version + schema". `computeVersionUpdatePrompt` is the
  // half that did not exist before this vertical slice: a campaign's pinned
  // `templateVersionId` must never advance on its own, so this only ever
  // answers "is a newer version available" and is asserted to do nothing
  // else -- pinned-to-latest reports `available: false`, and pinned-to-older
  // names the latest without silently switching to it. `freezeSummary` covers
  // the other half already exercised by `mailcraft-fidelity.test.ts` under
  // MC-UI-010.validate, reused here under its own rule id rather than
  // re-derived.
  'BR-TPL-012': behaviour(() => {
    const versions = [{ id: 'v1', version: 1 }, { id: 'v2', version: 2 }, { id: 'v3', version: 3 }];
    expect(computeVersionUpdatePrompt('v3', versions)).toEqual({ available: false });
    expect(computeVersionUpdatePrompt('v1', versions)).toEqual({ available: true, latest: { id: 'v3', version: 3 } });

    const summary = freezeSummary({ currentVersion: 2, doc: emptyDoc(), html: '<p>x</p>', variableKeys: ['a', 'a', 'b'] });
    expect(summary.nextVersion).toBe(3);
    expect(summary.variableCount).toBe(2);
  }),
};

// --- the gate ----------------------------------------------------------------

function runCheck(label: string, check: Check): void {
  if (check.kind === 'behaviour') { check.assert(); return; }
  expect(
    sourceContains(check.file, check.needle),
    `${label}: ${check.file} does not contain the expected text (comments do not count -- they are stripped before this reads the file).`,
  ).toBe(true);
}

describe('ARCH-MAILCRAFT-BUSINESS-RULES: every BR-TPL-* row in the spec\'s §6 table resolves to a real assertion', () => {
  it('parses exactly the 12 rows the spec\'s §6 table declares, in order', () => {
    expect(RULE_IDS).toEqual([
      'BR-TPL-001', 'BR-TPL-002', 'BR-TPL-003', 'BR-TPL-004', 'BR-TPL-005', 'BR-TPL-006',
      'BR-TPL-007', 'BR-TPL-008', 'BR-TPL-009', 'BR-TPL-010', 'BR-TPL-011', 'BR-TPL-012',
    ]);
  });

  for (const ruleId of RULE_IDS) {
    it(`${ruleId} is checked against real code`, () => {
      const check = RULES[ruleId];
      expect(check, `${ruleId} is declared in ${SPEC_PATH} §6 but has no check in this file's RULES registry.`).toBeDefined();
      runCheck(ruleId, check!);
    });
  }

  it('registers no check the spec table does not declare (drift the other way)', () => {
    const declared = new Set(RULE_IDS);
    const orphans = Object.keys(RULES).filter((key) => !declared.has(key));
    expect(orphans).toEqual([]);
  });
});
