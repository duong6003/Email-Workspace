import { describe, expect, it } from 'vitest';
import { hashPayload } from './idempotency.service.js';

describe('hashPayload', () => {
  it('is stable for the same payload', () => {
    expect(hashPayload({ a: 1, b: 'x' })).toBe(hashPayload({ a: 1, b: 'x' }));
  });

  it('is stable when object keys arrive in a different order', () => {
    expect(hashPayload({ mapping: { email: 'Email', firstName: 'First name' }, rows: [{ email: 'a@example.test', firstName: 'A' }] })).toBe(
      hashPayload({ rows: [{ firstName: 'A', email: 'a@example.test' }], mapping: { firstName: 'First name', email: 'Email' } }),
    );
  });

  it('differs for a different payload', () => {
    expect(hashPayload({ a: 1 })).not.toBe(hashPayload({ a: 2 }));
  });

  it('treats undefined and no-payload the same as null', () => {
    expect(hashPayload(undefined)).toBe(hashPayload(null));
  });
});
