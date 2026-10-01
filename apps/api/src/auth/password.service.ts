import { randomBytes } from 'node:crypto';
import { argon2id, argon2Verify } from 'hash-wasm';

/**
 * argon2id password hashing (BR-AUTH-001/BR-SEC-*). Pure-WASM implementation
 * (hash-wasm) rather than a native `argon2` binding: it needs no node-gyp
 * toolchain, so it installs identically on every contributor/CI platform.
 */
const ARGON2ID_PARAMS = {
  parallelism: 1,
  iterations: 3,
  memorySize: 19456, // ~19 MiB, OWASP-recommended floor for argon2id
  hashLength: 32,
} as const;

export async function hashPassword(plainPassword: string): Promise<string> {
  const salt = randomBytes(16);
  return argon2id({
    password: plainPassword,
    salt,
    ...ARGON2ID_PARAMS,
    outputType: 'encoded',
  });
}

export async function verifyPassword(hash: string, plainPassword: string): Promise<boolean> {
  try {
    return await argon2Verify({ password: plainPassword, hash });
  } catch {
    // Malformed/foreign hash format — treat as a verification failure, never throw.
    return false;
  }
}
