export type ProviderErrorClass = 'permanent' | 'transient' | 'auth' | 'config';
export type ProviderProbeResult = { ok: true } | { ok: false; code: string; classification: ProviderErrorClass; reason: string | null };
export type ProviderSendResult = { providerMessageId: string };
/**
 * M5-S4 CP4 (D-106). A structural widening, not an extension of the
 * previous `{ type: string; providerMessageId?: string; occurredAt?: Date }`
 * shape -- that shape let an adapter's parseWebhookEvent() spread an
 * unvalidated, attacker-controlled payload straight through with an `as`
 * cast. Every field here is deliberately nullable rather than optional: a
 * parser that cannot find a field returns `null` for it, never `undefined`
 * (which would be indistinguishable from "the caller didn't check").
 */
export type ProviderWebhookEvent = {
  eventId: string | null;
  type: 'delivered' | 'bounced' | 'complaint' | 'deferred' | 'unknown';
  providerMessageId: string | null;
  occurredAt: Date | null;
};
export type SenderConnectionConfig = { host: string; port: number; username: string; secret: string; fromEmail: string };
export interface EmailProviderAdapter {
  testConnection(config: SenderConnectionConfig): Promise<ProviderProbeResult>;
  send(message: unknown): Promise<ProviderSendResult>;
  classifyError(error: unknown): ProviderErrorClass;
  parseWebhookEvent(payload: unknown): ProviderWebhookEvent;
}
