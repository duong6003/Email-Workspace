import type { CSSProperties } from 'react';
import type { Node } from './document.js';
import { borderCss, paddingCss, radiusCss, surfaceEffects } from './emitter.js';

/**
 * What a node looks like on the canvas, read from the SAME helpers `emitter.ts`
 * uses to write the email.
 *
 * The canvas is a structural surface, not a pixel-accurate render -- that is
 * `PreviewService` behind "Xem trước". But "structural" was doing more work than
 * it should: `CanvasNodeView` applied no style at all to a Section or a Column,
 * so all eleven of their design controls changed the mail and left the screen
 * identical. An author has no way to tell that apart from a control that does
 * not work, and they were right to call it one.
 *
 * Sharing the emitter's helpers rather than restating the rules is the point: a
 * default changed there moves the canvas with it, and the two cannot drift into
 * the disagreement that started this.
 */
export function nodeSurfaceStyle(node: Node): CSSProperties {
  return {
    padding: paddingCss(node),
    background: node.background ?? '#ffffff',
    // ADR-042's gradient and elevation, from `surfaceEffects` -- the same values
    // `emitSection`/`emitColumn` write. They were missing here for one commit,
    // which put both controls in the state this file exists to prevent: they
    // changed the mail and left the screen identical.
    ...surfaceEffects(node),
    border: borderCss(node),
    borderRadius: radiusCss(node),
  };
}

/**
 * The typography of a text or heading block. `emitText`'s own defaults, so an
 * untouched block reads the same on both sides.
 *
 * `color` and `fontFamily` stay undefined when the block does not set them --
 * `emitText` writes `inherit` there, and inheriting is exactly what the canvas
 * should do too: the email theme's font and ink come down from `.v3-email`.
 */
export function leafTextStyle(node: Node): CSSProperties {
  const heading = node.kind === 'heading';
  return {
    display: 'block',
    color: node.textColor,
    textAlign: node.align ?? 'left',
    fontFamily: node.fontFamily,
    fontSize: `${node.fontSize ?? (heading ? 28 : 14)}px`,
    lineHeight: node.lineHeight ?? (heading ? 1.2 : 1.6),
    fontWeight: node.fontWeight ?? (heading ? 700 : 400),
    // ADR-042's two typography controls. Omitted at their no-op values for the
    // same reason `emitText` omits them: the two sides stay comparable
    // declaration for declaration, which is what makes a drift visible.
    letterSpacing: node.letterSpacing ? `${node.letterSpacing}px` : undefined,
    textTransform: node.textTransform && node.textTransform !== 'none' ? node.textTransform : undefined,
  };
}
