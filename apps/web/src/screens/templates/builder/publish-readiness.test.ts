import { describe, expect, it } from 'vitest';
import type { Doc, Node } from './document.js';
import { freezeSummary, publishReadiness } from './publish-readiness.js';

/**
 * ADR-044 / S9 Task 52 -- the pre-publish readiness sheet's arithmetic. The
 * prototype's screen shows an inventory ("what blocks, what only warns")
 * before the author confirms; this module decides which is which and says so
 * in one shot, so the screen never has to re-derive `canPublish` from a list.
 *
 * Two authorities split the same way `content-review.ts` already established:
 * the server owns the verdict (`analysis.lint`, `analysis.unknownVariables`,
 * `analysis.validation.errors`), this module owns only which of those BLOCK
 * publish (§2.9: an unknown variable does, a lint warning never does) versus
 * two rules the server does not express as a pre-flight at all -- the 5 MB
 * hard ceiling `template-html-sanitizer.ts` enforces on save, and BR-TPL-008's
 * missing-`unsubscribe_url` warning.
 */

const leaf = (node: Partial<Node> & { id: string; kind: Node['kind'] }): Node => node as Node;

const docOf = (...children: Node[]): Doc => ({
  title: 'Test',
  nodes: [leaf({ id: 'sec', kind: 'section', children: [leaf({ id: 'col', kind: 'column', children })] })],
  variables: [],
});

/** ADR-050: a document whose footer carries a real, non-empty postal address -- the default every test gets unless it is specifically exercising `hasPostalAddress`. */
const docWithFooterAddress = (address = '123 Đường Láng, Hà Nội'): Doc => docOf(leaf({ id: 'footer', kind: 'footer', visible: true, footer: { companyName: 'Alta Software', address } }));

const draftOf = (over: Partial<{ name: string; subject: string; html: string; textBody: string; doc: Doc }> = {}) => ({
  name: 'Bản tin tháng 9',
  subject: 'Chào {{first_name}}',
  html: '<p>Chào {{first_name}} — {{unsubscribe_url}}</p>',
  textBody: 'Chào {{first_name}} — {{unsubscribe_url}}',
  doc: docWithFooterAddress(),
  ...over,
});

const analysisOf = (over: Partial<Parameters<typeof publishReadiness>[1] & object> = {}) => ({
  validation: { warnings: [], errors: [], changes: [] },
  unknownVariables: [],
  lint: [],
  ...over,
});

describe('publishReadiness', () => {
  it('allows publishing when the draft is complete and the analysis is clean', () => {
    const readiness = publishReadiness(draftOf(), analysisOf());
    expect(readiness.canPublish).toBe(true);
    expect(readiness.blocking).toEqual([]);
  });

  it('blocks on a single unknown variable and names it', () => {
    const readiness = publishReadiness(draftOf(), analysisOf({
      unknownVariables: [{ field: 'html', key: 'ten_sep', start: 0, end: 0, classification: 'unknown', source: 'unknown', label: null, suggestedActions: [] }],
    }));

    expect(readiness.canPublish).toBe(false);
    expect(readiness.blocking).toHaveLength(1);
    expect(readiness.blocking[0]?.message).toContain('ten_sep');
  });

  it('reports one blocking row per distinct unknown variable, several at once', () => {
    const readiness = publishReadiness(draftOf(), analysisOf({
      unknownVariables: [
        { field: 'html', key: 'ten_sep', start: 0, end: 0, classification: 'unknown', source: 'unknown', label: null, suggestedActions: [] },
        { field: 'subject', key: 'ma_km', start: 0, end: 0, classification: 'unknown', source: 'unknown', label: null, suggestedActions: [] },
      ],
    }));

    expect(readiness.canPublish).toBe(false);
    expect(readiness.blocking).toHaveLength(2);
    expect(readiness.blocking.map((item) => item.message).join(' ')).toMatch(/ten_sep/);
    expect(readiness.blocking.map((item) => item.message).join(' ')).toMatch(/ma_km/);
  });

  it('blocks on every server validation error, one row each', () => {
    const readiness = publishReadiness(draftOf(), analysisOf({
      validation: { warnings: [], errors: ['Thẻ <table> chưa đóng.', 'Thuộc tính style vượt quá giới hạn.'], changes: [] },
    }));

    expect(readiness.canPublish).toBe(false);
    expect(readiness.blocking).toHaveLength(2);
    expect(readiness.blocking[0]?.message).toBe('Thẻ <table> chưa đóng.');
    expect(readiness.blocking[1]?.message).toBe('Thuộc tính style vượt quá giới hạn.');
  });

  it('blocks when the template name is blank', () => {
    const readiness = publishReadiness(draftOf({ name: '  ' }), analysisOf());
    expect(readiness.canPublish).toBe(false);
    expect(readiness.blocking.some((item) => item.id === 'MISSING_NAME')).toBe(true);
  });

  it('blocks when the subject is blank', () => {
    const readiness = publishReadiness(draftOf({ subject: '' }), analysisOf());
    expect(readiness.canPublish).toBe(false);
    expect(readiness.blocking.some((item) => item.id === 'MISSING_SUBJECT')).toBe(true);
  });

  it('blocks when the HTML body is blank', () => {
    const readiness = publishReadiness(draftOf({ html: '   ' }), analysisOf());
    expect(readiness.canPublish).toBe(false);
    expect(readiness.blocking.some((item) => item.id === 'MISSING_HTML')).toBe(true);
  });

  const MAX_HTML_BYTES = 5 * 1024 * 1024;

  /**
   * 'п' (Cyrillic short i, U+043F) is ONE UTF-16 code unit (so `.length`
   * counts it as 1) but TWO UTF-8 bytes -- exactly the gap between "string
   * length" and "wire size" that a correct implementation must measure in
   * bytes to enforce. Each case is built so the two measurements disagree
   * about which side of the ceiling the string is on:
   *
   * - `underHtml` is `MAX_HTML_BYTES` bytes exactly (not blocked) while its
   *   `.length` reads one short of that;
   * - `overHtml` is one byte OVER the ceiling (blocked) while its `.length`
   *   reads exactly `MAX_HTML_BYTES` -- so a `.length`-based check would
   *   wrongly wave it through, and only a byte-counting one catches it.
   */
  const underHtml = `${'a'.repeat(MAX_HTML_BYTES - 2)}п`;
  const overHtml = `${'a'.repeat(MAX_HTML_BYTES - 1)}п`;

  it('allows HTML exactly at the 5 MB ceiling, measured in UTF-8 bytes not UTF-16 code units', () => {
    expect(new TextEncoder().encode(underHtml).length).toBe(MAX_HTML_BYTES);
    expect(underHtml.length).toBe(MAX_HTML_BYTES - 1); // .length under-counts the multi-byte tail

    const readiness = publishReadiness(draftOf({ html: underHtml }), analysisOf());
    expect(readiness.blocking.some((item) => item.id === 'HTML_TOO_LARGE')).toBe(false);
  });

  it('blocks HTML one byte over the 5 MB ceiling, even though its .length reads exactly at the ceiling', () => {
    expect(new TextEncoder().encode(overHtml).length).toBe(MAX_HTML_BYTES + 1);
    expect(overHtml.length).toBe(MAX_HTML_BYTES); // a .length check alone would miss this

    const readiness = publishReadiness(draftOf({ html: overHtml }), analysisOf());
    expect(readiness.canPublish).toBe(false);
    expect(readiness.blocking.some((item) => item.id === 'HTML_TOO_LARGE')).toBe(true);
  });

  it('warns, but does not block, on a lint code', () => {
    const readiness = publishReadiness(draftOf(), analysisOf({
      lint: [{ code: 'IMAGE_ALT_MISSING', severity: 'warning', count: 2, field: 'html' }],
    }));

    expect(readiness.canPublish).toBe(true);
    expect(readiness.warnings).toHaveLength(1);
    expect(readiness.warnings[0]?.message).toBe('2 ảnh thiếu mô tả alt.');
  });

  /**
   * This used to assert `canPublish: true` with a warning, and the module's own
   * comment justified that with "the failure it prevents happens at SEND". It
   * does not: measured 2026-09-11, nothing in `apps/api` or `apps/worker`
   * blocks a send for a missing token. ADR-049 built the opt-out route that
   * makes the requirement real, so the check blocks now.
   */
  it('BLOCKS when the html and textBody never mention {{unsubscribe_url}} -- BR-TPL-008, ADR-049', () => {
    const readiness = publishReadiness(draftOf({ html: '<p>Chào {{first_name}}</p>', textBody: 'Chào {{first_name}}' }), analysisOf());

    expect(readiness.canPublish).toBe(false);
    expect(readiness.blocking.some((item) => item.id === 'MISSING_UNSUBSCRIBE_URL')).toBe(true);
    expect(readiness.warnings.some((item) => item.id === 'MISSING_UNSUBSCRIBE_URL')).toBe(false);
  });

  it('no longer promises the send will be blocked, because no such gate exists', () => {
    const readiness = publishReadiness(draftOf({ html: '<p>Chào</p>', textBody: '' }), analysisOf());
    const item = readiness.blocking.find((entry) => entry.id === 'MISSING_UNSUBSCRIBE_URL');
    expect(item?.message).not.toContain('bị chặn khi gửi');
    expect(item?.message).toContain('hủy đăng ký');
  });

  it('lets the draft through when unsubscribe_url is present in the HTML', () => {
    const readiness = publishReadiness(draftOf({ html: '<p>{{unsubscribe_url}}</p>', textBody: '' }), analysisOf());
    expect(readiness.blocking.some((item) => item.id === 'MISSING_UNSUBSCRIBE_URL')).toBe(false);
    expect(readiness.canPublish).toBe(true);
  });

  it('lets it through when the token only appears in the plain-text body', () => {
    const readiness = publishReadiness(draftOf({ html: '<p>Chào</p>', textBody: 'Huỷ đăng ký: {{unsubscribe_url}}' }), analysisOf());
    expect(readiness.blocking.some((item) => item.id === 'MISSING_UNSUBSCRIBE_URL')).toBe(false);
  });

  /**
   * ADR-050. Four cases, deliberately: together they rule out every way this
   * gate could be replaced with a rubber stamp and still pass a single-case
   * test --
   *   (a) no footer node at all,
   *   (b) a footer node present but its `address` empty/whitespace-only
   *       (rules out a mutation that checks `kind === 'footer'` alone),
   *   (c) `address` filled in but `companyName` empty (rules out a mutation
   *       that checks the wrong field),
   *   (d) an address on a HIDDEN footer (`visible: false`) -- rules out a
   *       mutation that ignores visibility, which would let a document
   *       publish while the address it names is never actually sent
   *       (`emitNode` drops `visible: false` nodes entirely).
   * A gate this file does not exercise at its edge is not a gate -- the same
   * lesson ADR-048 §Consequences (b) records for `list-style-type`.
   */
  describe('ADR-050: MISSING_POSTAL_ADDRESS (CAN-SPAM)', () => {
    it('blocks when the document has no footer block at all', () => {
      const readiness = publishReadiness(draftOf({ doc: docOf() }), analysisOf());
      expect(readiness.canPublish).toBe(false);
      expect(readiness.blocking.some((item) => item.id === 'MISSING_POSTAL_ADDRESS')).toBe(true);
    });

    it('blocks when a footer block exists but the address is blank', () => {
      const doc = docOf(leaf({ id: 'footer', kind: 'footer', visible: true, footer: { companyName: 'Alta Software', address: '   \n  ' } }));
      const readiness = publishReadiness(draftOf({ doc }), analysisOf());
      expect(readiness.canPublish).toBe(false);
      expect(readiness.blocking.some((item) => item.id === 'MISSING_POSTAL_ADDRESS')).toBe(true);
    });

    it('does NOT require a company name -- only the address is what CAN-SPAM requires', () => {
      const doc = docOf(leaf({ id: 'footer', kind: 'footer', visible: true, footer: { companyName: '', address: '123 Đường Láng, Hà Nội' } }));
      const readiness = publishReadiness(draftOf({ doc }), analysisOf());
      expect(readiness.blocking.some((item) => item.id === 'MISSING_POSTAL_ADDRESS')).toBe(false);
    });

    it('blocks when the only footer with an address is hidden, because a hidden block never reaches the recipient', () => {
      const doc = docOf(leaf({ id: 'footer', kind: 'footer', visible: false, footer: { companyName: 'Alta Software', address: '123 Đường Láng, Hà Nội' } }));
      const readiness = publishReadiness(draftOf({ doc }), analysisOf());
      expect(readiness.canPublish).toBe(false);
      expect(readiness.blocking.some((item) => item.id === 'MISSING_POSTAL_ADDRESS')).toBe(true);
    });

    it('finds the footer nested inside section > column, which is its real shape in an authored document', () => {
      const nested: Doc = {
        title: 'Test',
        nodes: [leaf({ id: 'sec', kind: 'section', children: [leaf({ id: 'col', kind: 'column', children: [leaf({ id: 'footer', kind: 'footer', visible: true, footer: { companyName: 'Alta', address: '123 Đường Láng' } })] })] })],
        variables: [],
      };
      const readiness = publishReadiness(draftOf({ doc: nested }), analysisOf());
      expect(readiness.blocking.some((item) => item.id === 'MISSING_POSTAL_ADDRESS')).toBe(false);
    });

    it('lets the draft through once a visible footer names a real address', () => {
      const readiness = publishReadiness(draftOf(), analysisOf());
      expect(readiness.blocking.some((item) => item.id === 'MISSING_POSTAL_ADDRESS')).toBe(false);
      expect(readiness.canPublish).toBe(true);
    });
  });

  /** ADR-051's two new server lint codes flow through exactly like the original six -- warning only, never blocking. */
  describe('ADR-051: the two new lint codes flow through LINT_ORDER like the original six', () => {
    it('warns, but does not block, on HTML_SIZE_GMAIL_CLIP', () => {
      const readiness = publishReadiness(draftOf(), analysisOf({ lint: [{ code: 'HTML_SIZE_GMAIL_CLIP', severity: 'warning', count: 1, field: 'html' }] }));
      expect(readiness.canPublish).toBe(true);
      expect(readiness.warnings.some((item) => item.id === 'lint:HTML_SIZE_GMAIL_CLIP')).toBe(true);
      expect(readiness.warnings[0]?.message).toContain('hủy đăng ký'); // the Gmail-clip message names the unsubscribe-link risk specifically
    });

    it('warns, but does not block, on HEADING_ORDER_INVALID', () => {
      const readiness = publishReadiness(draftOf(), analysisOf({ lint: [{ code: 'HEADING_ORDER_INVALID', severity: 'warning', count: 2, field: 'html' }] }));
      expect(readiness.canPublish).toBe(true);
      expect(readiness.warnings.some((item) => item.id === 'lint:HEADING_ORDER_INVALID')).toBe(true);
      expect(readiness.warnings.find((item) => item.id === 'lint:HEADING_ORDER_INVALID')?.message).toContain('2');
    });
  });

  /**
   * ADR-051: WCAG contrast. Unlike the lint codes above, this is computed
   * from `draft.doc` directly (no server round trip involved) -- so these
   * tests exercise `publishReadiness` end to end rather than stubbing
   * `analysis.lint`, the same way the ADR-050 describe block above does for
   * `hasPostalAddress`.
   */
  describe('ADR-051: LOW_CONTRAST_TEXT', () => {
    it('says nothing about a block with no textColor override -- the default ink is already vetted (ADR-047)', () => {
      const doc = docOf(leaf({ id: 't', kind: 'text', visible: true, content: 'x' }));
      const readiness = publishReadiness(draftOf({ doc }), analysisOf());
      expect(readiness.warnings.some((item) => item.id === 'LOW_CONTRAST_TEXT')).toBe(false);
    });

    it('warns about white text on the default white content background', () => {
      // A footer with a real address alongside the low-contrast text, so
      // MISSING_POSTAL_ADDRESS does not also block -- this test is about
      // LOW_CONTRAST_TEXT being a warning, not about the postal-address gate.
      const doc = docOf(
        leaf({ id: 't', kind: 'text', visible: true, content: 'x', textColor: '#ffffff' }),
        leaf({ id: 'footer', kind: 'footer', visible: true, footer: { companyName: 'Alta Software', address: '123 Đường Láng, Hà Nội' } }),
      );
      const readiness = publishReadiness(draftOf({ doc }), analysisOf());
      expect(readiness.canPublish).toBe(true); // a warning, never a block
      const item = readiness.warnings.find((entry) => entry.id === 'LOW_CONTRAST_TEXT');
      expect(item?.message).toContain('1'); // one offending block
    });

    it('resolves the background from the nearest ancestor SECTION/COLUMN, not the document default, when one is set', () => {
      const nested: Doc = {
        title: 'Test', variables: [],
        nodes: [leaf({
          id: 'sec', kind: 'section', visible: true, background: '#111111', children: [
            leaf({ id: 'col', kind: 'column', visible: true, children: [
              // Dark grey text on a near-black section background -- fails even against a dark backdrop.
              leaf({ id: 't', kind: 'text', visible: true, content: 'x', textColor: '#222222' }),
            ] }),
          ],
        })],
      };
      const readiness = publishReadiness(draftOf({ doc: nested }), analysisOf());
      expect(readiness.warnings.some((item) => item.id === 'LOW_CONTRAST_TEXT')).toBe(true);
    });

    it('does not flag a hidden block -- it never reaches the recipient', () => {
      const doc = docOf(leaf({ id: 't', kind: 'text', visible: false, content: 'x', textColor: '#ffffff' }));
      const readiness = publishReadiness(draftOf({ doc }), analysisOf());
      expect(readiness.warnings.some((item) => item.id === 'LOW_CONTRAST_TEXT')).toBe(false);
    });

    it('applies the WCAG "large text" 3:1 threshold to a heading\'s default 28px/700, not the 4.5:1 body-text threshold', () => {
      // #838383 on white is ~3.8:1 -- clears the large-text 3:1 threshold but fails the small-text 4.5:1 one, so this pins the branch that picks which threshold applies.
      const doc = docOf(leaf({ id: 'h', kind: 'heading', visible: true, content: 'x', textColor: '#838383' }));
      const readiness = publishReadiness(draftOf({ doc }), analysisOf());
      expect(readiness.warnings.some((item) => item.id === 'LOW_CONTRAST_TEXT')).toBe(false);
    });

    it('counts every offending block, not just whether any exist', () => {
      const doc = docOf(
        leaf({ id: 't1', kind: 'text', visible: true, content: 'x', textColor: '#ffffff' }),
        leaf({ id: 't2', kind: 'text', visible: true, content: 'y', textColor: '#fefefe' }),
      );
      const readiness = publishReadiness(draftOf({ doc }), analysisOf());
      expect(readiness.warnings.find((item) => item.id === 'LOW_CONTRAST_TEXT')?.message).toContain('2');
    });
  });

  it('treats a pending analysis as blocking and distinct from a clean one', () => {
    const readiness = publishReadiness(draftOf(), null);
    expect(readiness.canPublish).toBe(false);
    expect(readiness.blocking.some((item) => item.id === 'ANALYSIS_PENDING')).toBe(true);
    // Distinct from a clean, present analysis, which reports no such row.
    expect(publishReadiness(draftOf(), analysisOf()).blocking.some((item) => item.id === 'ANALYSIS_PENDING')).toBe(false);
  });

  it('still runs the field and size checks while the analysis is pending', () => {
    const readiness = publishReadiness(draftOf({ subject: '' }), null);
    expect(readiness.blocking.some((item) => item.id === 'MISSING_SUBJECT')).toBe(true);
    expect(readiness.blocking.some((item) => item.id === 'ANALYSIS_PENDING')).toBe(true);
  });

  it('puts every category in a fixed priority -- required field, unknown variable, validation error, then lint warning -- and keeps the six lint codes in the same order regardless of what order the server reported them in', () => {
    const unknownVariables = [{ field: 'html' as const, key: 'ten_sep', start: 0, end: 0, classification: 'unknown' as const, source: 'unknown' as const, label: null, suggestedActions: [] }];
    const validation = { warnings: [], errors: ['Lỗi X'], changes: [] };

    const readinessA = publishReadiness(draftOf({ name: '' }), analysisOf({
      unknownVariables,
      validation,
      lint: [
        { code: 'TEXT_BODY_EMPTY', severity: 'warning', count: 1, field: 'textBody' },
        { code: 'IMAGE_ALT_MISSING', severity: 'warning', count: 1, field: 'html' },
      ],
    }));

    // The server's own `lint` array in the opposite order -- the module's
    // canonical `LINT_ORDER` must win over whatever order it arrived in.
    const readinessB = publishReadiness(draftOf({ name: '' }), analysisOf({
      unknownVariables,
      validation,
      lint: [
        { code: 'IMAGE_ALT_MISSING', severity: 'warning', count: 1, field: 'html' },
        { code: 'TEXT_BODY_EMPTY', severity: 'warning', count: 1, field: 'textBody' },
      ],
    }));

    expect(readinessA.items.map((item) => item.id)).toEqual(readinessB.items.map((item) => item.id));
    expect(readinessA.items.map((item) => item.id)).toEqual([
      'MISSING_NAME',
      'unknown:ten_sep',
      'validation:0',
      'lint:IMAGE_ALT_MISSING',
      'lint:TEXT_BODY_EMPTY',
    ]);
    expect(readinessA.canPublish).toBe(false);
  });
});

describe('freezeSummary', () => {
  it('reports the version about to be created as one past the current version', () => {
    const summary = freezeSummary({ currentVersion: 2, doc: docOf(), html: '<p>Hi</p>', variableKeys: [] });
    expect(summary.nextVersion).toBe(3);
  });

  it('names version 1 for a template that has never published', () => {
    const summary = freezeSummary({ currentVersion: 0, doc: docOf(), html: '<p>Hi</p>', variableKeys: [] });
    expect(summary.nextVersion).toBe(1);
  });

  it('counts distinct variable keys, not occurrences', () => {
    const summary = freezeSummary({ currentVersion: 0, doc: docOf(), html: '', variableKeys: ['first_name', 'first_name', 'unsubscribe_url'] });
    expect(summary.variableCount).toBe(2);
  });

  it('renders the HTML size the same human-readable way the asset library does', () => {
    const summary = freezeSummary({ currentVersion: 0, doc: docOf(), html: 'a'.repeat(2048), variableKeys: [] });
    expect(summary.htmlSizeLabel).toBe('2,0 KB');
  });

  it('counts every block on the canvas, nested ones included', () => {
    const doc = docOf(leaf({ id: 'a', kind: 'text' }), leaf({ id: 'b', kind: 'image' }));
    const summary = freezeSummary({ currentVersion: 0, doc, html: '', variableKeys: [] });
    // sec + col + a + b = 4
    expect(summary.blockCount).toBe(4);
  });
});
