/**
 * BR-SEND-002's message-transition table only (worker-native duplicate of
 * apps/api/src/campaigns/send-state-machine.ts's MessageStatus/
 * isLegalMessageTransition -- the campaign-execution-transition half of
 * that file is API-only and not needed here). Neither app can import the
 * other's source (rootDir: "src", no shared workspace package).
 */
export type MessageStatus = 'pending' | 'queued' | 'submitted' | 'delivered' | 'bounced' | 'failed' | 'skipped' | 'cancelled';

const LEGAL_MESSAGE_EDGES: ReadonlySet<string> = new Set([
  'pending->queued',
  'pending->cancelled',
  'queued->submitted',
  'queued->failed',
  'submitted->delivered',
  'submitted->bounced',
]);

export function isLegalMessageTransition(from: MessageStatus, to: MessageStatus): boolean {
  return LEGAL_MESSAGE_EDGES.has(`${from}->${to}`);
}
