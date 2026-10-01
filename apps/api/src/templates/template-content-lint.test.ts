import { describe, expect, it } from 'vitest';
import { lintTemplateContent } from './template-content-lint.js';

describe('template content lint', () => {
  it('reports actionable link, image and text-body warnings', () => {
    expect(lintTemplateContent({ html: '<a href="#">Open</a><a>Missing</a><a href="ftp://files.test/a">Bad</a><img src="https://cdn.example.test/a.png">', textBody: '' })).toEqual([
      { code: 'TEXT_BODY_EMPTY', severity: 'warning', count: 1, field: 'textBody' },
      { code: 'IMAGE_ALT_MISSING', severity: 'warning', count: 1, field: 'html' },
      { code: 'LINK_TARGET_MISSING', severity: 'warning', count: 1, field: 'html' },
      { code: 'LINK_PLACEHOLDER', severity: 'warning', count: 1, field: 'html' },
      { code: 'LINK_INVALID', severity: 'warning', count: 1, field: 'html' },
    ]);
  });

  it('returns no warnings for accessible production links', () => {
    expect(lintTemplateContent({ html: '<a href="https://acme.test/start">Open</a><a href="{{unsubscribe_url}}">Stop</a><img src="cid:logo" alt="ACME">', textBody: 'Open the message.' })).toEqual([]);
  });

  /**
   * S6 Task 40 (ADR-043 §8). §2.8 fixes the SET of six codes; it does not
   * forbid making one of them more accurate, which is what this is.
   *
   * The rule before this could not fire for a builder document at all. The
   * emitter always writes an alt attribute -- `alt="${n.alt ?? ''}"` -- so an
   * image with no description reached the lint as `alt=""`, which the old
   * pattern accepted. The client-side warning in the inspector fired and the
   * server lint stayed silent about the same image: two answers to one
   * question.
   *
   * Now an empty alt is a warning unless it is paired with
   * `role="presentation"` (or `role="none"`), which is exactly what
   * `mark_decorative` emits. That pair is what makes an empty alt readable as
   * deliberate rather than forgotten -- to a screen reader and to this rule
   * alike.
   */
  describe('IMAGE_ALT_MISSING and decorative images (S6 Task 40)', () => {
    const lint = (html: string) => lintTemplateContent({ html, textBody: 'Nội dung' }).filter((issue) => issue.code === 'IMAGE_ALT_MISSING');

    it('stays silent for a decorative image -- empty alt WITH role="presentation"', () => {
      expect(lint('<img src="https://cdn.example.test/a.png" alt="" role="presentation">')).toEqual([]);
    });

    it('stays silent for role="none", which means the same thing', () => {
      expect(lint('<img src="https://cdn.example.test/a.png" alt="" role="none">')).toEqual([]);
    });

    it('still warns when the alt attribute is absent entirely and nothing marks the image decorative', () => {
      expect(lint('<img src="https://cdn.example.test/a.png">')).toEqual([{ code: 'IMAGE_ALT_MISSING', severity: 'warning', count: 1, field: 'html' }]);
    });

    it('warns for an empty alt with no role -- the case the old rule accepted, and the one a builder image lands in when nobody describes it', () => {
      expect(lint('<img src="https://cdn.example.test/a.png" alt="">')).toEqual([{ code: 'IMAGE_ALT_MISSING', severity: 'warning', count: 1, field: 'html' }]);
      expect(lint('<img src="https://cdn.example.test/a.png" alt="   ">')).toEqual([{ code: 'IMAGE_ALT_MISSING', severity: 'warning', count: 1, field: 'html' }]);
    });

    it('does not let role="presentation" excuse an image that is missing alt altogether', () => {
      expect(lint('<img src="https://cdn.example.test/a.png" role="presentation">')).toEqual([{ code: 'IMAGE_ALT_MISSING', severity: 'warning', count: 1, field: 'html' }]);
    });

    it('never warns about an image that actually has a description', () => {
      expect(lint('<img src="https://cdn.example.test/a.png" alt="Ảnh sản phẩm">')).toEqual([]);
    });

    it('counts each offending image once, and ignores the ones that are fine', () => {
      const html = [
        '<img src="https://cdn.example.test/1.png" alt="Có mô tả">',
        '<img src="https://cdn.example.test/2.png" alt="" role="presentation">',
        '<img src="https://cdn.example.test/3.png" alt="">',
        '<img src="https://cdn.example.test/4.png">',
      ].join('');
      expect(lint(html)).toEqual([{ code: 'IMAGE_ALT_MISSING', severity: 'warning', count: 2, field: 'html' }]);
    });
  });

  /**
   * ADR-051. Gmail clips past ~102KB and hides everything after the clip,
   * unsubscribe link included -- audit backlog §5. Mutually exclusive with
   * `HTML_SIZE_LARGE`: the two thresholds are boundary-tested here the same
   * way `publish-readiness.test.ts` pins `MAX_HTML_BYTES` at the byte, not
   * the character, because `Buffer.byteLength` is what the function actually
   * calls.
   */
  describe('HTML_SIZE_GMAIL_CLIP and HTML_SIZE_LARGE (ADR-051)', () => {
    const lint = (html: string) => lintTemplateContent({ html, textBody: 'Nội dung' }).filter((issue) => issue.code === 'HTML_SIZE_GMAIL_CLIP' || issue.code === 'HTML_SIZE_LARGE');
    const padded = (bytes: number) => `<p>${'a'.repeat(Math.max(0, bytes - 7))}</p>`; // '<p>' + '</p>' = 7 bytes of fixed overhead

    it('warns about neither well under the Gmail threshold', () => {
      expect(lint(padded(1024))).toEqual([]);
    });

    it('fires HTML_SIZE_GMAIL_CLIP exactly past 102KB, and not at exactly 102KB', () => {
      expect(lint(padded(102 * 1024))).toEqual([]);
      expect(lint(padded(102 * 1024 + 1))).toEqual([{ code: 'HTML_SIZE_GMAIL_CLIP', severity: 'warning', count: 1, field: 'html' }]);
    });

    it('fires HTML_SIZE_LARGE, not HTML_SIZE_GMAIL_CLIP, once past 512KB -- one fact about an oversized email, not two', () => {
      const issues = lint(padded(512 * 1024 + 1));
      expect(issues).toEqual([{ code: 'HTML_SIZE_LARGE', severity: 'warning', count: 1, field: 'html' }]);
    });

    it('measures UTF-8 bytes, not string length -- a multi-byte character can cross the threshold before the character count does', () => {
      // 'п' (U+043F) is 1 UTF-16 code unit but 2 UTF-8 bytes.
      const underByLength = `<p>${'a'.repeat(102 * 1024 - 8)}п</p>`; // byteLength = 102*1024 + 1
      expect(lint(underByLength)).toEqual([{ code: 'HTML_SIZE_GMAIL_CLIP', severity: 'warning', count: 1, field: 'html' }]);
    });
  });

  /**
   * ADR-051. HTML-string route, matching every other code here -- fires on an
   * `origin: 'imported'` template's pasted HTML too, which never had a
   * builder `Doc` tree at all. `count` is the number of distinct violations,
   * not the number of headings, so a document with both a missing H1 and a
   * level skip reports 2.
   */
  describe('HEADING_ORDER_INVALID (ADR-051)', () => {
    const lint = (html: string) => lintTemplateContent({ html, textBody: 'Nội dung' }).filter((issue) => issue.code === 'HEADING_ORDER_INVALID');

    it('says nothing about an email with no headings at all -- nothing to structure', () => {
      expect(lint('<p>Chỉ có một đoạn văn và một nút bấm.</p>')).toEqual([]);
    });

    it('says nothing about a single H1 alone', () => {
      expect(lint('<h1>Tiêu đề chính</h1><p>Nội dung</p>')).toEqual([]);
    });

    it('says nothing about a well-formed outline: H1, then H2, then H3', () => {
      expect(lint('<h1>A</h1><p>x</p><h2>B</h2><p>x</p><h3>C</h3>')).toEqual([]);
    });

    it('warns once when the document has headings but never an H1', () => {
      expect(lint('<h2>B</h2><p>x</p><h3>C</h3>')).toEqual([{ code: 'HEADING_ORDER_INVALID', severity: 'warning', count: 1, field: 'html' }]);
    });

    it('warns once for a level skip, even with an H1 present', () => {
      expect(lint('<h1>A</h1><h2>B</h2><h4>D</h4>')).toEqual([{ code: 'HEADING_ORDER_INVALID', severity: 'warning', count: 1, field: 'html' }]);
    });

    it('does not treat going BACK to a lower level as a skip -- only jumping forward past one', () => {
      expect(lint('<h1>A</h1><h3>C</h3><h2>B</h2>')).toEqual([{ code: 'HEADING_ORDER_INVALID', severity: 'warning', count: 1, field: 'html' }]); // the H1->H3 jump, not the H3->H2 drop
    });

    it('counts a missing H1 and a level skip as two violations, not one', () => {
      expect(lint('<h2>B</h2><h4>D</h4>')).toEqual([{ code: 'HEADING_ORDER_INVALID', severity: 'warning', count: 2, field: 'html' }]);
    });

    it('counts every skip when there is more than one', () => {
      expect(lint('<h1>A</h1><h3>C</h3><p>x</p><h1>A2</h1><h4>D</h4>')).toEqual([{ code: 'HEADING_ORDER_INVALID', severity: 'warning', count: 2, field: 'html' }]);
    });
  });
});
