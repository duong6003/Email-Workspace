import { describe, expect, it } from 'vitest';
import { KINDS, type Doc, type Node, type SocialLink } from '../../../apps/web/src/screens/templates/builder/document.js';
import { emitDoc, emitNode } from '../../../apps/web/src/screens/templates/builder/emitter.js';
import { sanitizeTemplateHtml } from '../../../apps/api/src/templates/template-html-sanitizer.js';
import { assetPublicUrl } from '../../../apps/api/src/assets/asset-storage.js';
import { bindAsset } from '../../../apps/web/src/screens/templates/builder/tree-ops.js';

/**
 * ARCH-BUILDER-SANITIZER (S2 Task 8). Mechanizes the manual audit in
 * `docs/superpowers/specs/2026-09-01-builder-block-sanitizer-audit.md`: every
 * builder block's emitted HTML must survive `sanitizeTemplateHtml` without
 * silently losing a CSS declaration, because a declaration that vanishes
 * between the canvas and storage is a block that lies about what it renders
 * (background-color on a button, border-top on a divider, opacity on a
 * preheader -- §2.1-§2.4 of the audit, all found this way).
 *
 * This package is where the check has to live: it is the only one that can
 * import both the web emitter and the api sanitizer directly (no rootDir
 * boundary, no cross-app import restriction).
 *
 * The exclusion list below is deliberate, sourced loss (audit §4), not an
 * escape hatch -- adding a kind here without a paired reason is the thing
 * this test exists to make impossible to do silently.
 */

/**
 * Audit §4 "mất mát chấp nhận được": properties a block may declare that the sanitizer is
 * expected to strip. Every entry must trace to a documented reason -- do not add one to
 * silence a real regression.
 *
 * `box-shadow`, `background-image`, `letter-spacing` and `text-transform` used to live here
 * (audit §4) but do not any more: **ADR-042** allowlisted all four, so a well-formed value the
 * emitter produces for them must now survive, not be excused. Leaving them excluded here would
 * let a real S4 Task 18 regression (a value shape the ADR-042 regex rejects) pass silently
 * instead of failing this gate.
 */
const ACCEPTED_LOSSES: ReadonlySet<string> = new Set([
  'opacity', // preheader -- ADR-040 deliberately excludes it; the emitter must not emit it either (audit §2.3, §5 item 7).
]);

let seq = 0;
const uid = (prefix: string): string => `${prefix}-${++seq}`;

/** One representative node per emitted kind, populated so every allowlist-relevant CSS property the emitter can produce for that kind is actually exercised. */
const sampleNodes: Record<string, Node> = {
  // ADR-042 built 2026-09-10: `letterSpacing`/`textTransform` are declared here on
  // purpose. The exclusion list above stopped excusing those properties when the ADR
  // was accepted, but a gate only checks what a sample actually declares -- without
  // these two the row passed vacuously and would have kept passing if the emitter
  // produced a value shape the ADR-042 regex rejects.
  // ADR-046 built 2026-09-11: `inline` is declared here for the same reason
  // `letterSpacing`/`textTransform` are -- a gate only checks what its sample
  // actually carries, and without a mark this row would exercise the legacy
  // escape path only and stay green if inline output stopped surviving the
  // sanitizer entirely.
  text: { id: uid('text'), kind: 'text', content: 'Nội dung quan trọng', align: 'center', fontSize: 16, lineHeight: 1.6, fontWeight: 400, textColor: '#30463d', fontFamily: 'Arial, Helvetica, sans-serif', letterSpacing: 1.5, textTransform: 'uppercase', visible: true, inline: [{ start: 0, end: 7, kind: 'strong' }, { start: 8, end: 19, kind: 'link', href: 'https://example.test/x' }] },
  // Negative tracking is the shape ADR-042 gave `letter-spacing` its own signed pattern for; no other sample would exercise the sign.
  heading: { id: uid('heading'), kind: 'heading', headingLevel: 1, content: 'Tiêu đề', align: 'left', fontSize: 32, lineHeight: 1.2, fontWeight: 700, textColor: '#193c31', letterSpacing: -0.5, textTransform: 'lowercase', visible: true, inline: [{ start: 0, end: 4, kind: 'em' }, { start: 5, end: 7, kind: 'underline' }] },
  // ADR-048. `listStyle` is declared on purpose: it is the ONE marker route the ADR
  // opened, and a sample without it would exercise only the structural half -- the
  // same vacuous-row trap the `letterSpacing` comment above records.
  list: { id: uid('list'), kind: 'list', content: 'Mục một\nMục hai\nMục ba', ordered: true, listStyle: 'upper-roman', align: 'left', fontSize: 15, lineHeight: 1.7, textColor: '#30463d', fontFamily: 'Arial, Helvetica, sans-serif', paddingLeft: 24, visible: true },
  button: { id: uid('button'), kind: 'button', content: 'Xem thêm', href: 'https://example.test/a', linkTitle: 'Xem thêm chi tiết', align: 'center', accent: '#173f33', textColor: '#ffffff', buttonVariant: 'outline', buttonSize: 'lg', buttonWidth: 'full', radius: 8, paddingTop: 12, visible: true },
  image: { id: uid('image'), kind: 'image', src: 'https://cdn.example.test/photo.png', alt: 'Ảnh minh hoạ', align: 'center', maxWidth: 80, radius: 12, caption: 'Chú thích ảnh', visible: true },
  banner: { id: uid('banner'), kind: 'banner', src: 'https://cdn.example.test/banner.png', alt: 'Banner', href: 'https://example.test/b', radius: 6, visible: true },
  logoImage: { id: uid('logo'), kind: 'logo', src: 'https://cdn.example.test/logo.png', alt: 'Logo', href: 'https://example.test', align: 'left', height: 40, visible: true },
  logoText: { id: uid('logo'), kind: 'logo', content: 'ALTA', accent: '#173f33', align: 'center', height: 44, visible: true },
  // ADR-044. Populated on every field so the sample exercises the mailto:/tel:
  // links, which are the two schemes besides http/https/cid the sanitizer keeps
  // and the whole reason this block beats a paragraph.
  contact: { id: uid('contact'), kind: 'contact', align: 'left', textColor: '#24342e', visible: true, contact: { name: 'Phòng Nhân sự', role: 'Alta Software', email: 'hr@alta.test', phone: '+84 28 1234 5678', address: 'Số 1, Quận 1, TP.HCM' } },
  // ADR-050. `footer.address` is declared with two lines on purpose: a sample
  // with one line would not exercise the `\n`-split that makes a multi-line
  // postal address possible, the same "declare what the ADR actually opened"
  // rule the `listStyle`/`letterSpacing` comments above give.
  footer: { id: uid('footer'), kind: 'footer', align: 'center', fontSize: 12, lineHeight: 1.6, textColor: '#30463d', visible: true, footer: { companyName: 'Công ty TNHH Alta Software', address: '123 Đường Láng, Phường Láng Thượng\nQuận Đống Đa, Hà Nội, Việt Nam' } },
  // ADR-052. `socialStyle: 'circle'` (the default anyway, but declared on
  // purpose -- see the `listStyle`/`letterSpacing` comments above) is what
  // makes the sample actually emit `border-radius`/`border`/`line-height`,
  // not just `color`/`text-align`; a sample at the `text` style would leave
  // those three properties unexercised by this gate. Two links, one
  // `platform: 'other'` with a label, so the label-initial glyph path
  // (`socialGlyph`) is exercised too, not just the closed-vocabulary glyphs.
  social: {
    id: uid('social'), kind: 'social', align: 'center', accent: '#173f33', socialStyle: 'circle', socialSize: 36, visible: true,
    social: [
      { id: uid('soc'), platform: 'facebook', url: 'https://facebook.test/alta', label: 'Facebook', enabled: true },
      { id: uid('soc'), platform: 'other', url: 'https://zalo.test/alta', label: 'Zalo Official', enabled: true },
    ],
  },
  table: {
    id: uid('table'), kind: 'table', visible: true,
    table: { header: true, zebra: true, caption: 'Lịch trình', cells: [['A', 'B'], ['1', '2']], headerBg: '#173f33', headerColor: '#ffffff', rowBg: '#ffffff', altBg: '#f2f6f4', borderColor: '#dbe5e0', cellPadding: 12, align: 'left' },
  },
  spacer: { id: uid('spacer'), kind: 'spacer', height: 32, visible: true },
  divider: { id: uid('divider'), kind: 'divider', height: 2, accent: '#dbe5e0', paddingTop: 12, paddingBottom: 12, visible: true },
  preheader: { id: uid('preheader'), kind: 'preheader', content: 'Xem trước trong hộp thư', visible: true },
  // Task 20 (MC-UI-011): unlike every other kind, the emitter does not generate this block's
  // CSS -- it passes author-typed HTML through verbatim. The sample stands in for realistic
  // author content so the gate still exercises real property names, not an empty string.
  customHtml: { id: uid('customHtml'), kind: 'customHtml', visible: true, html: '<p style="color:#173f33;font-size:16px;text-align:center">Đoạn HTML tuỳ chỉnh</p>' },
  section: {
    id: uid('section'), kind: 'section', background: '#f3f1ed', visible: true,
    paddingTop: 20, paddingRight: 20, paddingBottom: 20, paddingLeft: 20, borderColor: '#dbe5e0', borderWidth: 1,
    radiusTopLeft: 12, radiusTopRight: 12, radiusBottomRight: 0, radiusBottomLeft: 0,
    // The gradient and the shadow ADR-042 opened, exercised at their strongest form.
    backgroundMode: 'gradient', gradientTo: '#e9f3ee', gradientAngle: 180, elevation: 'strong', shadowColor: '#9eafa7',
    children: [{ id: uid('text'), kind: 'text', content: 'Bên trong section', visible: true }],
  },
  row: { id: uid('row'), kind: 'row', visible: true, children: [
    { id: uid('column'), kind: 'column', width: 50, background: '#ffffff', radius: 4, borderColor: '#173f33', borderWidth: 2, paddingTop: 16, paddingRight: 16, paddingBottom: 16, paddingLeft: 16, visible: true, children: [{ id: uid('text'), kind: 'text', content: 'Cột trái', visible: true }] },
    { id: uid('column'), kind: 'column', width: 50, background: '#f2f6f4', backgroundMode: 'gradient', elevation: 'soft', visible: true, children: [{ id: uid('text'), kind: 'text', content: 'Cột phải', visible: true }] },
  ] },
};

/** Every `property` name declared inside any `style="..."` attribute in `html`. Property-name-level, not value-level: `sanitize-html` either keeps a declared property with its value intact or drops the whole declaration -- it never keeps a property with a mutated value -- so a name that disappears is exactly the failure this gate watches for. */
function declaredStyleProperties(html: string): Set<string> {
  const properties = new Set<string>();
  for (const match of html.matchAll(/style="([^"]*)"/g)) {
    for (const declaration of match[1]!.split(';')) {
      const name = declaration.split(':')[0]?.trim().toLowerCase();
      if (name) properties.add(name);
    }
  }
  return properties;
}

describe('ARCH-BUILDER-SANITIZER: every builder block survives sanitizeTemplateHtml with no unexplained CSS loss', () => {
  for (const [label, node] of Object.entries(sampleNodes)) {
    it(`${label}: no declared style property disappears outside the documented exclusion list`, () => {
      const before = emitNode(node);
      const { html: after, errors } = sanitizeTemplateHtml(before);

      expect(errors).toEqual([]);

      const beforeProps = declaredStyleProperties(before);
      const afterProps = declaredStyleProperties(after);
      const lost = [...beforeProps].filter((prop) => !afterProps.has(prop) && !ACCEPTED_LOSSES.has(prop));

      expect(lost, `${label} lost undocumented CSS propert${lost.length === 1 ? 'y' : 'ies'}: ${lost.join(', ')}\nbefore: ${before}\nafter:  ${after}`).toEqual([]);
    });
  }

  /**
   * ADR-046 §Consequences names these three, and they are here rather than in
   * `apps/web` for the reason this whole package exists: only here can the web
   * emitter and the api sanitizer be run against each other, and it is the
   * PAIR that has to hold. `emitter.test.ts` can prove the emitter escapes; it
   * cannot prove what the server does with the result.
   */
  describe('ADR-046: inline rich text survives, and cannot be used to smuggle markup', () => {
    const textNode = (overrides: Partial<Node>): Node => ({ id: uid('adr046'), kind: 'text', visible: true, content: '', ...overrides });

    /**
     * ADR-046 §Consequences (a). Mutation-tested while building: stripping
     * `inline` from the two samples left every other assertion in this file
     * GREEN, because the ADR-046 cases below build their own nodes and the CSS
     * row above only reads `style` attributes. So the requirement that the
     * samples carry marks needs an assertion of its own, or it is a sentence in
     * a document rather than a gate -- the exact failure mode that let ADR-042
     * sit unbuilt for eight days.
     */
    it('keeps a mark on the text and heading samples, so the CSS row above is not exercising the legacy path alone', () => {
      for (const label of ['text', 'heading'] as const) {
        const sample = sampleNodes[label]!;
        expect(sample.inline?.length, `sampleNodes.${label} must carry inline marks (ADR-046)`).toBeGreaterThan(0);
        expect(emitNode(sample), `sampleNodes.${label} must actually emit an inline tag`).toMatch(/<(?:strong|em|u|a)[ >]/);
      }
    });

    it('keeps all four inline tags through the real sanitizer', () => {
      const node = textNode({
        content: 'abcd',
        inline: [
          { start: 0, end: 1, kind: 'strong' },
          { start: 1, end: 2, kind: 'em' },
          { start: 2, end: 3, kind: 'underline' },
          { start: 3, end: 4, kind: 'link', href: 'https://example.test/x' },
        ],
      });
      const { html } = sanitizeTemplateHtml(emitNode(node));
      expect(html).toContain('<strong>a</strong>');
      expect(html).toContain('<em>b</em>');
      expect(html).toContain('<u>c</u>');
      expect(html).toContain('<a href="https://example.test/x">d</a>');
    });

    /**
     * The measurement ADR-046 decision 3 turns on. `expandMsoGhosts` runs AFTER
     * `sanitize()` (ADR-045 decision 1), so a `<mso-ghost>` that arrived as
     * markup is expanded into a live conditional comment with nothing left to
     * vet it -- measured directly against the sanitizer, which turns
     * `<mso-ghost data-mso="row-open">` into `<!--[if mso]><table …><tr>`.
     *
     * The emitter escaping every run is what stops author text being markup in
     * the first place. Delete the escape and this goes red.
     */
    it('cannot forge an ADR-045 ghost tag out of typed content', () => {
      const node = textNode({
        content: '<mso-ghost data-mso="row-open"></mso-ghost> và <mso-ghost data-mso="col-open" data-w="600"></mso-ghost>',
        inline: [{ start: 0, end: 43, kind: 'strong' }],
      });
      const { html } = sanitizeTemplateHtml(emitNode(node));
      expect(html).not.toContain('[if mso]');
      expect(html).not.toContain('<table');
      expect(html).toContain('&lt;mso-ghost');
    });

    it('cannot smuggle a script or an event handler through the content field', () => {
      const node = textNode({
        content: '<script>alert(1)</script><img src=x onerror="alert(1)">',
        inline: [{ start: 0, end: 25, kind: 'em' }],
      });
      const { html } = sanitizeTemplateHtml(emitNode(node));
      expect(html).not.toContain('<script');
      expect(html).not.toContain('<img');
      // "onerror" DOES appear -- as the escaped text the author typed, which is
      // the correct outcome. What must not exist is an ELEMENT carrying a
      // handler, so the assertion is about attribute position, not substring.
      expect(html).not.toMatch(/<[a-z][^>]*\son\w+\s*=/i);
      expect(html).toContain('&lt;script&gt;');
      expect(html).toContain('&lt;img src=x onerror=');
    });

    it('never emits an href the sanitizer would have had to strip', () => {
      for (const href of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)', '//evil.test/x']) {
        const node = textNode({ content: 'Bấm vào đây', inline: [{ start: 4, end: 11, kind: 'link', href }] });
        const emitted = emitNode(node);
        expect(emitted, href).not.toContain('href=');
        // The words survive; only the destination is refused.
        expect(sanitizeTemplateHtml(emitted).html, href).toContain('vào đây');
      }
    });

    it('keeps a {{variable}} destination, which is how a personalised link is authored', () => {
      const node = textNode({ content: 'Xác nhận', inline: [{ start: 0, end: 8, kind: 'link', href: '{{link_xac_nhan}}' }] });
      expect(sanitizeTemplateHtml(emitNode(node)).html).toContain('href="{{link_xac_nhan}}"');
    });

    /** ADR-046 decision 6: a document that predates the field must emit exactly what it emitted before, and the sanitizer must see no difference either. */
    it('leaves a legacy block byte-identical when it carries no marks', () => {
      const legacy = textNode({ content: 'Giá 5 < 10 & "rẻ" > mong đợi <b>đậm</b>' });
      const emitted = emitNode(legacy);
      expect(emitted).toContain('&lt;b&gt;đậm&lt;/b&gt;');
      expect(emitted).not.toContain('<b>');
      expect(sanitizeTemplateHtml(emitted).html).not.toContain('<b>');
    });
  });

  /**
   * ADR-047 §Consequences. These belong here rather than in `apps/web` because
   * the `<style>` block does not exist until the API expands the marker -- the
   * emitter's own tests can only see `<mc-dark></mc-dark>`.
   */
  describe('ADR-047: the dark-mode stylesheet is generated, and nothing else gets in with it', () => {
    const docWith = (nodes: Node[]): string => emitDoc({ title: 'T', variables: [], theme: {}, nodes } as unknown as Doc);

    it('expands the marker into exactly one stylesheet carrying the colour query', () => {
      const { html } = sanitizeTemplateHtml(docWith([]));
      expect((html.match(/<style>/g) ?? []).length).toBe(1);
      expect(html).toContain('@media (prefers-color-scheme:dark)');
      expect(html).toContain('.mc-dark-ink{color:#e6ede9!important}');
      expect(html).not.toContain('<mc-dark');
    });

    /** ADR-047 decision 2: the slot is one query wide. A layout breakpoint would reverse ADR-037 §2. */
    it('leaves prefers-color-scheme as the ONLY media query, with no layout breakpoint', () => {
      const { html } = sanitizeTemplateHtml(docWith([
        { id: 's', kind: 'section', visible: true, children: [
          { id: 'r', kind: 'row', visible: true, children: [
            { id: 'c1', kind: 'column', width: 50, visible: true, children: [{ id: 't1', kind: 'text', visible: true, content: 'A' }] },
            { id: 'c2', kind: 'column', width: 50, visible: true, children: [{ id: 't2', kind: 'text', visible: true, content: 'B' }] },
          ] }] },
      ]));
      const queries = html.match(/@media[^{]*/g) ?? [];
      expect(queries).toHaveLength(1);
      expect(queries[0]).toContain('prefers-color-scheme');
      expect(html).not.toMatch(/@media[^{]*(?:min-width|max-width)/);
    });

    /**
     * This test is why ADR-047 decision 1 was corrected after it was written.
     * The ADR first claimed an attributed marker would be refused; it cannot
     * be, because `mc-dark` allows no attributes and `sanitize-html` strips
     * them before the expansion runs, so a forged marker arrives bare.
     *
     * What IS enforceable, and what matters, is that the output carries exactly
     * one stylesheet however many markers went in -- the expansion takes no
     * parameter, so a second marker can only ask for the same constant again.
     */
    it('writes exactly one stylesheet however many markers arrive, forged or not', () => {
      const forged = '<html><head><mc-dark data-x="1"></mc-dark><mc-dark></mc-dark><mc-dark></mc-dark></head><body>x</body></html>';
      const { html } = sanitizeTemplateHtml(forged);
      expect((html.match(/<style>/g) ?? []).length).toBe(1);
      expect((html.match(/@media/g) ?? []).length).toBe(1);
      expect(html).not.toContain('<mc-dark');
    });

    /**
     * The measurement the whole design turns on: `allowedStyles` does not
     * inspect CSS inside a `<style>`, so a surviving author stylesheet would
     * bypass every allowlisted property. Opening the marker route must not have
     * opened that one.
     */
    it('still drops an author <style> from a customHtml block, even beside the marker', () => {
      // The CSS is deliberately wrapped in its own `@media`. A plain rule is
      // NOT a real test of this: `juice` inlines it and removes the tag before
      // the second pass ever sees one, so the payload proves nothing about
      // whether that pass would have allowed it. Mutation-tested -- with a
      // plain rule here, flipping BOTH `preserveMediaQueries` and
      // `allowStylesheet` left this gate green, which is a gate protecting
      // nothing. Inside `@media` the rule is never inlined, which is exactly
      // the case ADR-047 §Context measured as bypassing the property
      // allowlist entirely.
      // Nothing here may match `unsafeCss` (`@import`, `url(`, `expression(`,
      // `behavior:`, ...). Measured: an earlier version of this payload said
      // `behavior:x`, which made `stripUnsafeStyleBlocks` delete the whole
      // block at step one -- so the test passed no matter what the later flags
      // did, and three separate mutations came back green against it. A gate
      // that its own payload disarms is worse than no gate.
      const evil = '@media screen and (max-width:600px){.evil{position:absolute;top:-9999px}}';
      const { html } = sanitizeTemplateHtml(docWith([
        { id: 's', kind: 'section', visible: true, children: [
          { id: 'r', kind: 'row', visible: true, children: [
            { id: 'c', kind: 'column', width: 100, visible: true, children: [
              { id: 'h', kind: 'customHtml', visible: true, html: '<div class="mc-dark-ink">x</div>', css: evil },
            ] }] }] },
      ]));
      expect(html).not.toContain('position:absolute');
      expect(html).not.toContain('.evil');
      expect(html).not.toContain('max-width:600px');
      // The generated one is still there, and it is the only one.
      expect((html.match(/<style>/g) ?? []).length).toBe(1);
      expect((html.match(/@media/g) ?? []).length).toBe(1);
      expect(html).toContain('prefers-color-scheme');
    });

    it('keeps the dark classes on default surfaces and off author-coloured ones', () => {
      const { html } = sanitizeTemplateHtml(docWith([
        { id: 's', kind: 'section', visible: true, background: '#ffffff', children: [
          { id: 'r', kind: 'row', visible: true, children: [
            { id: 'c', kind: 'column', width: 100, visible: true, background: '#173f33', children: [
              { id: 't', kind: 'text', visible: true, content: 'A', textColor: '#ffffff' },
            ] }] }] },
      ]));
      // Scoped to <body>: the generated stylesheet names every class, so a
      // document-wide `toContain` would match the rule rather than an element.
      const body = /<body[\s\S]*<\/body>/.exec(html)?.[0] ?? '';
      expect(body).toContain('class="mc-dark-surface"');   // the section, still default white
      expect(body).not.toContain('class="mc-dark-ink"');   // the text is author-coloured
      // And the author-coloured column did not get one either.
      expect(body).not.toMatch(/background-color:#173f33[^"]*"[^>]*mc-dark-surface/);
    });
  });

  /** ADR-048 §Consequences. */
  describe('ADR-048: the list block', () => {
    const listNode = (overrides: Partial<Node>): Node => ({ id: uid('l'), kind: 'list', visible: true, content: 'a', ...overrides });

    it('keeps list-style-type through the real sanitizer, which is the whole reason the ADR opened it', () => {
      for (const style of ['disc', 'circle', 'square', 'decimal', 'lower-alpha', 'upper-alpha', 'lower-roman', 'upper-roman', 'none']) {
        const { html } = sanitizeTemplateHtml(emitNode(listNode({ listStyle: style as never })));
        expect(html, style).toContain(`list-style-type:${style}`);
      }
    });

    it('never emits a marker route the sanitizer strips', () => {
      const html = emitNode(listNode({ listStyle: 'decimal', ordered: true }));
      expect(html).not.toContain('list-style:');
      expect(html).not.toContain('list-style-position');
      expect(html).not.toMatch(/<ol[^>]*\stype=/);
      expect(html).not.toMatch(/<ol[^>]*\sstart=/);
    });

    /**
     * ADR-048 §Consequences (b). Mutation-tested: without this, widening the
     * grammar to `/^.*$/` left every other assertion green -- the gate proved
     * that valid values survive and said nothing about invalid ones getting in.
     * A closed vocabulary that is never tested at its edge is not closed.
     */
    it('rejects a marker value outside the closed vocabulary', () => {
      for (const bad of ['url(evil.png)', 'expression(alert(1))', 'DISC extra', 'inherit', 'evil !important']) {
        const forged = `<ul style="list-style-type:${bad}"><li>x</li></ul>`;
        const { html } = sanitizeTemplateHtml(forged);
        expect(html, bad).not.toContain('list-style-type');
      }
      // ...and the nine real ones still pass, so this is not just "reject all".
      const { html } = sanitizeTemplateHtml('<ul style="list-style-type:square"><li>x</li></ul>');
      expect(html).toContain('list-style-type:square');

      // A `;` makes two declarations rather than one bad value, so the CSS
      // parser splits before the pattern is applied: the valid half survives
      // and the smuggled half is dropped on its own merits. Worth pinning --
      // it is the shape an injection attempt actually takes.
      const split = sanitizeTemplateHtml('<ul style="list-style-type:disc;position:absolute"><li>x</li></ul>').html;
      expect(split).toContain('list-style-type:disc');
      expect(split).not.toContain('position');

      // Measured 2026-09-11 and worth pinning, because it is not obvious and it
      // holds for the WHOLE allowlist, not just this property: `!important` is
      // parsed as a flag, so the value pattern sees the bare value. It cannot
      // be used to smuggle anything -- an unlisted property (`position`) and an
      // invalid value (`expression(...)`, `evil`) are both still dropped with
      // the flag attached. It only changes cascade priority on something
      // already allowed.
      expect(sanitizeTemplateHtml('<ul style="list-style-type:disc !important"><li>x</li></ul>').html).toContain('list-style-type:disc !important');
      expect(sanitizeTemplateHtml('<p style="position:absolute !important">x</p>').html).not.toContain('position');
      expect(sanitizeTemplateHtml('<p style="color:expression(alert(1)) !important">x</p>').html).not.toContain('expression');
    });

    it('escapes what a person typed into an item, all the way through the sanitizer', () => {
      const { html } = sanitizeTemplateHtml(emitNode(listNode({ content: '<script>alert(1)</script>' })));
      expect(html).not.toContain('<script');
      expect(html).toContain('&lt;script&gt;');
      expect(html).not.toMatch(/<[a-z][^>]*\son\w+\s*=/i);
    });

    it('emits a sibling list, never one nested inside a paragraph', () => {
      const { html } = sanitizeTemplateHtml(emitNode(listNode({ content: 'Mot' })));
      expect(html).toMatch(/^<ul[^>]*><li>Mot<\/li><\/ul>$/);
      expect(html).not.toContain('<p>');
    });
  });

  /**
   * ADR-050. Unlike ADR-048, this block opens NO new allowlist property --
   * measured while writing the ADR, every declaration `emitFooter` writes
   * (margin/padding/color/text-align/font-family/font-size/line-height) was
   * already open. So there is no marker grammar to mutation-test here; the
   * thing this ADR actually introduces that could be silently rubber-stamped
   * is the publish-BLOCKING gate itself, and that gate's edge cases are
   * pinned in `publish-readiness.test.ts` (`describe('ADR-050: ...')`), not
   * here. This describe block only covers the emitter/sanitizer round trip.
   */
  describe('ADR-050: the footer / postal-address block', () => {
    // Property-name-level survival (no declared style is silently dropped) is
    // already covered by `sampleNodes.footer` in the main gate loop above;
    // these three add what that loop does not check.
    const footerNode = (footer: Partial<NonNullable<Node['footer']>>): Node => ({ id: uid('f'), kind: 'footer', visible: true, footer: { companyName: '', address: '', ...footer } });

    it('escapes what a person typed into either field, all the way through the sanitizer', () => {
      const { html } = sanitizeTemplateHtml(emitNode(footerNode({ companyName: '<script>alert(1)</script>', address: '<img src=x onerror=alert(1)>' })));
      expect(html).not.toContain('<script');
      expect(html).not.toContain('<img');
      expect(html).not.toMatch(/<[a-z][^>]*\son\w+\s*=/i);
      expect(html).toContain('&lt;script&gt;');
    });

    it('keeps multi-line addresses joined with <br>, never nested inside a second paragraph', () => {
      // sanitize-html normalises the void element to self-closing form, so
      // the assertion allows `<br>` or `<br />` rather than pinning one.
      const { html } = sanitizeTemplateHtml(emitNode(footerNode({ companyName: 'Alta', address: 'A\nB\nC' })));
      expect(html).toMatch(/^<p[^>]*>Alta<br\s*\/?>A<br\s*\/?>B<br\s*\/?>C<\/p>$/);
    });
  });

  /**
   * ADR-052. Unlike ADR-048/050/051, this one opens NO new allowlist
   * property either (measured while writing the ADR: badge sizing/shape uses
   * `width`/`height`/`line-height`/`border`/`border-radius`, all already
   * open). What this describe block pins is the actual bug: the sent email
   * used to show the literal word "facebook", not a badge -- so the first
   * assertion is written as "the old bug does not come back," not just "the
   * new thing works."
   */
  describe('ADR-052: social icon badges survive the real sanitizer', () => {
    const socialNode = (links: Array<Partial<SocialLink>>, overrides: Partial<Node> = {}): Node =>
      ({ id: uid('soc'), kind: 'social', visible: true, accent: '#173f33', social: links.map((link) => ({ id: uid('l'), platform: 'facebook', url: '', enabled: true, ...link })), ...overrides });

    it('never regresses to the literal platform name as visible text -- the ADR-052 bug', () => {
      const { html } = sanitizeTemplateHtml(emitNode(socialNode([{ platform: 'facebook', url: 'https://facebook.test/alta' }])));
      expect(html).not.toContain('>facebook<');
      expect(html).toContain('>f<');
    });

    it('keeps the circle badge (width/height/line-height/border-radius/border) through the real sanitizer', () => {
      const { html } = sanitizeTemplateHtml(emitNode(socialNode([{ platform: 'linkedin', url: 'https://linkedin.test/alta' }], { socialStyle: 'circle', socialSize: 40 })));
      expect(html).toContain('width:40px');
      expect(html).toContain('height:40px');
      expect(html).toContain('line-height:40px');
      expect(html).toContain('border-radius:50%');
      expect(html).toContain('border:1px solid #173f33');
    });

    it('keeps the square badge with a 6px radius, not a circle', () => {
      const { html } = sanitizeTemplateHtml(emitNode(socialNode([{ platform: 'youtube', url: 'https://youtube.test/alta' }], { socialStyle: 'square' })));
      expect(html).toContain('border-radius:6px');
    });

    it('drops the badge box entirely under the text style, and underlines instead', () => {
      const { html } = sanitizeTemplateHtml(emitNode(socialNode([{ platform: 'website', url: 'https://alta.test' }], { socialStyle: 'text' })));
      expect(html).not.toContain('border-radius');
      expect(html).not.toContain('border:1px solid');
      expect(html).toContain('text-decoration:underline');
    });

    it('uses the label\'s own first letter for `other`, and escapes it', () => {
      const { html } = sanitizeTemplateHtml(emitNode(socialNode([{ platform: 'other', url: 'https://zalo.test/x', label: '<b>zalo</b>' }])));
      expect(html).not.toContain('<b>');
      // The visible glyph is the escaped first character of the label -- '<', escaped to '&lt;'.
      expect(html).toMatch(/>&lt;</);
    });

    it('falls back to a plain dot for `other` with no label yet, rather than emitting nothing', () => {
      const { html } = sanitizeTemplateHtml(emitNode(socialNode([{ platform: 'other', url: 'https://example.test/x', label: '' }])));
      expect(html).toContain('>•<');
    });
  });

  it('the preheader never emits opacity (ADR-040: redundant once display/max-height/overflow hide it, and a second way to hide for no new capability)', () => {
    expect(declaredStyleProperties(emitNode(sampleNodes.preheader!))).not.toContain('opacity');
  });

  /**
   * Without this the gate above is a checklist, not a gate: `sampleNodes` is
   * hand-maintained, so a kind added in S4 with no sample is simply never
   * exercised and the suite stays green. That is the exact failure the audit's
   * §6 exists to prevent -- a check nobody is forced to run.
   *
   * `KINDS` is the runtime source the `Kind` union is derived from, so the two
   * cannot drift: adding a kind to the union means adding it to `KINDS`, which
   * fails here until it has a sample.
   */
  it('exercises every block kind the document model declares', () => {
    // Walks children rather than reading top-level kinds only: the question is
    // whether a kind reaches the sanitizer at all, and `column` reaches it
    // nested inside `row`, which is also the only shape it has in real output.
    const collectKinds = (node: Node, into: Set<string>): Set<string> => {
      into.add(node.kind);
      for (const child of node.children ?? []) collectKinds(child, into);
      return into;
    };
    const sampled = Object.values(sampleNodes).reduce<Set<string>>((acc, node) => collectKinds(node, acc), new Set());
    const unsampled = KINDS.filter((kind) => !sampled.has(kind));

    expect(
      unsampled,
      `Block kind(s) declared in document.ts but never run through the sanitizer here: ${unsampled.join(', ')}. ` +
        'Add a representative node to sampleNodes that populates every CSS property the emitter can produce for it.',
    ).toEqual([]);
  });
});

/**
 * S6 Task 32 -- the measurement ADR-043 owes, run before any asset UI exists.
 *
 * ADR-043 §2 chose a permanent, app-owned URL for served assets, and its own
 * Consequences section records that it decided this on a capability survey with
 * nothing measured. This is what can be measured today: whether the URL shape
 * that decision produces survives the emitter and the real sanitizer intact.
 * The upload and serve halves cannot be measured until they exist (Tasks 33-36)
 * and are asserted end to end at acceptance (Task 42) -- so this is the honest
 * half of the round trip, not the whole of it.
 *
 * A mangled or dropped `src` here would invalidate the ADR's serving decision
 * before a line of storage code was written, which is the point of running it
 * first.
 */
const ASSET_ORIGIN = 'https://app.example.test';
const ASSET_ID = '0f9a1c3e-2b7d-4a51-9c8e-6d4b2f0a7e13';

function srcAfterSanitize(src: string): string | null {
  const node: Node = { id: 'probe', kind: 'image', src, alt: 'Ảnh minh hoạ', align: 'center', visible: true };
  const { html } = sanitizeTemplateHtml(emitNode(node));
  return /<img\b[^>]*\ssrc="([^"]*)"/.exec(html)?.[1] ?? null;
}

describe('S6 Task 32: the ADR-043 asset URL shape survives emitter -> sanitizeTemplateHtml', () => {
  it('keeps the canonical served URL byte-for-byte', () => {
    const url = `${ASSET_ORIGIN}/api/v1/assets/${ASSET_ID}/logo-cong-ty.png`;
    expect(srcAfterSanitize(url)).toBe(url);
  });

  it('keeps a percent-encoded Vietnamese filename, which the slug will routinely be', () => {
    const url = `${ASSET_ORIGIN}/api/v1/assets/${ASSET_ID}/${encodeURIComponent('ảnh bìa.png')}`;
    expect(srcAfterSanitize(url)).toBe(url);
  });

  it('keeps every extension the ADR allows, and does not care about the length of the path', () => {
    for (const extension of ['png', 'jpg', 'jpeg', 'gif', 'webp']) {
      const url = `${ASSET_ORIGIN}/api/v1/assets/${ASSET_ID}/${'a'.repeat(120)}.${extension}`;
      expect(srcAfterSanitize(url), extension).toBe(url);
    }
  });

  /**
   * The finding worth having before Task 36 writes the serving route: the
   * sanitizer's `isPermittedImageSource` matches `^https:`, so a root-relative
   * URL is not "the same origin", it is simply dropped. The API therefore has
   * to know its own public origin to build an absolute URL at emit time -- it
   * cannot lean on the page's origin the way ordinary web markup does.
   */
  it('DROPS a root-relative asset path -- so the served URL must be absolute https, and the app must know its own origin', () => {
    expect(srcAfterSanitize(`/api/v1/assets/${ASSET_ID}/logo.png`)).toBeNull();
  });

  it('still drops the sources the ADR rules out, so this shape buys no new bypass', () => {
    expect(srcAfterSanitize(`http://app.example.test/api/v1/assets/${ASSET_ID}/logo.png`)).toBeNull();
    expect(srcAfterSanitize('data:image/png;base64,AAAA')).toBeNull();
    expect(srcAfterSanitize(`//app.example.test/api/v1/assets/${ASSET_ID}/logo.png`)).toBeNull();
  });

  it('survives on every kind that carries a src, not just `image`', () => {
    const url = `${ASSET_ORIGIN}/api/v1/assets/${ASSET_ID}/banner.png`;
    for (const node of [
      { id: 'b', kind: 'banner', src: url, alt: 'Banner', visible: true } as Node,
      { id: 'l', kind: 'logo', src: url, alt: 'Logo', align: 'left', height: 40, visible: true } as Node,
    ]) {
      const { html } = sanitizeTemplateHtml(emitNode(node));
      expect(html, node.kind).toContain(`src="${url}"`);
    }
  });
});

/**
 * S6 Task 39: the decorative pair has to survive the sanitizer, or the feature
 * is a lie.
 *
 * ADR-043 §8 makes `mark_decorative` emit `alt=""` AND `role="presentation"`,
 * and Task 40 teaches `IMAGE_ALT_MISSING` to accept exactly that pair as
 * "empty on purpose". If the sanitizer drops `role` the way it drops `id` and
 * `data-*` (ADR-037 §3), then a published decorative image arrives with a bare
 * `alt=""` that no screen reader can distinguish from a forgotten one -- the
 * canvas would promise accessibility the inbox does not get. Measured here
 * against the real sanitizer rather than assumed, the same discipline Task 32
 * set.
 */
describe('S6 Task 39: the decorative pair survives emitter -> sanitizeTemplateHtml', () => {
  const url = `${ASSET_ORIGIN}/api/v1/assets/${ASSET_ID}/trang-tri.png`;

  it.each([
    ['image', { id: 'i', kind: 'image', src: url, alt: 'Ảnh', align: 'center', decorative: true, visible: true } as Node],
    ['banner', { id: 'b', kind: 'banner', src: url, alt: 'Banner', decorative: true, visible: true } as Node],
    ['logo', { id: 'l', kind: 'logo', src: url, alt: 'Logo', align: 'left', height: 40, decorative: true, visible: true } as Node],
  ])('keeps role="presentation" alongside the empty alt on a decorative %s', (_kind, node) => {
    const { html } = sanitizeTemplateHtml(emitNode(node));
    expect(html).toContain('role="presentation"');
    expect(html).toContain('alt=""');
  });

  it('does not add a role to an ordinary image, so the attribute stays meaningful', () => {
    const { html } = sanitizeTemplateHtml(emitNode({ id: 'i', kind: 'image', src: url, alt: 'Ảnh sản phẩm', align: 'center', visible: true } as Node));
    expect(html).not.toContain('role="presentation"');
  });
});

/**
 * S6 Task 42: the consequence of ADR-043 §2 that nothing else states out loud.
 *
 * The API mints every asset URL from `ASSET_PUBLIC_ORIGIN`, which compose fills
 * from `EOW_WEB_ORIGIN`, whose packaged default is `http://localhost:8080`. Run
 * the REAL minting function with that origin and the URL it produces is exactly
 * what the sanitizer throws away. Task 36's own note in `env.ts` says a wrong
 * value here "does not fail loudly"; this is the loud version, kept permanently
 * so the next person meets it in a test rather than in a recipient's inbox.
 *
 * Nothing here argues for a fix -- that is a deployment decision. It records
 * that on any http origin, the asset feature cannot work, and that the two
 * layers refuse it rather than shipping a broken image.
 */
describe('S6 Task 42: a non-https ASSET_PUBLIC_ORIGIN cannot produce a usable asset URL', () => {
  const filename = 'logo-cong-ty.png';

  it('mints a URL the sanitizer strips when the app origin is http -- the packaged local default', () => {
    const url = assetPublicUrl('http://localhost:8080', ASSET_ID, filename);
    expect(url.startsWith('http://')).toBe(true);
    expect(srcAfterSanitize(url)).toBeNull();
  });

  it('mints a URL that survives untouched when the app origin is https', () => {
    const url = assetPublicUrl(ASSET_ORIGIN, ASSET_ID, filename);
    expect(srcAfterSanitize(url)).toBe(url);
  });

  it('refuses the http URL at bind time too, so the document never holds a source that will vanish at publish', () => {
    const doc = { title: 'T', variables: [], nodes: [{ id: 'img-1', kind: 'image', visible: true } as Node] };
    expect(bindAsset(doc, 'img-1', assetPublicUrl('http://localhost:8080', ASSET_ID, filename))).toBe(doc);
    expect(bindAsset(doc, 'img-1', assetPublicUrl(ASSET_ORIGIN, ASSET_ID, filename))).not.toBe(doc);
  });
});

/**
 * ADR-045 end to end. Everything else about this ADR is tested on one side of
 * the boundary or the other: the emitter emits `<mso-ghost>`, the sanitizer
 * expands it. Neither proves the pair works, and the pair is the whole point --
 * the emitter's output is fed straight to the API on every save.
 *
 * This package is the only one that can import both, which is what makes it the
 * place the claim can actually be checked rather than assumed.
 */
describe('ARCH-BUILDER-SANITIZER: ADR-045 survives the emitter -> sanitizer round trip', () => {
  let seq = 0;
  const uid = () => `n-${++seq}`;
  const text = (content: string): Node => ({ id: uid(), kind: 'text', content, visible: true });
  const column = (width: number): Node => ({ id: uid(), kind: 'column', width, visible: true, children: [text('x')] });
  const row = (...children: Node[]): Node => ({ id: uid(), kind: 'row', visible: true, children });

  it('turns the emitter ghost tags into the conditional comments Outlook needs', () => {
    const emitted = emitNode(row(column(35), column(65)));
    // What leaves the browser carries tags, not comments -- comments would not
    // survive `withoutComments` at the top of the sanitizer.
    expect(emitted).toContain('<mso-ghost');
    expect(emitted).not.toContain('<!--');

    const { html } = sanitizeTemplateHtml(emitted);

    expect(html).toContain('<!--[if mso]><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><![endif]-->');
    expect(html).toContain('<!--[if mso]><td width="224" valign="top"><![endif]-->');
    expect(html).toContain('<!--[if mso]><td width="416" valign="top"><![endif]-->');
    expect(html).toContain('<!--[if mso]></td><![endif]-->');
    expect(html).toContain('<!--[if mso]></tr></table><![endif]-->');
    // The transport tag must be fully consumed: none may reach a recipient.
    expect(html).not.toMatch(/mso-ghost/i);
  });

  it('keeps the ghost cell width and the column cap agreeing after sanitization', () => {
    const { html } = sanitizeTemplateHtml(emitNode(row(column(50), column(50))));
    expect(html).toContain('<td width="320"');
    expect(html).toMatch(/max-width:\s*320px/);
  });

  it('keeps the four mso-* declarations the emitter now writes', () => {
    const preheader: Node = { id: uid(), kind: 'preheader', content: 'Xem trước', visible: true };
    expect(sanitizeTemplateHtml(emitNode(preheader)).html).toMatch(/mso-hide:\s*all/i);
    expect(sanitizeTemplateHtml(emitNode(text('a'))).html).toMatch(/mso-line-height-rule:\s*exactly/i);

    const { html } = sanitizeTemplateHtml(emitNode(row(column(100))));
    expect(html).toMatch(/mso-table-lspace:\s*0pt/i);
    expect(html).toMatch(/mso-table-rspace:\s*0pt/i);
  });
});
