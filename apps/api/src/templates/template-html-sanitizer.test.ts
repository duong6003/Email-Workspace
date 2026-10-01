import { describe, expect, it } from 'vitest';
import { MAX_TEMPLATE_HTML_BYTES, sanitizeTemplateHtml } from './template-html-sanitizer.js';

describe('sanitizeTemplateHtml (M3-S1: BR-TPL-006/009)', () => {
  it('removes active HTML, unsafe links, unsafe image resources and unsafe CSS before storage', () => {
    const result = sanitizeTemplateHtml(`
      <style>.safe { color: #123456; }</style><style>.unsafe { background: url(https://attacker.test/pixel); }</style>
      <p class="safe" onclick="alert(1)">Hello <a href="javascript:alert(1)">unsafe</a></p>
      <img src="http://example.test/insecure.png" onerror="alert(1)" srcset="data:image/png;base64,AAAA 1x">
      <script>alert('xss')</script><iframe src="https://attacker.test"></iframe>
    `);

    expect(result.errors).toEqual([]);
    expect(result.html).toContain('Hello');
    expect(result.html).toMatch(/color:\s*#123456/i);
    expect(result.html).not.toMatch(/script|iframe|onclick|onerror|javascript:|data:image|http:\/\/example\.test|url\(/i);
    expect(result.changes.length).toBeGreaterThan(0);
  });

  it('preserves HTTPS and cid image resources while rejecting encoded or oversized HTML', () => {
    const safe = sanitizeTemplateHtml('<p><img src="https://cdn.example.test/logo.png"><img src="cid:logo"></p>');
    expect(safe.errors).toEqual([]);
    expect(safe.html).toContain('https://cdn.example.test/logo.png');
    expect(safe.html).toContain('cid:logo');

    const dataUrl = sanitizeTemplateHtml('<img src="data:image/png;base64,AAAA">');
    expect(dataUrl.html).not.toContain('data:image');
    expect(dataUrl.warnings).toContain('Removed an image resource that is not HTTPS or cid.');

    const tooLarge = sanitizeTemplateHtml('x'.repeat(MAX_TEMPLATE_HTML_BYTES + 1));
    expect(tooLarge.errors).toContain('HTML import exceeds the 5 MB limit.');
  });

  it('never fetches remote stylesheets while inlining accepted CSS', () => {
    const result = sanitizeTemplateHtml('<style>p { color: red; }</style><p>Safe</p>');

    expect(result.errors).toEqual([]);
    expect(result.html).toMatch(/color:\s*red/i);
    expect(result.html).not.toContain('<style');
  });

  it('keeps a single-value border-radius', () => {
    const result = sanitizeTemplateHtml('<td style="border-radius:8px">x</td>');
    expect(result.html).toContain('border-radius');
  });

  // ADR-038 supersedes ADR-037 §1 here: multi-value shorthand is accepted for the five
  // properties whose CSS grammar takes it, with every token validated separately. The S2
  // spike measured padding 15->0, border 14->1 and margin 9->1 on real builder output --
  // in the allowlist, dropped anyway, and silently.
  it('keeps multi-value shorthand on properties whose grammar takes it', () => {
    const cases = [
      ['padding:12px 20px', 'padding'],
      ['margin:0 0 18px 0', 'margin'],
      ['border:1px solid #ccc', 'border'],
      // The exact form real builder output emits (studio.tsx exportNode).
      ['border:0px solid transparent', 'border'],
      ['border-radius:8px 8px 0 0', 'border-radius'],
      ['border-spacing:4px 8px', 'border-spacing'],
    ] as const;
    for (const [decl, prop] of cases) {
      const result = sanitizeTemplateHtml(`<td style="${decl}">x</td>`);
      expect(result.html, `${decl} should survive`).toContain(prop);
    }
  });

  it('still rejects a shorthand carrying an unsafe token', () => {
    const result = sanitizeTemplateHtml('<td style="padding:12px expression(alert(1))">x</td>');
    expect(result.html).not.toContain('padding');
  });

  it('does not accept shorthand on a property that takes a single value', () => {
    // The multi-token pattern is attached per property, not to the shared value list.
    const result = sanitizeTemplateHtml('<td style="color:1px solid">x</td>');
    expect(result.html).not.toContain('color');
  });

  it('caps shorthand at four tokens', () => {
    const result = sanitizeTemplateHtml('<td style="padding:1px 2px 3px 4px 5px">x</td>');
    expect(result.html).not.toContain('padding');
  });

  // ADR-040: a preheader has to be able to hide. Without these three the block emits five
  // declarations and keeps one, leaving inbox-preview text sitting in the body.
  it('keeps the layout properties a hidden preheader needs', () => {
    const result = sanitizeTemplateHtml('<div style="display:none!important;max-height:0;overflow:hidden">p</div>');
    for (const prop of ['display', 'max-height', 'overflow']) {
      expect(result.html, `${prop} should survive`).toContain(prop);
    }
  });

  it('keeps display:block, which images and buttons rely on', () => {
    const result = sanitizeTemplateHtml('<img src="https://e.test/a.png" alt="a" style="display:block">');
    expect(result.html).toContain('display');
  });

  it('still drops opacity, deliberately left out of ADR-040', () => {
    const result = sanitizeTemplateHtml('<div style="opacity:0">p</div>');
    expect(result.html).not.toContain('opacity');
  });

  it('leaves whole-value patterns that contain spaces working', () => {
    // font-family and spaced rgb() match as one value; ADR-038 excludes them from the
    // token set to avoid ambiguous backtracking, so they must still pass the old way.
    const font = sanitizeTemplateHtml('<td style="font-family:Arial, Helvetica, sans-serif">x</td>');
    expect(font.html).toContain('font-family');
    const rgb = sanitizeTemplateHtml('<td style="color:rgb(0, 0, 0)">x</td>');
    expect(rgb.html).toContain('color');
  });

  // ADR-042: the S4 inspector needs four presentational properties the sanitizer strips
  // today. Measured first (evidence in the ADR), then allowlisted here -- a control whose
  // result vanishes is the failure ADR-037 §1 named.
  describe('ADR-042: box-shadow, letter-spacing, text-transform, gradient background-image', () => {
    it('keeps box-shadow as a capped shorthand, same four-token grammar as border/padding', () => {
      const result = sanitizeTemplateHtml('<td style="box-shadow:0 1px 2px rgba(0,0,0,0.12)">x</td>');
      expect(result.html).toContain('box-shadow');
    });

    it('drops a box-shadow needing a fifth token (inset is not supported)', () => {
      const result = sanitizeTemplateHtml('<td style="box-shadow:inset 0 0 0 1px #dbe5e0">x</td>');
      expect(result.html).not.toContain('box-shadow');
    });

    it('keeps letter-spacing, including a negative (tighter-tracking) value', () => {
      const positive = sanitizeTemplateHtml('<td style="letter-spacing:0.5px">x</td>');
      expect(positive.html).toContain('letter-spacing');
      const negative = sanitizeTemplateHtml('<td style="letter-spacing:-0.2px">x</td>');
      expect(negative.html).toContain('letter-spacing');
    });

    it('keeps text-transform for the four real keyword values', () => {
      for (const value of ['uppercase', 'lowercase', 'capitalize', 'none']) {
        const result = sanitizeTemplateHtml(`<td style="text-transform:${value}">x</td>`);
        expect(result.html, value).toContain('text-transform');
      }
    });

    it('keeps a background-image linear-gradient with an angle and percentage stops', () => {
      const result = sanitizeTemplateHtml('<td style="background-image:linear-gradient(180deg,#173f33 0%,#18342c 100%)">x</td>');
      expect(result.html).toContain('background-image');
      expect(result.html).toContain('linear-gradient');
    });

    it('keeps a background-image linear-gradient with a keyword direction', () => {
      const result = sanitizeTemplateHtml('<td style="background-image:linear-gradient(to right,#173f33,#18342c)">x</td>');
      expect(result.html).toContain('linear-gradient');
    });

    it('never lets background-image carry url(, gradient or not', () => {
      const plain = sanitizeTemplateHtml('<td style="background-image:url(https://attacker.test/x.png)">x</td>');
      expect(plain.html).not.toContain('background-image');
      const nested = sanitizeTemplateHtml("<td style=\"background-image:linear-gradient(url('https://attacker.test/x.png'),#173f33)\">x</td>");
      expect(nested.html).not.toContain('background-image');
    });

    it('still rejects the plain background shorthand on background-image duty', () => {
      // background-image is not background -- the shorthand stays unlisted (ADR-037 §1 rationale).
      const result = sanitizeTemplateHtml('<td style="background-image:#173f33">x</td>');
      expect(result.html).not.toContain('background-image');
    });
  });

  /**
   * S6 Task 39 (ADR-043 §8). `mark_decorative` emits `alt=""` AND
   * `role="presentation"`, and Task 40 teaches `IMAGE_ALT_MISSING` to read that
   * pair as "empty on purpose". Both halves depend on the attribute surviving
   * to storage: without it a decorative image reaches the inbox with a bare
   * `alt=""` that no screen reader can tell from a forgotten one, and the lint
   * rule can never fire because it runs on the sanitized HTML.
   *
   * Measured before it was allowed: the sanitizer WAS stripping it (`img` took
   * only alt/height/src/title/width), which would have made ADR-043 §8
   * unimplementable at the layer that matters.
   *
   * Only `presentation` and `none` are accepted -- the two roles that mean
   * "ignore this element". Any other role is dropped, because widening a
   * sanitizer allowlist to the whole ARIA vocabulary buys nothing this feature
   * needs. `table` has carried `role` since M3-S1 for the same layout-table
   * reason, so the attribute itself is not new here.
   */
  describe('ADR-043 §8: role="presentation" on a decorative image', () => {
    const img = (attributes: string) => sanitizeTemplateHtml(`<img src="https://cdn.example.test/a.png" ${attributes}>`).html;

    it('keeps role="presentation" beside an empty alt', () => {
      const html = img('alt="" role="presentation"');
      expect(html).toContain('role="presentation"');
      expect(html).toContain('alt=""');
    });

    it('keeps role="none", which means the same thing', () => {
      expect(img('alt="" role="none"')).toContain('role="none"');
    });

    it.each(['banner', 'button', 'link', 'img'])('drops role="%s" entirely, leaving no bare attribute behind', (role) => {
      const html = img(`alt="Ảnh" role="${role}"`);
      expect(html).not.toContain(role === 'img' ? 'role="img"' : `role="${role}"`);
      expect(html).not.toMatch(/\srole(?=[\s/>])/);
    });

    it('leaves an ordinary image alone', () => {
      expect(img('alt="Ảnh sản phẩm"')).not.toContain('role');
    });
  });

  /**
   * S7 Task 44, from `2026-09-01-sanitizer-reports-what-it-removed-design.md` and
   * the decisions in `2026-09-04-sanitizer-report-gap-analysis.md` §4.
   *
   * The sanitizer knew what it was discarding and said "Sanitized imported HTML
   * before storage." Two separate investigations in one week had to measure by
   * hand what these assertions now measure automatically.
   *
   * `changes` stays `string[]` (design §3.4): this is prose for a person to read,
   * not a structure for a machine to act on -- lint already owns that job, with
   * codes and counts. So the sentences carry their own category word, and the
   * list is ordered by category, which is what makes the report readable without
   * inventing a second machine-readable shape nobody consumes.
   */
  describe('reports what it removed', () => {
    const changesFor = (html: string) => sanitizeTemplateHtml(html).changes;

    it('says nothing at all about HTML it did not change', () => {
      expect(changesFor('<html><body><p style="color:#111">Xin chào</p></body></html>')).toEqual([]);
    });

    /**
     * Load-bearing for the import screen, which sends the RAW HTML on save even
     * though the report it just showed was computed from a separate analyse
     * call. That is only honest while running the sanitizer twice cannot produce
     * a different document -- otherwise the draft stored would not be the draft
     * the author reviewed.
     *
     * Sending the sanitized copy instead is the obvious-looking alternative and
     * is worse: it erases the report from the saved draft, because sanitizing an
     * already clean document removes nothing.
     */
    it('is idempotent, so the draft stored is the draft the report described', () => {
      const messy = '<html><head><style>@media (max-width:600px){.c{width:100%}}</style></head><body><script>a</script><td style="background:#f00"><img src="http://cdn.test/a.png"></td></body></html>';
      const once = sanitizeTemplateHtml(messy);
      const twice = sanitizeTemplateHtml(once.html);

      expect(twice.html).toBe(once.html);
      expect(once.changes.length).toBeGreaterThan(0);
      expect(twice.changes).toEqual([]);
    });

    it('names a removed tag, with how many of them there were', () => {
      const changes = changesFor('<html><body><script>a</script><script>b</script><p>Hi</p></body></html>');
      expect(changes.join('\n')).toMatch(/2 thẻ <script>/);
    });

    it('names a removed HTML attribute and how many elements carried it', () => {
      const changes = changesFor('<html><body><a href="https://a.test" aria-label="Facebook">f</a><a href="https://b.test" aria-label="X">x</a></body></html>');
      expect(changes.join('\n')).toMatch(/aria-label/);
      expect(changes.join('\n')).toMatch(/2 phần tử/);
    });

    it('names a removed CSS declaration and offers the replacement that works', () => {
      const changes = changesFor('<html><body><td style="background:#f00">A</td><td style="background:#0f0">B</td></body></html>');
      const text = changes.join('\n');
      expect(text).toMatch(/2 khai báo background\b/);
      expect(text).toMatch(/background-color/);
    });

    /**
     * The one the design's own measurement rule could not see. `@media` survives
     * both `sanitize()` calls untouched and is discarded by `juice`
     * (`preserveMediaQueries: false`), so a report that only compares around
     * `sanitize()` stays silent about the single loss that breaks an email's
     * layout on every phone. Gap analysis §4.1.
     */
    it('reports a media query, which juice removes rather than either sanitize pass', () => {
      const changes = changesFor('<html><head><style>.c{color:#111}@media (max-width:600px){.c{width:100%}}</style></head><body><p class="c">Hi</p></body></html>');
      expect(changes.join('\n')).toMatch(/@media/);
    });

    /**
     * The counterpart, and the reason `juice` is otherwise excluded: moving a
     * declaration out of `<style>` into `style=""` is a legitimate transformation,
     * not a loss. Design §3.2.
     */
    it('never calls an inlined stylesheet a loss', () => {
      const changes = changesFor('<html><head><style>p{color:#111}</style></head><body><p>Hi</p></body></html>');
      expect(changes.join('\n')).not.toMatch(/<style>|stylesheet|biểu định kiểu/i);
      expect(changes).toEqual([]);
    });

    it('reports a stylesheet dropped whole for containing something unsafe', () => {
      const changes = changesFor('<html><head><style>.c{background:url(https://attacker.test/p.png)}</style></head><body><p>Hi</p></body></html>');
      expect(changes.join('\n')).toMatch(/biểu định kiểu/i);
    });

    /**
     * Task 46's acceptance sample. It reported one of its three findings before
     * this existed -- and the one it did report named no URL.
     */
    it('reports all three of script, media query and non-https image together', () => {
      const text = changesFor(`<html><head><style>@media (max-width:600px){.c{width:100%}}</style></head>
        <body><script>a</script><img src="http://cdn.test/hero.png" alt="hero"><p class="c">Hi</p></body></html>`).join('\n');

      expect(text).toMatch(/<script>/);
      expect(text).toMatch(/@media/);
      expect(text).toMatch(/ảnh/i);
    });

    /**
     * Found by running a realistic imported newsletter through this, which the
     * narrow samples above could never have shown: sanitize-html strips HTML
     * comments, so every tag, attribute and declaration NAMED inside a comment
     * counted as removed. The sample's own explanatory header made the report
     * claim `<td>`, `<tr>`, `<a>` and `<body>` had all been deleted while they
     * were plainly still in the output.
     *
     * This is not an edge case. Real email HTML is full of comments -- Outlook
     * conditional blocks most of all -- so almost every genuine import would
     * have produced a report largely made of fiction, which is worse than the
     * silence it replaced.
     */
    /**
     * Not a reporting bug -- a content-destroying one, in the sanitizer since
     * M3-S1 and found here only because a realistic sample carried a comment.
     *
     * `stripUnsafeStyleBlocks` matches `<style ...>(anything)</style>`. An HTML
     * comment that merely MENTIONS `<style>` opens a match, which then runs to
     * the next real `</style>` -- so the regex sees one enormous "stylesheet"
     * spanning the comment and the author's real CSS. If anything anywhere in
     * that span looks unsafe (a `url(` in the prose is enough), the whole span
     * is deleted, taking working stylesheets with it. Measured on the frozen
     * sample: 611 characters removed, including the @media rule.
     *
     * Comments cannot be trusted to be inert text between tags, so they are
     * removed before the pipeline reads anything. That changes no output --
     * sanitize-html discards comments at the end regardless -- it only stops
     * their contents from being parsed as though they were markup.
     */
    it('does not let a comment that merely mentions <style> delete the real stylesheet', () => {
      const result = sanitizeTemplateHtml(
        '<html><head><!-- the <style> block below is fine, see url(...) --><style>p{color:#123456}</style></head><body><p>Hi</p></body></html>',
      );
      expect(result.html).toMatch(/color:\s*#123456/i);
    });

    it('keeps a media query reportable when a comment sits before the stylesheet', () => {
      const changes = changesFor(
        '<html><head><!-- <style> notes, url(x) --><style>@media (max-width:600px){.c{width:100%}}</style></head><body><p class="c">Hi</p></body></html>',
      );
      expect(changes.join('\n')).toMatch(/@media/);
    });

    describe('reads the document, not the commentary about it', () => {
      it('does not count tags named inside an HTML comment as removed', () => {
        const text = changesFor('<html><body><!-- wraps each row in a <td> and a <tr> --><table><tr><td>Hi</td></tr></table></body></html>').join('\n');
        expect(text).not.toMatch(/thẻ <td>|thẻ <tr>/);
      });

      it('does not count attributes or declarations named inside an HTML comment', () => {
        const text = changesFor('<html><body><!-- style="background:#f00" aria-label="x" --><p>Hi</p></body></html>').join('\n');
        expect(text).toEqual('');
      });

      /** A comment sitting between real losses must not hide them either. */
      it('still reports the real losses in a document that also has comments', () => {
        const text = changesFor('<html><body><!-- <script> is not allowed here --><script>a</script><p>Hi</p></body></html>').join('\n');
        expect(text).toMatch(/1 thẻ <script>/);
      });
    });

    /**
     * Three ways the same loss can be counted twice. All three were visible in
     * the first real output this produced, and each would train a reader to skim.
     *
     * Under-reporting is the sin this whole slice exists to fix, so none of these
     * suppress a loss -- they suppress a second, less informative sentence about
     * a loss already named.
     */
    describe('never reports one loss twice', () => {
      it('lets the image sentence own a stripped src instead of also calling it an attribute', () => {
        const text = changesFor('<html><body><img src="http://cdn.test/a.png" alt="a"></body></html>').join('\n');
        expect(text).toMatch(/ảnh/i);
        expect(text).not.toMatch(/thuộc tính src/);
      });

      /**
       * A `style=""` holding nothing but rejected declarations is dropped by
       * sanitize-html once it empties. The declarations are the loss; the empty
       * shell going with them is bookkeeping.
       */
      it('lets the declaration sentences own a style attribute that emptied out', () => {
        const text = changesFor('<html><body><td style="background:#eee">A</td><td style="background:#eee">B</td></body></html>').join('\n');
        expect(text).toMatch(/2 khai báo background/);
        expect(text).not.toMatch(/thuộc tính style/);
      });

      it('lets the tag sentence own the attributes that went with a removed element', () => {
        const text = changesFor('<html><body><script type="text/javascript" defer="defer">a</script><p>Hi</p></body></html>').join('\n');
        expect(text).toMatch(/1 thẻ <script>/);
        expect(text).not.toMatch(/thuộc tính type/);
      });
    });

    /**
     * Design §3.5: the sanitizer runs on every autosave, so a 15-line list every
     * couple of seconds is a list nobody reads by the end of day one.
     */
    it('caps the list and says how many kinds it left out', () => {
      const noisy = ['box-shadow:0 0 0 #000', 'background:#f00', 'opacity:0.5', 'float:left', 'position:absolute',
        'z-index:2', 'cursor:pointer', 'outline:none', 'clear:both', 'visibility:hidden', 'transition:all 1s', 'transform:scale(2)']
        .map((declaration, index) => `<p style="${declaration}">${String(index)}</p>`).join('');
      const changes = changesFor(`<html><body>${noisy}</body></html>`);

      expect(changes.length).toBeLessThanOrEqual(10);
      expect(changes.at(-1)).toMatch(/và \d+ loại khác/);
    });
  });

  /**
   * ADR-045: the Outlook compatibility layer and the three head tags.
   *
   * Every assertion here is written to FAIL when the code is broken, not to
   * pass when it merely looks right -- each one names the mutation it catches,
   * because a gate nobody has tried to break is a gate of unknown strength.
   */
  describe('ADR-045: MSO ghost tables, mso-* properties and the head tags', () => {
    const sanitize = (html: string) => sanitizeTemplateHtml(html).html;

    describe('decision 1: the ghost vocabulary is closed', () => {
      it('expands the four known keys into conditional comments', () => {
        const html = sanitize('<html><body>'
          + '<mso-ghost data-mso="row-open"></mso-ghost>'
          + '<mso-ghost data-mso="col-open" data-w="300"></mso-ghost><div>A</div><mso-ghost data-mso="col-close"></mso-ghost>'
          + '<mso-ghost data-mso="row-close"></mso-ghost>'
          + '</body></html>');

        expect(html).toContain('<!--[if mso]><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><![endif]-->');
        expect(html).toContain('<!--[if mso]><td width="300" valign="top"><![endif]-->');
        expect(html).toContain('<!--[if mso]></td><![endif]-->');
        expect(html).toContain('<!--[if mso]></tr></table><![endif]-->');
        // The intermediate tag is a transport, not output: none may survive.
        expect(html).not.toMatch(/mso-ghost/i);
      });

      /** Mutation caught: a `default:` branch returning the tag, or a fallback expansion, instead of ''. */
      it('drops a ghost whose data-mso is not one of the four', () => {
        const html = sanitize('<html><body><mso-ghost data-mso="drop-table"></mso-ghost><p>x</p></body></html>');
        expect(html).not.toMatch(/mso|\[if/i);
        expect(html).toContain('<p>x</p>');
      });

      /** Mutation caught: a ghost with no data-mso falling through to an expansion. */
      it('drops a ghost with no data-mso', () => {
        expect(sanitize('<html><body><mso-ghost></mso-ghost><p>x</p></body></html>')).not.toMatch(/\[if|mso/i);
      });

      /**
       * Mutation caught: interpolating `data-w` as written instead of parsing it
       * to a number. The last case is the one that matters -- it is the only
       * route by which an author-supplied character could reach the inside of a
       * comment, the one place sanitize-html cannot look.
       */
      it.each([
        ['0', 'below the range'],
        ['1001', 'above the range'],
        ['12.5', 'not an integer'],
        ['', 'empty'],
      ])('drops a col-open whose data-w is %s (%s)', (width) => {
        const html = sanitize(`<html><body><mso-ghost data-mso="col-open" data-w="${width}"></mso-ghost><p>x</p></body></html>`);
        expect(html).not.toMatch(/\[if mso\]><td/);
      });

      /**
       * The boundary that matters most, and the one worth stating precisely:
       * the escape here happens at HTML PARSE time, not inside the expansion --
       * the parser closes the attribute at the first quote, so `data-w` really
       * is `300` and expanding it is correct. What must hold is that nothing the
       * author typed lands INSIDE the comment, which is the one place
       * sanitize-html cannot look. The comment must be byte-for-byte the
       * constant form, and the smuggled script must be gone.
       */
      it('lets no author-supplied character reach the inside of a comment', () => {
        const html = sanitize('<html><body><mso-ghost data-mso="col-open" data-w="300">'
          + '<script>alert(1)</script><td width="300"></mso-ghost><p>x</p></body></html>');

        expect(html).toContain('<!--[if mso]><td width="300" valign="top"><![endif]-->');
        expect(html).not.toMatch(/script|alert/i);
        // every conditional comment in the output is one of the four constants
        for (const comment of html.match(/<!--[\s\S]*?-->/g) ?? []) {
          expect(comment).toMatch(/^<!--\[if mso\]>(?:<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>|<td width="\d{1,4}" valign="top">|<\/td>|<\/tr><\/table>)<!\[endif\]-->$/);
        }
      });

      it('accepts the boundaries of the range it advertises', () => {
        expect(sanitize('<html><body><mso-ghost data-mso="col-open" data-w="1"></mso-ghost></body></html>')).toContain('<td width="1"');
        expect(sanitize('<html><body><mso-ghost data-mso="col-open" data-w="1000"></mso-ghost></body></html>')).toContain('<td width="1000"');
      });

      it('leaves no orphaned closing tag behind as text', () => {
        expect(sanitize('<html><body></mso-ghost><p>x</p></body></html>')).not.toMatch(/mso-ghost/i);
      });
    });

    describe('decision 2: four mso-* properties, opened by name and not by prefix', () => {
      it('keeps the four that were decided', () => {
        const html = sanitize('<html><body>'
          + '<p style="mso-line-height-rule:exactly;line-height:20px">a</p>'
          + '<div style="mso-hide:all">b</div>'
          + '<table style="mso-table-lspace:0pt;mso-table-rspace:0pt"><tr><td>c</td></tr></table>'
          + '</body></html>');

        expect(html).toMatch(/mso-line-height-rule:\s*exactly/i);
        expect(html).toMatch(/mso-hide:\s*all/i);
        expect(html).toMatch(/mso-table-lspace:\s*0pt/i);
        expect(html).toMatch(/mso-table-rspace:\s*0pt/i);
      });

      /** Mutation caught: opening `mso-*` by prefix rather than listing four names. */
      it('drops an undecided mso-* property, and a bad value for a decided one', () => {
        const html = sanitize('<html><body>'
          + '<p style="mso-element:field-begin;mso-line-height-rule:sometimes;mso-hide:none">a</p>'
          + '</body></html>');

        expect(html).not.toMatch(/mso-element/i);
        expect(html).not.toMatch(/sometimes/i);
        expect(html).not.toMatch(/mso-hide/i);
      });
    });

    describe('decisions 3 and 4: the head tags, and the attribute that must never join them', () => {
      it('keeps charset, viewport, color-scheme, title and lang', () => {
        const html = sanitize('<html lang="vi"><head>'
          + '<meta charset="utf-8">'
          + '<meta name="viewport" content="width=device-width,initial-scale=1">'
          + '<meta name="color-scheme" content="light dark">'
          + '<title>Thu moi</title></head><body><p>x</p></body></html>');

        expect(html).toMatch(/<meta charset="utf-8"/i);
        expect(html).toMatch(/name="viewport"/i);
        expect(html).toMatch(/name="color-scheme"/i);
        expect(html).toMatch(/<title>Thu moi<\/title>/);
        expect(html).toMatch(/<html lang="vi"/i);
      });

      /**
       * The one assertion decision 3 exists to protect. Adding `http-equiv` to
       * `emailAttributes.meta` -- which looks harmless beside
       * `<meta http-equiv="Content-Type">` -- turns every template into a
       * possible open redirect. Measured both ways before shipping.
       */
      it('never lets http-equiv survive on a meta tag', () => {
        const html = sanitize('<html><head><meta http-equiv="refresh" content="0;url=https://attacker.test"></head><body><p>x</p></body></html>');
        expect(html).not.toMatch(/http-equiv/i);
        expect(html).not.toMatch(/attacker\.test/i);
      });

      /**
       * Two defences stand behind decision 3 and this asserts them SEPARATELY,
       * because mutation-testing the pair together proved they mask each other:
       * putting `http-equiv` back on `emailAttributes.meta` left every test
       * green, since `transformTags.meta` was dropping the tag first for having
       * neither `charset` nor `name`.
       *
       * Giving the tag a `name` walks it past that first defence, so only the
       * attribute allowlist can stop `http-equiv` here. Restore the attribute
       * and this test -- and only this test -- goes red.
       *
       * The junk `content` value is left alone on purpose and is not asserted
       * against: `content` is allowlisted, and on a `name="viewport"` meta it is
       * a string no client acts on. `http-equiv` is what turns a value into a
       * navigation, and `http-equiv` is what this locks.
       */
      it('drops http-equiv even on a meta the transform keeps', () => {
        const html = sanitize('<html><head><meta name="viewport" http-equiv="refresh" content="0;url=https://attacker.test"></head><body><p>x</p></body></html>');
        expect(html).toMatch(/name="viewport"/i);
        expect(html).not.toMatch(/http-equiv/i);
      });

      /** Before this ADR the tag was dropped but its text kept, leaking into <head> as bare text. */
      it('no longer spills the title text into the head', () => {
        expect(sanitize('<html><head><title>T</title></head><body><p>x</p></body></html>')).not.toMatch(/<head>T/);
      });
    });

    /**
     * The property this whole design rests on. `templates.service.ts` calls the
     * sanitizer only when the client sends `body.html`, never on stored HTML --
     * which is what makes expanding to a comment safe. This records the other
     * half of that fact: a second pass DOES eat the comments, because
     * `withoutComments` runs first. If a re-sanitize path is ever added to the
     * service, this test is where the reason is waiting.
     */
    it('shows why stored HTML must never be sanitized twice', () => {
      const once = sanitize('<html lang="vi"><head><meta charset="utf-8"></head><body>'
        + '<mso-ghost data-mso="row-open"></mso-ghost><div>A</div><mso-ghost data-mso="row-close"></mso-ghost>'
        + '</body></html>');
      const twice = sanitize(once);

      expect(once).toContain('<!--[if mso]>');
      expect(twice).not.toContain('<!--[if mso]>');
      expect(twice).toContain('<div>A</div>');
    });
  });
});
