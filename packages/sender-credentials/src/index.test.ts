import { describe, expect, it } from 'vitest';
import { decryptSenderSecret, encryptSenderSecret, parseSenderCredentialKey, resolveSenderSecret } from './index.js';

describe('sender credentials', () => {
  const keyText = 'a'.repeat(64);
  const key = parseSenderCredentialKey(keyText);
  const tenantId = 'tenant-1';
  const secretRef = 'EOW_SENDER_SECRET_1';

  it('encrypts and decrypts with tenant-bound authenticated data', () => {
    const ciphertext = encryptSenderSecret(key, tenantId, secretRef, 'smtp-password');
    expect(ciphertext).not.toContain('smtp-password');
    expect(decryptSenderSecret(key, tenantId, secretRef, ciphertext)).toBe('smtp-password');
    expect(() => decryptSenderSecret(key, 'other-tenant', secretRef, ciphertext)).toThrow();
  });

  it('keeps the legacy environment reference fallback', () => {
    expect(resolveSenderSecret({ tenantId, secretRef, environment: { [secretRef]: 'legacy-secret' } })).toBe('legacy-secret');
  });

  it('rejects malformed encryption keys', () => {
    expect(() => parseSenderCredentialKey('too-short')).toThrowError(/SENDER_CREDENTIAL_KEY/);
  });
});
