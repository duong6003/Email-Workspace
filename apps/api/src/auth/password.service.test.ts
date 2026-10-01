import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password.service.js';

describe('password.service', () => {
  it('hashes with an argon2id-tagged, salted encoding', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash).toMatch(/^\$argon2id\$/);
  });

  it('produces a different hash for the same password each time (random salt)', async () => {
    const [a, b] = await Promise.all([hashPassword('same-password'), hashPassword('same-password')]);
    expect(a).not.toBe(b);
  });

  it('verifies the correct password against its hash', async () => {
    const hash = await hashPassword('S3cure!Passw0rd');
    await expect(verifyPassword(hash, 'S3cure!Passw0rd')).resolves.toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await hashPassword('S3cure!Passw0rd');
    await expect(verifyPassword(hash, 'wrong-password')).resolves.toBe(false);
  });

  it('never throws on a malformed/foreign hash — treats it as a verification failure', async () => {
    await expect(verifyPassword('not-a-real-hash', 'anything')).resolves.toBe(false);
  });
});
