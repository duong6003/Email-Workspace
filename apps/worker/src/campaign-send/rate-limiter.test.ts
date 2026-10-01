import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { checkAndIncrementRateLimit } from './rate-limiter.js';
import { testRedisUrl } from '../test-urls.js';

/**
 * M5-S3 CP5, RED first (BR-SEND-007). Real Redis, no mock: the counter
 * itself -- not the decision logic around it -- is what must be correct
 * under concurrent increments.
 */
describe('checkAndIncrementRateLimit (BR-SEND-007)', () => {
  const redis = new Redis(testRedisUrl());

  afterAll(async () => {
    await redis.quit();
  });

  it('allows submissions up to the limit within the same minute bucket, then refuses', async () => {
    const id = `sender-${randomUUID()}`;
    const now = new Date('2026-08-18T10:00:00.000Z');
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await checkAndIncrementRateLimit(redis, 'sender', id, 3, now));

    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false, false]);
  });

  it('resets in a new minute bucket', async () => {
    const id = `sender-${randomUUID()}`;
    const minuteOne = new Date('2026-08-18T10:05:00.000Z');
    const minuteTwo = new Date('2026-08-18T10:06:00.000Z');
    await checkAndIncrementRateLimit(redis, 'sender', id, 1, minuteOne);
    const secondInSameMinute = await checkAndIncrementRateLimit(redis, 'sender', id, 1, minuteOne);
    const firstInNextMinute = await checkAndIncrementRateLimit(redis, 'sender', id, 1, minuteTwo);

    expect(secondInSameMinute.allowed).toBe(false);
    expect(firstInNextMinute.allowed).toBe(true);
  });

  it('scopes independently by (scope, id) -- a tenant counter never shares a bucket with a sender counter of the same id', async () => {
    const sharedId = `shared-${randomUUID()}`;
    const now = new Date('2026-08-18T10:10:00.000Z');
    await checkAndIncrementRateLimit(redis, 'sender', sharedId, 1, now);

    const tenantResult = await checkAndIncrementRateLimit(redis, 'tenant', sharedId, 1, now);

    expect(tenantResult.allowed).toBe(true);
  });
});
