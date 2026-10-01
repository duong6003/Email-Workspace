import { describe, expect, it } from 'vitest';
import { maskSecretReference } from './secret-store.js';
import { FakeProviderAdapter } from './fake-provider.adapter.js';
import { validateReply } from './sender-config.service.js';

describe('sender configuration security boundaries (BR-CFG-001/005)', () => {
  it('masks secret references and never exposes plaintext', () => {
    const secret = 'smtp-password-never-returned';
    const serialized = JSON.stringify({ secretRef: maskSecretReference('EOW_SENDER_SECRET_ABC123'), metadata: { status: 'pending' } });
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain('••••');
  });
  it('supports the common adapter contract with a second fake implementation', async () => {
    const adapter = new FakeProviderAdapter();
    expect(await adapter.testConnection({} as never)).toEqual({ ok: true });
    expect(await adapter.send({})).toEqual({ providerMessageId: 'fake-message' });
    expect(adapter.classifyError({ code: 'EAUTH' })).toBe('auth');
    // M5-S4 CP4 (D-106): ProviderWebhookEvent widened from `{type}` to the
    // full `{eventId, type, providerMessageId, occurredAt}` shape -- this
    // assertion updates to the new shape, the same fixture-correction
    // discipline M5-S3's D-89 established (AGENTS.md SS5).
    expect(adapter.parseWebhookEvent({})).toEqual({ eventId: null, type: 'delivered', providerMessageId: null, occurredAt: null });
  });
  it('rejects spoofed From/invalid Reply-To and accepts a distinct valid Reply-To', () => {
    expect(() => validateReply('not-an-email')).toThrow();
    expect(() => validateReply('from@example.test', 'bad')).toThrow();
    expect(() => validateReply('from@example.test', 'reply@example.test')).not.toThrow();
  });
});
