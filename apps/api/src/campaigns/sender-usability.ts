/**
 * BR-CFG-002 (M5-GATE, DEC-115): one sender-usability rule with three callers
 * -- the schedule validation report, the send-now precheck and (restated in
 * raw SQL, not imported across the app boundary) the worker's own time-of-use
 * validation. A sender is usable only when it exists, is not soft-deleted and
 * is `verified`; `pending`, `failed` and `disabled` all block. Pure over the
 * row so the decision is testable without a database.
 */
export type SenderUsabilityReason = 'SENDER_MISSING' | 'SENDER_NOT_FOUND' | 'SENDER_NOT_VERIFIED';
export type SenderUsability = { valid: true } | { valid: false; reason: SenderUsabilityReason };

export function checkSenderUsable(
  sender: { senderConfigId?: string | null; fromEmail?: string | null },
  senderConfig: { status: string } | null,
): SenderUsability {
  if (sender.senderConfigId) {
    if (!senderConfig) return { valid: false, reason: 'SENDER_NOT_FOUND' };
    if (senderConfig.status !== 'verified') return { valid: false, reason: 'SENDER_NOT_VERIFIED' };
    return { valid: true };
  }
  return { valid: false, reason: 'SENDER_MISSING' };
}
