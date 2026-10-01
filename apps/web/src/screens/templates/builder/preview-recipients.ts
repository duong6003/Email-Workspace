import type { Recipient } from '../../../api/recipients.js';

/**
 * The recipient column of MC-UI-008's preview (`v3-preview-work`), ADR-044
 * Task SV-5.
 *
 * **Why this mapping is copied, not invented.** The server already owns the
 * one true answer to "what would this template render for this person":
 * `apps/api/src/campaigns/recipient-variable-context.ts`, the function the
 * real send goes through. Three rules there are load-bearing and repeated
 * here on purpose, because a preview that maps differently from the send is
 * worse than no preview at all:
 *
 * 1. Only `email`, `first_name`, `last_name` and the recipient's custom
 *    fields are merged. `department`, `title` and `location` are columns on
 *    the row, not variables -- they show in the list so an author can tell two
 *    people apart, and merging them would promise a variable the send will not
 *    supply.
 * 2. A key the recipient has no value for is OMITTED, never merged as an empty
 *    string. That omission is exactly what makes `missingKeys` (BR-TPL-005)
 *    truthful: the server's own missing check stays the single source of
 *    "missing", and the preview does not paper over a gap the send would hit.
 * 3. `unsubscribe_url` is the one exception, and it is a sample. The send
 *    generates it per recipient from the recipient id (`unsubscribeUrlFor`);
 *    reporting it as "missing" in a preview would flag a key that is never
 *    actually missing, and teach authors to ignore the missing list.
 */

/** Keys the send always generates, so a preview must stand in for them rather than report them missing. */
export const PREVIEW_SYSTEM_SAMPLE: Record<string, string> = {
  unsubscribe_url: 'https://app.example.test/unsubscribe/preview',
};

export function recipientMergeData(recipient: Recipient): Record<string, string> {
  const merged: Record<string, string> = { ...PREVIEW_SYSTEM_SAMPLE, email: recipient.email };
  if (recipient.firstName !== null) merged.first_name = recipient.firstName;
  if (recipient.lastName !== null) merged.last_name = recipient.lastName;
  for (const [key, value] of Object.entries(recipient.customData)) {
    // `null`/`undefined` is an absent field, and merging it as "" would hide a
    // gap the send would report. Rule 2 above.
    if (value === null || value === undefined) continue;
    merged[key] = String(value);
  }
  return merged;
}

/** Family name first, the order a Vietnamese name is read and written in; the email when the row carries no name at all. */
export function recipientLabel(recipient: Recipient): string {
  const name = [recipient.lastName, recipient.firstName].filter((part) => part?.trim()).join(' ').trim();
  return name || recipient.email;
}

export function recipientInitial(recipient: Recipient): string {
  return recipientLabel(recipient).charAt(0).toUpperCase();
}

/** The prototype writes an em dash for a person with no department, and marks that row -- the caption keeps that shape. */
export function recipientCaption(recipient: Recipient): string {
  return recipient.department?.trim() || '—';
}
