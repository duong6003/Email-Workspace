import { describe, expect, it } from 'vitest';
import { defaultTheme, type Doc, type Node, type SocialLink } from './document.js';
import { emitDoc, emitNode } from './emitter.js';

let seq = 0;
const uid = (prefix: string) => `${prefix}-${++seq}`;

function button(overrides: Partial<Node> = {}): Node {
  return { id: uid('button'), kind: 'button', content: 'Xem thêm', href: 'https://example.test/a', align: 'left', accent: '#173f33', textColor: '#fff', buttonVariant: 'solid', buttonSize: 'md', radius: 8, visible: true, ...overrides };
}

function social(links: Array<Partial<SocialLink>>, overrides: Partial<Node> = {}): Node {
  return { id: uid('social'), kind: 'social', align: 'center', accent: '#173f33', visible: true, social: links.map((link) => ({ id: uid('soc'), platform: 'facebook', url: '', enabled: true, ...link })), ...overrides };
}

function text(overrides: Partial<Node> = {}): Node {
  return { id: uid('text'), kind: 'text', content: 'Nội dung', align: 'left', fontSize: 14, textColor: '#30463d', visible: true, ...overrides };
}

function heading(overrides: Partial<Node> = {}): Node {
  return { id: uid('heading'), kind: 'heading', headingLevel: 2, content: 'Tiêu đề', align: 'left', fontSize: 28, textColor: '#193c31', visible: true, ...overrides };
}

function image(overrides: Partial<Node> = {}): Node {
  return { id: uid('image'), kind: 'image', src: 'https://cdn.example.test/photo.png', alt: 'Ảnh minh hoạ', align: 'center', maxWidth: 100, visible: true, ...overrides };
}

function banner(overrides: Partial<Node> = {}): Node {
  return { id: uid('banner'), kind: 'banner', src: 'https://cdn.example.test/banner.png', alt: 'Banner', visible: true, ...overrides };
}

function logo(overrides: Partial<Node> = {}): Node {
  return { id: uid('logo'), kind: 'logo', content: 'ALTA', accent: '#173f33', align: 'left', height: 36, visible: true, ...overrides };
}

function table(overrides: Partial<Node> = {}): Node {
  return {
    id: uid('table'), kind: 'table', visible: true,
    table: { header: true, zebra: true, caption: 'Lịch trình', cells: [['Hạng mục', 'Giờ'], ['Nhận thiết bị', '08:30']], headerBg: '#173f33', headerColor: '#fff', rowBg: '#fff', altBg: '#f2f6f4', borderColor: '#dbe5e0', cellPadding: 12, align: 'left' },
    ...overrides,
  };
}

function spacer(overrides: Partial<Node> = {}): Node {
  return { id: uid('spacer'), kind: 'spacer', height: 32, visible: true, ...overrides };
}

function preheader(overrides: Partial<Node> = {}): Node {
  return { id: uid('preheader'), kind: 'preheader', content: 'Xem trước trong hộp thư', visible: true, ...overrides };
}

function divider(overrides: Partial<Node> = {}): Node {
  return { id: uid('divider'), kind: 'divider', height: 2, accent: '#173f33', visible: true, ...overrides };
}

function column(overrides: Partial<Node> = {}): Node {
  return { id: uid('column'), kind: 'column', width: 100, background: '#ffffff', visible: true, children: [], ...overrides };
}

function row(children: Node[], overrides: Partial<Node> = {}): Node {
  return { id: uid('row'), kind: 'row', visible: true, children, ...overrides };
}

function section(children: Node[], overrides: Partial<Node> = {}): Node {
  return { id: uid('section'), kind: 'section', background: '#ffffff', visible: true, children, ...overrides };
}

describe('emitNode: leaf blocks (S2 Task 5)', () => {
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

  it('renders text as a <p> carrying color, alignment and size', () => {
    const html = emitNode(text({ content: 'Xin chào', textColor: '#30463d', align: 'center', fontSize: 16 }));
    expect(html).toContain('<p');
    expect(html).toContain('Xin chào');
    expect(html).toContain('color:#30463d');
    expect(html).toContain('text-align:center');
    expect(html).toContain('font-size:16px');
  });

  it('renders heading at the requested level', () => {
    const html = emitNode(heading({ headingLevel: 1, content: 'Chào mừng' }));
    expect(html).toContain('<h1');
    expect(html).toContain('</h1>');
    expect(html).toContain('Chào mừng');
  });

  it('drops an image with no src instead of emitting a broken tag', () => {
    expect(emitNode(image({ src: '' }))).toBe('');
  });

  it('renders an image with alt text and no shorthand background', () => {
    const html = emitNode(image({ src: 'https://cdn.example.test/a.png', alt: 'Ảnh' }));
    expect(html).toContain('<img');
    expect(html).toContain('alt="Ảnh"');
    expect(html).toContain('src="https://cdn.example.test/a.png"');
  });

  it('renders a banner at full width', () => {
    const html = emitNode(banner());
    expect(html).toContain('width="100%"');
  });

  it('emits logo font properties split apart, never the font shorthand', () => {
    const html = emitNode(logo({ src: '', content: 'ALTA', height: 40 }));
    expect(html).toContain('font-size:40px');
    expect(html).toContain('font-weight:700');
    expect(html).toContain('font-family:');
    expect(html).not.toMatch(/font:\d/);
  });

  it('renders a logo image when a src is set', () => {
    const html = emitNode(logo({ src: 'https://cdn.example.test/logo.png', alt: 'Logo' }));
    expect(html).toContain('<img');
    expect(html).toContain('alt="Logo"');
  });

  it('renders table rows with background-color, never the background shorthand', () => {
    const html = emitNode(table());
    expect(html).toContain('<th');
    expect(html).toContain('background-color:#173f33');
    expect(html).not.toMatch(/background:/);
    expect(html).toContain('Lịch trình');
  });

  it('renders a spacer as a fixed-height div', () => {
    const html = emitNode(spacer({ height: 24 }));
    expect(html).toContain('height:24px');
  });

  it('keeps preheader text invisible without opacity', () => {
    const html = emitNode(preheader({ content: 'Ưu đãi tháng 9 dành cho bạn' }));
    expect(html).toContain('display:none!important');
    expect(html).toContain('max-height:0');
    expect(html).toContain('overflow:hidden');
    expect(html).not.toContain('opacity');
    expect(html).toContain('Ưu đãi tháng 9 dành cho bạn');
  });

  it('returns an empty string for a hidden node', () => {
    expect(emitNode(text({ visible: false }))).toBe('');
  });

  it('escapes text content to prevent markup injection', () => {
    const html = emitNode(text({ content: '<script>alert(1)</script>' }));
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  /**
   * ADR-046 decision 3: escaping did not go away when inline formatting
   * arrived, it moved onto each run. This is the same assertion as the one
   * above, taken down the OTHER branch of `emitTextBody` -- without it the
   * escape test only ever exercises the legacy path and would stay green if
   * the marked path stopped escaping entirely.
   */
  it('still escapes every run when the block carries marks', () => {
    const html = emitNode(text({ content: '<script>alert(1)</script>', inline: [{ start: 0, end: 8, kind: 'strong' }] }));
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('<strong>');
  });

  it('rejects a javascript: URL on a button', () => {
    const html = emitNode(button({ href: 'javascript:alert(1)' }));
    expect(html).not.toContain('javascript:');
  });
});

describe('per-row stacking (Node.stackMobile -- audit backlog §1)', () => {
  const twoCols = (overrides: Partial<Node> = {}) => row([
    column({ width: 50, children: [text({ content: 'A' })] }),
    column({ width: 50, children: [text({ content: 'B' })] }),
  ], overrides);

  it('stacks by default, which is what width:100% means in fluid-hybrid', () => {
    expect(emitNode(twoCols())).toContain('width:100%');
  });

  it('holds its shape when the row says not to stack, without touching the theme', () => {
    const html = emitNode(twoCols({ stackMobile: false }), defaultTheme);
    // 640px theme, 50% column -> 320px fixed, so it can never wrap.
    expect(html).toContain('width:320px');
    expect(html).not.toContain('display:inline-block;width:100%');
  });

  it('overrides a document-wide stackColumns:false, so one row can stack while the rest do not', () => {
    const fixedTheme = { ...defaultTheme, stackColumns: false };
    expect(emitNode(twoCols(), fixedTheme)).toContain('width:320px');
    expect(emitNode(twoCols({ stackMobile: true }), fixedTheme)).toContain('display:inline-block;width:100%');
  });

  /** `?? ` not `||`: an explicit `false` must not be read as "unset" and fall through to the theme. */
  it('treats an explicit false as an answer, not as absent', () => {
    expect(emitNode(twoCols({ stackMobile: false }), defaultTheme)).not.toContain('display:inline-block;width:100%');
  });

  it('leaves the max-width cap alone either way, since that is the column width not the stacking rule', () => {
    expect(emitNode(twoCols({ stackMobile: true }))).toContain('max-width:320px');
    expect(emitNode(twoCols({ stackMobile: false }))).toContain('max-width:320px');
  });
});

describe('dark mode classes (ADR-047 decision 4: defaults only, never an author choice)', () => {
  it('marks a text block whose colour is still the default', () => {
    expect(emitNode(text({ textColor: undefined }))).toContain('class="mc-dark-ink"');
    expect(emitNode(text({ textColor: '#30463d' }))).toContain('class="mc-dark-ink"');
  });

  /** The whole point of decision 4: `!important` would erase this author's choice. */
  it('leaves a block alone the moment the author picks a colour', () => {
    expect(emitNode(text({ textColor: '#ffffff' }))).not.toContain('mc-dark-ink');
    expect(emitNode(heading({ textColor: '#173f33' }))).not.toContain('mc-dark-ink');
  });

  it('is case-insensitive about the default, so #30463D counts as untouched', () => {
    expect(emitNode(text({ textColor: '#30463D' }))).toContain('class="mc-dark-ink"');
  });

  it('marks a section and column still on the default white surface', () => {
    const html = emitNode(section([column({ children: [text({})] })], { background: '#ffffff' }));
    expect(html).toContain('class="mc-dark-surface"');
  });

  it('leaves a section the author coloured alone, so white-on-green stays white-on-green', () => {
    expect(emitNode(section([], { background: '#173f33' }))).not.toContain('mc-dark-surface');
  });

  it('emits the marker tag and both colour-scheme metas exactly once', () => {
    const html = emitDoc({ title: 'T', variables: [], theme: {}, nodes: [] } as unknown as Doc);
    expect((html.match(/<mc-dark><\/mc-dark>/g) ?? []).length).toBe(1);
    expect(html).toContain('<meta name="color-scheme" content="light dark">');
    expect(html).toContain('<meta name="supported-color-schemes" content="light dark">');
    expect(html).toContain('<body class="mc-dark-bg"');
  });

  /** ADR-047 decision 2: the only @media is the colour one, and the emitter writes no CSS breakpoint. */
  it('never emits a layout media query', () => {
    const html = emitDoc({ title: 'T', variables: [], theme: {}, nodes: [
      { id: 's', kind: 'section', visible: true, children: [
        { id: 'r', kind: 'row', visible: true, children: [
          { id: 'c1', kind: 'column', width: 50, visible: true, children: [text({})] },
          { id: 'c2', kind: 'column', width: 50, visible: true, children: [text({})] },
        ] }] }],
    } as unknown as Doc);
    // No `@media` at all on this side: the emitter writes a marker, and the
    // sanitizer is what turns it into the one colour query (asserted in
    // ARCH-BUILDER-SANITIZER, which can see the expanded output).
    expect(html).not.toContain('@media');
    // `max-width` IS present and must stay -- it is the fluid-hybrid cap
    // ADR-037 §2 relies on, an inline style rather than a breakpoint.
    expect(html).toContain('max-width:');
  });
});

/**
 * ADR-052. `names social links with title, not aria-label` (above, S2) is
 * the only pre-existing assertion touching this function's output, and it
 * never checked the visible text -- the exact gap that let
 * `escapeHtml(link.platform)` ship as the literal word "facebook" unnoticed.
 * This block closes that gap and pins the badge styling the ADR adds.
 */
describe('emitSocial (ADR-052)', () => {
  it('emits the platform glyph, never the raw platform name, as the visible text', () => {
    const html = emitNode(social([{ platform: 'facebook', url: 'https://f.test' }]));
    expect(html).toContain('>f<');
    expect(html).not.toContain('>facebook<');
  });

  it('gives every closed-vocabulary platform its own glyph', () => {
    const cases: Array<[SocialLink['platform'], string]> = [
      ['facebook', 'f'], ['linkedin', 'in'], ['instagram', 'ig'], ['youtube', 'yt'],
      ['tiktok', 'tt'], ['zalo', 'za'], ['threads', 'th'], ['website', '↗'],
    ];
    for (const [platform, glyph] of cases) {
      expect(emitNode(social([{ platform, url: 'https://x.test' }])), platform).toContain(`>${glyph}<`);
    }
  });

  it('uses the label\'s own first letter, uppercased, for platform "other"', () => {
    const html = emitNode(social([{ platform: 'other', url: 'https://x.test', label: 'zalo cửa hàng' }]));
    expect(html).toContain('>Z<');
  });

  it('falls back to a plain dot for "other" with no label, rather than emitting nothing', () => {
    const html = emitNode(social([{ platform: 'other', url: 'https://x.test', label: '' }]));
    expect(html).toContain('>•<');
  });

  it('sizes and rounds the badge fully under the circle style, the default', () => {
    const html = emitNode(social([{ platform: 'facebook', url: 'https://f.test' }], { socialSize: 40 }));
    expect(html).toContain('width:40px');
    expect(html).toContain('height:40px');
    expect(html).toContain('line-height:40px');
    expect(html).toContain('border-radius:50%');
  });

  it('gives the square style a 6px radius instead of a circle', () => {
    const html = emitNode(social([{ platform: 'facebook', url: 'https://f.test' }], { socialStyle: 'square' }));
    expect(html).toContain('border-radius:6px');
  });

  it('drops width/height/border/radius entirely under the text style, and underlines instead', () => {
    const html = emitNode(social([{ platform: 'facebook', url: 'https://f.test' }], { socialStyle: 'text' }));
    expect(html).not.toContain('border-radius');
    expect(html).not.toContain('width:');
    expect(html).toContain('text-decoration:underline');
  });

  it('defaults to circle and 32px when neither is set, matching the prototype', () => {
    const html = emitNode(social([{ platform: 'facebook', url: 'https://f.test' }]));
    expect(html).toContain('width:32px');
    expect(html).toContain('border-radius:50%');
  });

  it('escapes a label used as the visible glyph source, so a name cannot carry markup', () => {
    const html = emitNode(social([{ platform: 'other', url: 'https://x.test', label: '<script>alert(1)</script>' }]));
    expect(html).not.toContain('<script>');
  });

  it('drops a link with no enabled flag or no usable URL, same as before', () => {
    expect(emitNode(social([{ platform: 'facebook', url: '', enabled: true }]))).not.toContain('<a');
    expect(emitNode(social([{ platform: 'facebook', url: 'https://f.test', enabled: false }]))).not.toContain('<a');
  });
});

describe('emitList (ADR-048)', () => {
  const list = (overrides: Partial<Node> = {}): Node => ({ id: uid('list'), kind: 'list', visible: true, content: 'Một\nHai', ...overrides });

  it('turns each line into one item', () => {
    expect(emitNode(list())).toContain('<li>Một</li><li>Hai</li>');
  });

  it('skips blank lines instead of emitting an empty item', () => {
    const html = emitNode(list({ content: 'Một\n\n   \nHai' }));
    expect(html).toContain('<li>Một</li><li>Hai</li>');
    expect(html).not.toContain('<li></li>');
  });

  it('emits nothing at all when there is no content, like an image with no src', () => {
    expect(emitNode(list({ content: '' }))).toBe('');
    expect(emitNode(list({ content: '   \n  ' }))).toBe('');
  });

  it('chooses ol or ul from `ordered`', () => {
    expect(emitNode(list({ ordered: true }))).toMatch(/^<ol/);
    expect(emitNode(list({ ordered: false }))).toMatch(/^<ul/);
    expect(emitNode(list())).toMatch(/^<ul/);
  });

  it('escapes what a person typed, so an item cannot carry markup', () => {
    const html = emitNode(list({ content: '<script>alert(1)</script>' }));
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('omits list-style-type at its default, and writes it when chosen', () => {
    expect(emitNode(list())).not.toContain('list-style-type');
    expect(emitNode(list({ listStyle: 'square' }))).toContain('list-style-type:square');
  });

  it('carries the Outlook table reset, which Word needs around a list too', () => {
    expect(emitNode(list())).toContain('mso-table-lspace:0pt');
  });

  it('takes the ADR-047 dark ink class only while the colour is still default', () => {
    expect(emitNode(list())).toContain('mc-dark-ink');
    expect(emitNode(list({ textColor: '#ff6600' }))).not.toContain('mc-dark-ink');
  });
});

describe('emitText: inline rich text (ADR-046)', () => {
  it('emits nothing new when a block has no marks -- byte for byte the pre-ADR output', () => {
    const node = text({ content: 'Dòng một\nDòng hai' });
    const { inline: _dropped, ...legacy } = { ...node, inline: [] as never[] };
    expect(emitNode(node)).toBe(emitNode(legacy as typeof node));
    expect(emitNode(node)).toContain('Dòng một<br>Dòng hai');
  });

  it('bolds one word in the middle of a sentence -- the capability this ADR exists for', () => {
    const html = emitNode(text({ content: 'Giảm 50% hôm nay', inline: [{ start: 5, end: 8, kind: 'strong' }] }));
    expect(html).toContain('Giảm <strong>50%</strong> hôm nay');
  });

  it('nests an overlap in a fixed order instead of emitting crossed tags the sanitizer would reorder', () => {
    const html = emitNode(text({
      content: 'abcdef',
      inline: [{ start: 1, end: 4, kind: 'em' }, { start: 0, end: 3, kind: 'strong' }],
    }));
    expect(html).toContain('<strong>a<em>bc</em></strong><em>d</em>ef');
  });

  it('maps the four kinds to the four tags the sanitizer keeps', () => {
    const html = emitNode(text({
      content: 'abcd',
      inline: [
        { start: 0, end: 1, kind: 'strong' },
        { start: 1, end: 2, kind: 'em' },
        { start: 2, end: 3, kind: 'underline' },
        { start: 3, end: 4, kind: 'link', href: 'https://a.test' },
      ],
    }));
    expect(html).toContain('<strong>a</strong>');
    expect(html).toContain('<em>b</em>');
    expect(html).toContain('<u>c</u>');
    expect(html).toContain('<a href="https://a.test">d</a>');
  });

  it('keeps a {{variable}} destination, which is how a personalised link is authored', () => {
    const html = emitNode(text({ content: 'Bấm vào đây', inline: [{ start: 4, end: 11, kind: 'link', href: '{{link_xac_nhan}}' }] }));
    expect(html).toContain('<a href="{{link_xac_nhan}}">vào đây</a>');
  });

  it('drops a javascript: link and keeps the words, never a bare <a>', () => {
    const html = emitNode(text({ content: 'Bấm vào đây', inline: [{ start: 4, end: 11, kind: 'link', href: 'javascript:alert(1)' }] }));
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<a');
    expect(html).toContain('vào đây');
  });

  /**
   * The measurement that decided ADR-046 decision 3. `expandMsoGhosts` runs
   * AFTER `sanitize()` (ADR-045 decision 1), so a `<mso-ghost>` that reached
   * the server as markup would be expanded into a live conditional comment
   * with nothing left to inspect it. The emitter escaping every run is what
   * stops the string being markup in the first place.
   */
  it('cannot be used to forge an ADR-045 ghost tag out of typed text', () => {
    const html = emitNode(text({
      content: '<mso-ghost data-mso="row-open"></mso-ghost>',
      inline: [{ start: 0, end: 43, kind: 'strong' }],
    }));
    expect(html).not.toContain('<mso-ghost');
    expect(html).toContain('&lt;mso-ghost');
  });

  it('applies to headings on the same terms as paragraphs', () => {
    const html = emitNode(heading({ content: 'Tiêu đề mới', inline: [{ start: 0, end: 7, kind: 'em' }] }));
    expect(html).toMatch(/^<h2 [^>]*><em>Tiêu đề<\/em> mới<\/h2>$/);
  });

  it('ignores marks that survived onto a block whose text was emptied', () => {
    expect(emitNode(text({ content: '', inline: [{ start: 0, end: 5, kind: 'strong' }] }))).toContain('></p>');
  });
});

describe('emitNode: layout blocks (S2 Task 6)', () => {
  it('renders a divider as a table row with height and background-color, never <hr border-top>', () => {
    const html = emitNode(divider({ height: 3, accent: '#dbe5e0' }));
    expect(html).toContain('height:3px');
    expect(html).toContain('background-color:#dbe5e0');
    expect(html).not.toContain('<hr');
    expect(html).not.toContain('border-top');
  });

  it('wraps a section in a table carrying background-color, not the background shorthand', () => {
    const html = emitNode(section([], { background: '#f3f1ed' }));
    expect(html).toContain('<table');
    expect(html).toContain('background-color:#f3f1ed');
    expect(html).not.toMatch(/style="background:/);
  });

  it('lays out a row as sibling inline-block divs, not a <td> per column', () => {
    const html = emitNode(row([column({ width: 50 }), column({ width: 50 })]));
    expect(html.match(/display:inline-block/g)?.length).toBe(2);
    expect(html).not.toContain('<td class="mc-column"');
  });

  it('gives each column a max-width proportional to its share of the email width, with no @media needed to stack them', () => {
    const html = emitNode(row([column({ width: 50 }), column({ width: 50 })]));
    expect(html).toContain('max-width:320px');
  });

  /**
   * ADR-052 Context: the audit backlog's own literal complaint -- "không gõ
   * được 30/70, không làm được 3 cột 20/60/20" -- neither ratio has a
   * `ROW_LAYOUT_PRESETS` entry, so this proves the underlying math
   * (`columnPixelWidth`, unchanged by ADR-052) already handles an arbitrary
   * typed width; what ADR-052 actually added is the inspector field that
   * reaches it, not new emitter logic.
   */
  it('computes a custom 3-column 20/60/20 split correctly, even with no preset for it', () => {
    const html = emitNode(row([column({ width: 20 }), column({ width: 60 }), column({ width: 20 })]));
    expect(html).toContain('max-width:128px'); // 640 * 0.20
    expect(html).toContain('max-width:384px'); // 640 * 0.60
  });

  it('computes an uneven 30/70 split correctly, even with no preset for it', () => {
    const html = emitNode(row([column({ width: 30 }), column({ width: 70 })]));
    expect(html).toContain('max-width:192px'); // 640 * 0.30
    expect(html).toContain('max-width:448px'); // 640 * 0.70
  });

  it('never relies on @media or the mc-stack/mc-column classes (ADR-037 §2 -- @media is stripped by the sanitizer)', () => {
    const html = emitNode(section([row([column({ width: 100 })])]));
    expect(html).not.toContain('@media');
    expect(html).not.toContain('mc-stack');
    expect(html).not.toContain('mc-column');
  });

  it('renders a full document with no @media anywhere, including the wrapper', () => {
    const doc: Doc = { title: 'Test', variables: [], nodes: [section([row([column({ children: [text()] })])])] };
    expect(emitDoc(doc)).not.toContain('@media');
  });

  it('drops a hidden column from a row entirely', () => {
    const html = emitNode(row([column({ width: 100, visible: false })]));
    expect(html).not.toContain('display:inline-block');
  });
});

describe('emitNode: section/column padding, border, and 4-corner radius (S4 Task 18, decision 4)', () => {
  it('applies padding, border, and a 4-corner border-radius to a section', () => {
    const html = emitNode(section([], {
      paddingTop: 16, paddingRight: 20, paddingBottom: 16, paddingLeft: 20,
      borderColor: '#dbe5e0', borderWidth: 1,
      radiusTopLeft: 8, radiusTopRight: 8, radiusBottomRight: 0, radiusBottomLeft: 0,
    }));
    expect(html).toContain('padding:16px 20px 16px 20px');
    expect(html).toContain('border:1px solid #dbe5e0');
    expect(html).toContain('border-radius:8px 8px 0px 0px');
  });

  it('omits a real border on a section by default (border:0, not a fabricated color)', () => {
    const html = emitNode(section([]));
    expect(html).toContain('border:0');
  });

  it('applies a per-corner border-radius to a column when any corner is set', () => {
    const html = emitNode(column({ radiusTopLeft: 12, radiusTopRight: 4 }));
    expect(html).toContain('border-radius:12px 4px 0px 0px');
  });

  it('falls back to the single radius value on a column when no corner is set', () => {
    const html = emitNode(column({ radius: 6 }));
    expect(html).toContain('border-radius:6px');
  });

  it('applies border color/width to a column', () => {
    const html = emitNode(column({ borderColor: '#173f33', borderWidth: 2 }));
    expect(html).toContain('border:2px solid #173f33');
  });
});

// S4 Task 20 (MC-UI-007 change_responsive_rules): document.ts's Node already declared
// `stackMobile` but nothing read it, and there was no document-level default either --
// every row always auto-stacked (width:100%). theme.stackColumns is the real, wired switch:
// true/undefined keeps today's fluid behaviour byte-identical; false forces a fixed pixel
// width so columns never collapse even in a narrow client.
describe('emitNode: theme.stackColumns (S4 Task 20)', () => {
  it('defaults to stacking (width:100%) when stackColumns is unset, unchanged from before this task', () => {
    const html = emitNode(row([column({ width: 50 })]), { ...defaultTheme });
    expect(html).toContain('width:100%');
  });

  it('keeps stacking explicitly when stackColumns is true', () => {
    const html = emitNode(row([column({ width: 50 })]), { ...defaultTheme, stackColumns: true });
    expect(html).toContain('width:100%');
  });

  it('forces a fixed pixel width instead of width:100% when stackColumns is false', () => {
    const html = emitNode(row([column({ width: 50 })]), { ...defaultTheme, stackColumns: false });
    expect(html).not.toContain('width:100%');
    expect(html).toContain('width:320px'); // 50% of the 640px default theme width
  });

  it('still has no @media either way (ADR-037 §2 stands regardless of this toggle)', () => {
    const html = emitNode(row([column({ width: 50 })]), { ...defaultTheme, stackColumns: false });
    expect(html).not.toContain('@media');
  });
});

// S4 Task 20 (MC-UI-011): raw sanitized HTML the author typed, emitted verbatim. Safety is
// not this function's job -- the whole document still goes through sanitizeTemplateHtml
// server-side before storage (spec §2.12: "no bypass for origin: 'builder'"), the same gate
// every other block's output passes through.
describe('emitNode: customHtml (S4 Task 20, MC-UI-011)', () => {
  it('emits the html field verbatim', () => {
    const html = emitNode({ id: 'ch1', kind: 'customHtml', visible: true, html: '<p style="color:#173f33">Đoạn tuỳ chỉnh</p>' });
    expect(html).toBe('<p style="color:#173f33">Đoạn tuỳ chỉnh</p>');
  });

  it('emits an empty string for an empty or missing html field', () => {
    expect(emitNode({ id: 'ch2', kind: 'customHtml', visible: true, html: '' })).toBe('');
    expect(emitNode({ id: 'ch3', kind: 'customHtml', visible: true })).toBe('');
  });

  /**
   * ADR-044 Task SV-5. The prototype's code panel has two tabs, HTML and CSS
   * (`v3-code-tabs`), and renders the pair as `<style>{css}</style>` beside the
   * markup. S4 gave the node only `html`, so the second tab had nothing behind
   * it -- unlike `v3-widths` and `v3-surface-presets`, which the register
   * rejects because the sanitizer strips what they set. This one survives:
   * `template-html-sanitizer` INLINES a `<style>` block's declarations into
   * `style=""` and then drops the tag, so CSS written here reaches the
   * recipient. That is why the field was added rather than the tab excused.
   */
  it('emits the css field as a style block ahead of the markup', () => {
    const html = emitNode({ id: 'ch4', kind: 'customHtml', visible: true, html: '<p class="lead">Xin chào</p>', css: '.lead{color:#173f33}' });
    expect(html).toBe('<style>.lead{color:#173f33}</style><p class="lead">Xin chào</p>');
  });

  it('emits no style block when the css field is blank, so an unused tab costs the email nothing', () => {
    expect(emitNode({ id: 'ch5', kind: 'customHtml', visible: true, html: '<p>Xin chào</p>', css: '   ' })).toBe('<p>Xin chào</p>');
  });

  it('emits nothing at all when there is css but no markup for it to style', () => {
    expect(emitNode({ id: 'ch6', kind: 'customHtml', visible: true, html: '', css: '.lead{color:#173f33}' })).toBe('');
  });
});

/**
 * MC-UI-005 `mark_decorative` (S6 Task 39, ADR-043 §8).
 *
 * A decorative image needs BOTH halves to be read correctly: `alt=""` alone is
 * ambiguous -- a screen reader cannot tell a deliberate empty alt from one
 * someone forgot -- while `role="presentation"` says the emptiness is on
 * purpose. That pairing is also exactly what Task 40 teaches
 * `IMAGE_ALT_MISSING` to stop warning about, so it has to be emitted together
 * or the lint stays noisy on images that are already correct.
 */
describe('decorative images (S6 Task 39)', () => {
  it.each([
    ['image', () => image({ alt: 'Ảnh sản phẩm', decorative: true })],
    ['banner', () => banner({ alt: 'Banner', decorative: true })],
    ['logo', () => logo({ src: 'https://cdn.example.test/logo.png', alt: 'Logo', decorative: true })],
  ] as const)('emits alt="" AND role="presentation" for a decorative %s', (_kind, make) => {
    const html = emitNode(make());
    expect(html).toContain('alt=""');
    expect(html).toContain('role="presentation"');
  });

  it('does not leak the stored alt text into the emitted image', () => {
    expect(emitNode(image({ alt: 'Ảnh sản phẩm', decorative: true }))).not.toContain('Ảnh sản phẩm');
  });

  it('leaves a normal image untouched -- no role attribute appears where it would be wrong', () => {
    const html = emitNode(image({ alt: 'Ảnh sản phẩm' }));
    expect(html).toContain('alt="Ảnh sản phẩm"');
    expect(html).not.toContain('role="presentation"');
  });

  it('still emits nothing for a decorative image with no src -- decorative is not a substitute for having an image', () => {
    expect(emitNode(image({ src: '', decorative: true }))).toBe('');
  });
});

/**
 * ADR-044 restoration. `contact` is one of the prototype's sixteen block kinds
 * (`studio.tsx:7`) and was the only one that never reached the repo. Nothing
 * recorded the omission -- the string "contact" appears nowhere in docs/ -- and
 * no gate could see it, because ARCH-MAILCRAFT-FIDELITY checks actions and
 * states, never the block set.
 *
 * Asserted through the emitter rather than the model alone, because a block that
 * exists in the tree and emits nothing is the exact failure the screen-design
 * spec §1.3 calls a design error: visible on the canvas, absent from the email.
 */
describe('contact block (ADR-044: restored from the prototype)', () => {
  const contactNode = (contact: Partial<NonNullable<Node['contact']>>): Node => ({
    id: 'c1', kind: 'contact', visible: true, textColor: '#24342e',
    contact: { name: '', role: '', email: '', phone: '', address: '', ...contact },
  });

  it('emits the name and role on one line, separated the way the prototype does', () => {
    const html = emitNode(contactNode({ name: 'Phòng Nhân sự', role: 'Alta Software' }));
    expect(html).toContain('Phòng Nhân sự');
    expect(html).toContain('Alta Software');
    expect(html).toMatch(/Phòng Nhân sự\s*·\s*Alta Software/);
  });

  it('makes the email and phone actionable, which is the whole point of the block', () => {
    const html = emitNode(contactNode({ email: 'hr@alta.test', phone: '+84 28 1234 5678' }));
    expect(html).toContain('href="mailto:hr@alta.test"');
    // The tel: href keeps digits and a leading +, so a phone written for humans
    // still dials. The visible text keeps its spacing.
    expect(html).toMatch(/href="tel:\+842812345678"/);
    expect(html).toContain('+84 28 1234 5678');
  });

  it('drops a line that has nothing in it rather than emitting an empty separator', () => {
    const html = emitNode(contactNode({ name: 'Phòng Nhân sự', address: 'Số 1, Quận 1' }));
    expect(html).not.toMatch(/·\s*·/);
    expect(html).not.toMatch(/<br>\s*<br>/);
    expect(html).toContain('Số 1, Quận 1');
  });

  it('escapes what a person typed, so a contact name cannot carry markup', () => {
    expect(emitNode(contactNode({ name: '<script>alert(1)</script>' }))).not.toContain('<script>');
  });

  it('emits nothing at all when every field is empty', () => {
    expect(emitNode(contactNode({}))).toBe('');
  });
});

describe('footer block (ADR-050: CAN-SPAM postal address)', () => {
  const footerNode = (footer: Partial<NonNullable<Node['footer']>>, overrides: Partial<Node> = {}): Node => ({
    id: 'f1', kind: 'footer', visible: true,
    footer: { companyName: '', address: '', ...footer },
    ...overrides,
  });

  it('emits the company name, then each address line, joined with <br>', () => {
    const html = emitNode(footerNode({ companyName: 'Alta Software', address: '123 Đường Láng\nQuận Đống Đa, Hà Nội' }));
    expect(html).toContain('Alta Software<br>123 Đường Láng<br>Quận Đống Đa, Hà Nội');
  });

  it('skips blank address lines, the same convention emitList gives `content`', () => {
    const html = emitNode(footerNode({ companyName: 'Alta', address: '123 Đường Láng\n\n   \nHà Nội' }));
    expect(html).toContain('123 Đường Láng<br>Hà Nội');
    expect(html).not.toMatch(/<br>\s*<br>/);
  });

  it('drops the company-name line rather than an empty leading <br> when only the address is filled in', () => {
    const html = emitNode(footerNode({ companyName: '', address: '123 Đường Láng' }));
    expect(html).toContain('>123 Đường Láng<');
    expect(html).not.toMatch(/^<p[^>]*><br>/);
  });

  it('emits nothing at all when company name and address are both empty, like an image with no src', () => {
    expect(emitNode(footerNode({}))).toBe('');
    expect(emitNode(footerNode({ companyName: '   ', address: '  \n  ' }))).toBe('');
  });

  it('escapes what a person typed, so neither field can carry markup', () => {
    const html = emitNode(footerNode({ companyName: '<script>alert(1)</script>', address: '<b>123</b>' }));
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;b&gt;');
  });

  it('takes the ADR-047 dark ink class only while the colour is still default', () => {
    expect(emitNode(footerNode({ companyName: 'Alta' }))).toContain('mc-dark-ink');
    expect(emitNode(footerNode({ companyName: 'Alta' }, { textColor: '#ff6600' }))).not.toContain('mc-dark-ink');
  });
});

/**
 * ADR-045. The emitter half: opening the sanitizer's allowlist buys nothing
 * until the emitter actually produces this markup -- which is precisely the
 * trap ADR-042 fell into (allowlist opened, the controls never built, the stale
 * comment still claiming the properties were stripped). These tests exist so
 * the same gap cannot open here silently.
 */
describe('ADR-045: the Outlook compatibility layer the emitter produces', () => {
  const column = (width: number, child: Node): Node => ({ id: uid('col'), kind: 'column', width, visible: true, children: [child] });
  const para = (text: string): Node => ({ id: uid('p'), kind: 'text', content: text, visible: true });
  const row = (...children: Node[]): Node => ({ id: uid('row'), kind: 'row', visible: true, children });

  it('scaffolds a multi-column row with ghost tags carrying real pixel widths', () => {
    // 640px theme: a 35/65 split is 224px and 416px.
    const html = emitNode(row(column(35, para('A')), column(65, para('B'))), defaultTheme);

    expect(html).toContain('<mso-ghost data-mso="row-open"></mso-ghost>');
    expect(html).toContain('<mso-ghost data-mso="col-open" data-w="224"></mso-ghost>');
    expect(html).toContain('<mso-ghost data-mso="col-open" data-w="416"></mso-ghost>');
    expect(html).toContain('<mso-ghost data-mso="col-close"></mso-ghost>');
    expect(html).toContain('<mso-ghost data-mso="row-close"></mso-ghost>');
  });

  /** The ghost `<td>` and the `<div>`'s own cap must be the same number, or Outlook lays out to a width no other client uses. */
  it('gives the ghost cell the same width the column caps itself at', () => {
    const html = emitNode(row(column(50, para('A')), column(50, para('B'))), defaultTheme);
    expect(html).toContain('data-w="320"');
    expect(html).toContain('max-width:320px');
  });

  /** A lone full-width div already stacks correctly in Word, so the scaffolding would be bytes for nothing -- and Gmail clips at 102KB. */
  it('leaves a one-column row unscaffolded', () => {
    expect(emitNode(row(column(100, para('A'))), defaultTheme)).not.toContain('mso-ghost');
  });

  it('counts only visible columns when deciding to scaffold', () => {
    const hidden: Node = { ...column(50, para('B')), visible: false };
    expect(emitNode(row(column(50, para('A')), hidden), defaultTheme)).not.toContain('mso-ghost');
  });

  it('tells Word to honour line-height instead of the font default', () => {
    expect(emitNode(para('Xin chào'))).toContain('mso-line-height-rule:exactly');
  });

  /** ADR-040 and the sanitizer audit both recorded that the preheader stayed visible in Outlook desktop. This is the declaration that retires that. */
  it('hides the preheader in Outlook desktop too', () => {
    const node: Node = { id: uid('pre'), kind: 'preheader', content: 'Xem trước', visible: true };
    expect(emitNode(node)).toContain('mso-hide:all');
  });

  it('zeroes the spacing Word adds around every layout table', () => {
    const html = emitDoc({ title: 'T', nodes: [row(column(100, para('A')))], variables: [] } as Doc);
    expect(html).toMatch(/mso-table-lspace:0pt;mso-table-rspace:0pt/);
  });

  describe('the head tags, none of which used to survive', () => {
    const docOf = (title: string): Doc => ({ title, nodes: [para('A')], variables: [] });

    /**
     * Audit backlog §6. `color-scheme: light dark` tells the client not to
     * invert; a dark-mode client then leaves the white content background
     * alone and paints unstyled text with its own light default. Every block
     * that omits `textColor` emits `color:inherit`, so the email has to answer
     * that inherit itself or the declaration removes the safety net from the
     * only case that needed one.
     */
    it('gives the color:inherit chain a floor on <body>, so an uncoloured block is never client-coloured', () => {
      const html = emitDoc({ title: 'T', variables: [], theme: {}, nodes: [
        { id: 's', kind: 'section', visible: true, children: [
          { id: 'r', kind: 'row', visible: true, children: [
            { id: 'c', kind: 'column', width: 100, visible: true, children: [{ id: 't', kind: 'text', visible: true, content: 'Xin chào' }] },
          ] }] }],
      } as unknown as Doc);
      expect(html).toMatch(/<body[^>]*style="[^"]*color:#30463d/);
      // The block itself still says `inherit`; the point is that it now
      // inherits from the email rather than from the reader's mail client.
      expect(html).toContain('color:inherit');
    });

    it('emits charset, viewport, color-scheme and lang', () => {
      const html = emitDoc(docOf('Thư mời'));
      expect(html).toContain('<html lang="vi">');
      expect(html).toContain('<meta charset="utf-8">');
      expect(html).toContain('<meta name="viewport" content="width=device-width,initial-scale=1">');
      expect(html).toContain('<meta name="color-scheme" content="light dark">');
    });

    it('titles the document and escapes what it puts there', () => {
      expect(emitDoc(docOf('Thư mời'))).toContain('<title>Thư mời</title>');
      expect(emitDoc(docOf('A & <B>'))).toContain('<title>A &amp; &lt;B&gt;</title>');
    });

    it('omits the title element rather than emitting an empty one', () => {
      expect(emitDoc(docOf('   '))).not.toContain('<title>');
    });
  });
});

/**
 * ADR-042, built 2026-09-10. The ADR opened four properties on 2026-09-02 so
 * these controls could exist, and then nothing was built for eight days while
 * three separate comments asserted the opposite. These tests are the part that
 * makes the claim checkable rather than repeatable.
 */
describe('ADR-042: the four properties finally reach the HTML', () => {
  const textNode = (overrides: Partial<Node> = {}): Node => ({ id: uid('t'), kind: 'text', content: 'Xin chào', visible: true, ...overrides });
  const section = (overrides: Partial<Node> = {}): Node => ({ id: uid('s'), kind: 'section', visible: true, background: '#ffffff', children: [textNode()], ...overrides });
  const columnNode = (overrides: Partial<Node> = {}): Node => ({ id: uid('c'), kind: 'column', visible: true, width: 100, children: [textNode()], ...overrides });

  describe('letter-spacing and text-transform', () => {
    it('writes both when they are set', () => {
      const html = emitNode(textNode({ letterSpacing: 2, textTransform: 'uppercase' }));
      expect(html).toContain('letter-spacing:2px');
      expect(html).toContain('text-transform:uppercase');
    });

    /** ADR-042 gave letter-spacing a SIGNED grammar of its own precisely for this. */
    it('writes negative tracking, which is why the property got its own value pattern', () => {
      expect(emitNode(textNode({ letterSpacing: -0.5 }))).toContain('letter-spacing:-0.5px');
    });

    /** A declaration that changes nothing is still bytes in every copy of the email. */
    it('omits both at their no-op values rather than writing them out', () => {
      const html = emitNode(textNode({ letterSpacing: 0, textTransform: 'none' }));
      expect(html).not.toContain('letter-spacing');
      expect(html).not.toContain('text-transform');
    });

    it('applies to a heading as well as a paragraph', () => {
      expect(emitNode(textNode({ kind: 'heading', headingLevel: 2, letterSpacing: -1 }))).toContain('letter-spacing:-1px');
    });
  });

  describe('the surface group on Section and Column', () => {
    it('layers a gradient over the flat colour instead of replacing it', () => {
      const html = emitNode(section({ background: '#173f33', backgroundMode: 'gradient', gradientTo: '#18342c', gradientAngle: 180 }));
      expect(html).toContain('background-color:#173f33');
      expect(html).toContain('background-image:linear-gradient(180deg,#173f33 0%,#18342c 100%)');
      // order matters: the fallback must be declared BEFORE the effect
      expect(html.indexOf('background-color')).toBeLessThan(html.indexOf('background-image'));
    });

    it('defaults the gradient angle and end colour to the prototype values', () => {
      expect(emitNode(section({ backgroundMode: 'gradient' }))).toContain('background-image:linear-gradient(135deg,#ffffff 0%,#e9f3ee 100%)');
    });

    it('writes no gradient in solid mode', () => {
      expect(emitNode(section({ backgroundMode: 'solid', gradientTo: '#18342c' }))).not.toContain('background-image');
    });

    it('emits the two shadows the prototype defines', () => {
      expect(emitNode(section({ elevation: 'soft' }))).toContain('box-shadow:0 8px 18px #c4d0ca');
      expect(emitNode(section({ elevation: 'strong', shadowColor: '#9eafa7' }))).toContain('box-shadow:0 14px 28px #9eafa7');
    });

    /**
     * The cap is not cosmetic: ADR-038's shorthand grammar accepts at most four
     * tokens, so a fifth would be stripped by the sanitizer and the control
     * would lie -- which is the whole failure ADR-042 exists to prevent.
     */
    it('keeps every shadow within the four tokens the allowlist accepts', () => {
      for (const elevation of ['soft', 'strong'] as const) {
        const shadow = /box-shadow:([^;"]+)/.exec(emitNode(section({ elevation })))?.[1] ?? '';
        expect(shadow.trim().split(/\s+/)).toHaveLength(4);
        expect(shadow).not.toContain('inset');
      }
    });

    it('writes nothing for the flat elevation', () => {
      expect(emitNode(section({ elevation: 'flat' }))).not.toContain('box-shadow');
    });

    it('gives a Column the same surface treatment as a Section', () => {
      const html = emitNode(columnNode({ backgroundMode: 'gradient', elevation: 'soft' }), defaultTheme);
      expect(html).toContain('background-image:linear-gradient(');
      expect(html).toContain('box-shadow:0 8px 18px');
    });
  });
});
