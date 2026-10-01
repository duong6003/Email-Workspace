export const FOCUSABLE_SELECTOR = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Returns the element focus must jump to, or null when the browser's own Tab
 * order already keeps focus inside the dialog. Intervening only at the edges
 * keeps native behaviour (and screen-reader announcements) intact everywhere
 * else.
 */
export function nextFocusTarget<T>(focusable: readonly T[], current: T | null, shiftKey: boolean): T | null {
  if (focusable.length === 0) return null;
  const index = current === null ? -1 : focusable.indexOf(current);
  if (index === -1) return shiftKey ? focusable[focusable.length - 1]! : focusable[0]!;
  if (!shiftKey && index === focusable.length - 1) return focusable[0]!;
  if (shiftKey && index === 0) return focusable[focusable.length - 1]!;
  return null;
}
