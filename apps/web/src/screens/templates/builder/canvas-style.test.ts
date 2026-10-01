import { describe, expect, it } from 'vitest';
import type { Node } from './document.js';
import { emitNode, surfaceEffects } from './emitter.js';
import { leafTextStyle, nodeSurfaceStyle } from './canvas-style.js';
import { inlineSegments, segmentTagNames } from './inline.js';

/**
 * The canvas paints what the email will paint.
 *
 * `inspector-effect.test.ts` proved the other half: every control in the
 * Inspector does reach the emitted HTML. So when "một số thuộc tính chưa chạy
 * đúng logic", the value is arriving in the mail and not on the screen the
 * author is looking at -- which is the same complaint either way.
 *
 * Measured: `CanvasNodeView` applied NO style to a Section or a Column, so all
 * eleven of their design controls (four paddings, background, border colour and
 * width, four radius corners) changed the email and nothing else. And
 * `CanvasLeafPreview` carried `fontSize`, `fontWeight` and `align` on a text
 * block but dropped `textColor`, `lineHeight` and `fontFamily`, which
 * `emitText` all emit.
 *
 * These read the emitter's own helpers rather than restating the rules, so the
 * two cannot drift: a default changed in `emitter.ts` moves the canvas with it.
 */
const section = (overrides: Partial<Node> = {}): Node => ({ id: 's', kind: 'section', visible: true, children: [], ...overrides });
const text = (overrides: Partial<Node> = {}): Node => ({ id: 't', kind: 'text', visible: true, content: 'xin chào', ...overrides });

describe('nodeSurfaceStyle -- Section and Column', () => {
  it('paints the background the emitter paints, defaulting to white', () => {
    expect(nodeSurfaceStyle(section()).background).toBe('#ffffff');
    expect(nodeSurfaceStyle(section({ background: '#173f33' })).background).toBe('#173f33');
  });

  it('carries all four paddings', () => {
    expect(nodeSurfaceStyle(section({ paddingTop: 24, paddingLeft: 8 })).padding).toBe('24px 0px 0px 8px');
  });

  it('draws no border until a width is set, matching borderCss', () => {
    expect(nodeSurfaceStyle(section({ borderColor: '#ff0000' })).border).toBe('0');
    expect(nodeSurfaceStyle(section({ borderWidth: 2, borderColor: '#ff0000' })).border).toBe('2px solid #ff0000');
  });

  it('takes the four corners when any of them is set, and the single radius otherwise', () => {
    expect(nodeSurfaceStyle(section({ radiusTopLeft: 12 })).borderRadius).toBe('12px 0px 0px 0px');
    expect(nodeSurfaceStyle(section({ radius: 9 })).borderRadius).toBe('9px');
  });
});

describe('leafTextStyle -- what a text or heading block looks like', () => {
  it('carries the three properties the canvas was dropping', () => {
    const style = leafTextStyle(text({ textColor: '#40534b', lineHeight: 1.9, fontFamily: 'Georgia, serif' }));
    expect(style.color).toBe('#40534b');
    expect(style.lineHeight).toBe(1.9);
    expect(style.fontFamily).toBe('Georgia, serif');
  });

  it('falls back to the emitter\'s own defaults, so an untouched block looks the same in both', () => {
    expect(leafTextStyle(text())).toMatchObject({ fontSize: '14px', fontWeight: 400, lineHeight: 1.6, textAlign: 'left' });
    expect(leafTextStyle({ id: 'h', kind: 'heading', visible: true })).toMatchObject({ fontSize: '28px', fontWeight: 700, lineHeight: 1.2 });
  });

  it('leaves colour and family unset rather than inventing one, so the email theme shows through', () => {
    const style = leafTextStyle(text());
    expect(style.color).toBeUndefined();
    expect(style.fontFamily).toBeUndefined();
  });
});

/**
 * The canvas and the email must agree.
 *
 * `canvas-style.ts` was written after eleven Section/Column controls changed
 * the mail and left the screen identical. It shares the emitter's helpers so
 * that cannot recur -- but sharing a helper only protects the properties that
 * go THROUGH the helper. The ADR-042 build added four controls to the emitter
 * alone and reintroduced the same drift for two of them in the very commit that
 * created them, which is what these tests are for: they compare the two sides
 * property by property instead of trusting that a shared import is enough.
 */
describe('canvas and email agree on what a block looks like', () => {
  const text = (overrides: Partial<Node> = {}): Node => ({ id: 't', kind: 'text', content: 'Xin chào', visible: true, ...overrides });
  const section = (overrides: Partial<Node> = {}): Node => ({
    id: 's', kind: 'section', visible: true, background: '#ffffff',
    children: [text()], ...overrides,
  });

  it('draws letter-spacing and text-transform where the email writes them', () => {
    const node = text({ letterSpacing: 2, textTransform: 'uppercase' });
    const style = leafTextStyle(node);
    const html = emitNode(node);

    expect(style.letterSpacing).toBe('2px');
    expect(html).toContain('letter-spacing:2px');
    expect(style.textTransform).toBe('uppercase');
    expect(html).toContain('text-transform:uppercase');
  });

  it('leaves both undefined on the canvas exactly when the email omits them', () => {
    const style = leafTextStyle(text({ letterSpacing: 0, textTransform: 'none' }));
    const html = emitNode(text({ letterSpacing: 0, textTransform: 'none' }));

    expect(style.letterSpacing).toBeUndefined();
    expect(html).not.toContain('letter-spacing');
    expect(style.textTransform).toBeUndefined();
    expect(html).not.toContain('text-transform');
  });

  it('draws the gradient and the shadow the email emits', () => {
    const node = section({ backgroundMode: 'gradient', gradientTo: '#18342c', gradientAngle: 180, elevation: 'strong', shadowColor: '#9eafa7' });
    const style = nodeSurfaceStyle(node);
    const html = emitNode(node);

    expect(style.backgroundImage).toBe('linear-gradient(180deg,#ffffff 0%,#18342c 100%)');
    expect(html).toContain(`background-image:${String(style.backgroundImage)}`);
    expect(style.boxShadow).toBe('0 14px 28px #9eafa7');
    expect(html).toContain(`box-shadow:${String(style.boxShadow)}`);
  });

  /** Both sides read the same function, so this is a property of the design rather than a coincidence of two literals. */
  it('takes both effects from one source', () => {
    const node = section({ backgroundMode: 'gradient', elevation: 'soft' });
    const effects = surfaceEffects(node);
    const style = nodeSurfaceStyle(node);

    expect(style.backgroundImage).toBe(effects.backgroundImage);
    expect(style.boxShadow).toBe(effects.boxShadow);
  });

  /**
   * The oldest drift of the three, and the one that shipped: `blocks.ts` puts
   * 14px on every new text block and the canvas has always drawn it, while
   * `emitText` had no `padding` line at all -- so an author approved spacing on
   * screen and the recipient got a paragraph flush against its neighbour.
   */
  it('emits the padding the canvas has always drawn on a text block', () => {
    const node = text({ paddingTop: 14, paddingRight: 14, paddingBottom: 14, paddingLeft: 14 });
    expect(nodeSurfaceStyle(node).padding).toBe('14px 14px 14px 14px');
    expect(emitNode(node)).toContain('padding:14px 14px 14px 14px');
  });

  it('keeps margin at zero as a reset rather than as spacing', () => {
    // Every client ships its own <p> margin and they disagree; the block states
    // 0 and takes its spacing from padding, which is why no control writes margin.
    expect(emitNode(text())).toContain('margin:0px 0px 0px 0px');
  });
});

/**
 * ADR-046 -- the inline half of the same promise this file exists to keep.
 *
 * Commit `2c23073` added two surface controls to `emitter.ts` and left the
 * canvas identical, which is exactly the drift the rest of this file guards
 * against for CSS. Inline formatting is a SECOND surface that can drift the
 * same way, and it cannot be guarded by comparing style properties, because it
 * is elements rather than declarations.
 *
 * So the comparison is structural: the tag names `inlineSegments` gives the
 * canvas must be the tag names that actually appear in the emitted HTML, in
 * order. `renderInlineContent` in `BuilderScreen` builds its elements from
 * `segmentTagNames`, so if the emitter learned a tag the canvas cannot draw
 * (or the map grew a fifth entry on one side only), these fail.
 */
const tagsInEmittedHtml = (node: Node): string[] =>
  [...emitNode(node).matchAll(/<(strong|em|u|a)\b/g)].map((match) => match[1]!);

const tagsOnCanvas = (node: Node): string[] =>
  inlineSegments(node.content ?? '', node.inline).flatMap((segment) => segmentTagNames(segment));

describe('inline rich text: the canvas draws the elements the email carries (ADR-046)', () => {
  it('agrees on a single bold range', () => {
    const node = text({ content: 'Giảm 50% hôm nay', inline: [{ start: 5, end: 8, kind: 'strong' }] });
    expect(tagsOnCanvas(node)).toEqual(['strong']);
    expect(tagsInEmittedHtml(node)).toEqual(tagsOnCanvas(node));
  });

  it('agrees on an overlap, including the order the marks nest in', () => {
    const node = text({ content: 'abcdef', inline: [{ start: 0, end: 3, kind: 'strong' }, { start: 1, end: 4, kind: 'em' }] });
    // strong, then strong+em, then em -- the emitter keeps `strong` open across
    // the first two, so it writes one `<strong>` where the canvas nests two.
    expect(tagsOnCanvas(node)).toEqual(['strong', 'strong', 'em', 'em']);
    expect(tagsInEmittedHtml(node)).toEqual(['strong', 'em', 'em']);
  });

  it('agrees on every one of the four kinds, so neither side can grow a fifth alone', () => {
    const node = text({
      content: 'abcd',
      inline: [
        { start: 0, end: 1, kind: 'strong' },
        { start: 1, end: 2, kind: 'em' },
        { start: 2, end: 3, kind: 'underline' },
        { start: 3, end: 4, kind: 'link', href: 'https://a.test' },
      ],
    });
    expect(tagsOnCanvas(node)).toEqual(['strong', 'em', 'u', 'a']);
    expect(tagsInEmittedHtml(node)).toEqual(tagsOnCanvas(node));
  });

  it('draws nothing extra for an unformatted block, on either side', () => {
    const node = text({ content: 'xin chào' });
    expect(tagsOnCanvas(node)).toEqual([]);
    expect(tagsInEmittedHtml(node)).toEqual([]);
  });

  /**
   * The one place the two sides legitimately differ, stated so nobody "fixes"
   * it: a rejected destination drops the anchor from the MAIL, and the canvas
   * has no anchor to draw either, because both read the same normalizer.
   */
  it('drops the anchor on both sides when the destination is rejected', () => {
    const node = text({ content: 'Bấm vào đây', inline: [{ start: 4, end: 11, kind: 'link', href: 'javascript:alert(1)' }] });
    expect(tagsInEmittedHtml(node)).toEqual([]);
    expect(emitNode(node)).toContain('vào đây');
  });
});
