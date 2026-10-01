import { describe, expect, it } from 'vitest';
import type { InlineMark } from './document.js';
import { diffEdit, inlineMarkCovers, inlineSegments, normalizeInlineMarks, shiftInlineMarks, toggleInlineMark } from './inline.js';

const strong = (start: number, end: number): InlineMark => ({ start, end, kind: 'strong' });
const em = (start: number, end: number): InlineMark => ({ start, end, kind: 'em' });
const link = (start: number, end: number, href: string): InlineMark => ({ start, end, kind: 'link', href });

describe('normalizeInlineMarks (ADR-046 decision 5)', () => {
  it('drops a zero-width mark', () => {
    expect(normalizeInlineMarks([strong(3, 3)], 10)).toEqual([]);
  });

  it('drops an inverted mark rather than silently swapping its ends', () => {
    expect(normalizeInlineMarks([strong(7, 2)], 10)).toEqual([]);
  });

  it('clamps a mark that runs past the end of the text', () => {
    expect(normalizeInlineMarks([strong(2, 99)], 10)).toEqual([strong(2, 10)]);
  });

  it('drops every mark when the text is empty, so an emptied block cannot keep formatting alive', () => {
    expect(normalizeInlineMarks([strong(0, 4)], 0)).toEqual([]);
  });

  it('drops a link with no destination -- the words survive, the link does not', () => {
    expect(normalizeInlineMarks([{ start: 0, end: 4, kind: 'link', href: '   ' }], 10)).toEqual([]);
  });

  it('drops a kind that is not one of the four the ADR allows', () => {
    const forged = [{ start: 0, end: 4, kind: 'script' } as unknown as InlineMark];
    expect(normalizeInlineMarks(forged, 10)).toEqual([]);
  });
});

describe('inlineSegments (ADR-046 decision 5: overlap becomes nesting)', () => {
  it('returns one unmarked run when there is no formatting', () => {
    expect(inlineSegments('Xin chào', [])).toEqual([{ text: 'Xin chào', marks: [] }]);
  });

  it('cuts the text at every mark boundary', () => {
    expect(inlineSegments('abcdef', [strong(2, 4)])).toEqual([
      { text: 'ab', marks: [] },
      { text: 'cd', marks: ['strong'] },
      { text: 'ef', marks: [] },
    ]);
  });

  /** The case that has no HTML spelling: bold "abc" then italic "bcd" would be crossed tags. */
  it('turns an overlap into three runs carrying the sets that actually cover them', () => {
    expect(inlineSegments('abcdef', [strong(0, 3), em(1, 4)])).toEqual([
      { text: 'a', marks: ['strong'] },
      { text: 'bc', marks: ['strong', 'em'] },
      { text: 'd', marks: ['em'] },
      { text: 'ef', marks: [] },
    ]);
  });

  it('orders the mark set the same way whichever order the author applied them', () => {
    const applied = inlineSegments('abc', [em(0, 3), strong(0, 3)]);
    const reversed = inlineSegments('abc', [strong(0, 3), em(0, 3)]);
    expect(applied).toEqual(reversed);
    expect(applied[0]!.marks).toEqual(['strong', 'em']);
  });

  it('merges abutting runs with the same signature rather than emitting two pairs of tags', () => {
    expect(inlineSegments('abcd', [strong(0, 2), strong(2, 4)])).toEqual([{ text: 'abcd', marks: ['strong'] }]);
  });

  it('carries the href on the run a link covers, and only there', () => {
    expect(inlineSegments('abcd', [link(1, 3, 'https://a.test')])).toEqual([
      { text: 'a', marks: [] },
      { text: 'bc', marks: ['link'], href: 'https://a.test' },
      { text: 'd', marks: [] },
    ]);
  });

  it('returns nothing for empty content', () => {
    expect(inlineSegments('', [strong(0, 3)])).toEqual([]);
  });
});

describe('toggleInlineMark', () => {
  it('adds a mark over the selection', () => {
    expect(toggleInlineMark([], 10, 2, 5, 'strong')).toEqual([strong(2, 5)]);
  });

  it('removes the mark when the selection is already fully covered', () => {
    expect(toggleInlineMark([strong(0, 10)], 10, 2, 5, 'strong')).toEqual([strong(0, 2), strong(5, 10)]);
  });

  it('adds rather than removes when the selection is only partly covered', () => {
    const next = toggleInlineMark([strong(0, 3)], 10, 2, 6, 'strong');
    expect(inlineSegments('abcdefghij', next)).toEqual([
      { text: 'abcdef', marks: ['strong'] },
      { text: 'ghij', marks: [] },
    ]);
  });

  it('ignores a collapsed selection -- a caret is not a range', () => {
    expect(toggleInlineMark([strong(0, 4)], 10, 5, 5, 'em')).toEqual([strong(0, 4)]);
  });

  it('replaces an existing destination instead of stacking two links on one word', () => {
    const next = toggleInlineMark([link(0, 4, 'https://old.test')], 10, 0, 4, 'link', 'https://new.test');
    expect(next).toEqual([link(0, 4, 'https://new.test')]);
  });

  it('removes the link when applied with no destination', () => {
    expect(toggleInlineMark([link(0, 4, 'https://a.test')], 10, 0, 4, 'link')).toEqual([]);
  });
});

describe('inlineMarkCovers', () => {
  it('sees a selection covered by two abutting marks as covered', () => {
    expect(inlineMarkCovers([strong(0, 3), strong(3, 8)], 10, 1, 6, 'strong')).toBe(true);
  });

  it('sees a gap', () => {
    expect(inlineMarkCovers([strong(0, 3), strong(4, 8)], 10, 1, 6, 'strong')).toBe(false);
  });

  it('does not confuse one kind for another', () => {
    expect(inlineMarkCovers([em(0, 10)], 10, 1, 6, 'strong')).toBe(false);
  });
});

describe('shiftInlineMarks (ADR-046 §Consequences: the fragile part)', () => {
  it('moves a mark right when text is inserted before it', () => {
    // "abc" -> "XXabc", mark on "bc" travels with the words.
    expect(shiftInlineMarks([strong(1, 3)], 0, 0, 2, 5)).toEqual([strong(3, 5)]);
  });

  it('leaves a mark alone when the insertion is after it', () => {
    expect(shiftInlineMarks([strong(0, 2)], 4, 4, 3, 8)).toEqual([strong(0, 2)]);
  });

  it('grows the mark when text is inserted inside it', () => {
    expect(shiftInlineMarks([strong(1, 4)], 2, 2, 3, 9)).toEqual([strong(1, 7)]);
  });

  it('shrinks the mark when part of it is deleted', () => {
    // "abcdef" -> "abef": [2,4) removed, mark [1,5) becomes [1,3).
    expect(shiftInlineMarks([strong(1, 5)], 2, 4, 0, 4)).toEqual([strong(1, 3)]);
  });

  it('drops the mark when every character it covered is gone', () => {
    expect(shiftInlineMarks([strong(2, 5)], 2, 5, 0, 5)).toEqual([]);
  });

  it('lets text typed at either boundary stay outside the mark', () => {
    // At the start: the mark slides right, it does not swallow what was typed.
    expect(shiftInlineMarks([strong(2, 5)], 2, 2, 2, 10)).toEqual([strong(4, 7)]);
    // At the end: unchanged.
    expect(shiftInlineMarks([strong(2, 5)], 5, 5, 2, 10)).toEqual([strong(2, 5)]);
  });

  it('handles a replacement that is longer than what it replaced, which is what inserting {{bien}} over a selection is', () => {
    // "Chào ban" -> "Chào {{ten}}": [5,8) replaced by 9 characters.
    expect(shiftInlineMarks([strong(0, 4)], 5, 8, 9, 14)).toEqual([strong(0, 4)]);
    expect(shiftInlineMarks([strong(0, 8)], 5, 8, 9, 14)).toEqual([strong(0, 14)]);
  });
});

describe('diffEdit', () => {
  it('reports a pure insertion', () => {
    expect(diffEdit('abc', 'abXYc')).toEqual({ start: 2, end: 2, inserted: 2 });
  });

  it('reports a pure deletion', () => {
    expect(diffEdit('abcdef', 'abef')).toEqual({ start: 2, end: 4, inserted: 0 });
  });

  it('reports a replacement, which is what inserting {{bien}} over a selection is', () => {
    expect(diffEdit('Chào ban', 'Chào {{ten}}')).toEqual({ start: 5, end: 8, inserted: 7 });
  });

  it('reports nothing changed as a zero-width edit at the end of the common prefix', () => {
    expect(diffEdit('abc', 'abc')).toEqual({ start: 3, end: 3, inserted: 0 });
  });

  it('handles appending to an empty string', () => {
    expect(diffEdit('', 'abc')).toEqual({ start: 0, end: 0, inserted: 3 });
  });

  it('handles clearing the field', () => {
    expect(diffEdit('abc', '')).toEqual({ start: 0, end: 3, inserted: 0 });
  });

  /** The round trip that matters: an edit reported by diffEdit, fed to shiftInlineMarks, keeps the mark on its words. */
  it('composes with shiftInlineMarks to keep a mark on the same word', () => {
    const before = 'Giảm 50% hôm nay';
    const after = 'Giảm ngay 50% hôm nay';
    const mark: InlineMark = { start: 5, end: 8, kind: 'strong' };
    const edit = diffEdit(before, after);
    const moved = shiftInlineMarks([mark], edit.start, edit.end, edit.inserted, after.length);
    expect(after.slice(moved[0]!.start, moved[0]!.end)).toBe('50%');
  });
});
