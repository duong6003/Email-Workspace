import type { EmailProviderAdapter, SenderConnectionConfig } from './provider-adapter.js';
export class FakeProviderAdapter implements EmailProviderAdapter {
  async testConnection(_config: SenderConnectionConfig) { return { ok: true as const }; }
  async send(_message: unknown) { return { providerMessageId: 'fake-message' }; }
  classifyError(error: unknown) { return String((error as { code?: unknown })?.code) === 'EAUTH' ? 'auth' as const : 'transient' as const; }
  parseWebhookEvent(_payload: unknown) { return { eventId: null, type: 'delivered' as const, providerMessageId: null, occurredAt: null }; }
}
