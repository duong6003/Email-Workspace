import type { Redis } from 'ioredis';

export type RateLimitScope = 'sender' | 'tenant';
export type RateLimitCheck = { allowed: boolean };

/**
 * BR-SEND-007. A shared counter across replicas (Redis, not in-process
 * memory) is the only correct place for a limit that must hold across them.
 * The key expires after 120s (two buckets) so a crashed/idle counter never
 * lingers; DEC-103's "fail closed" for Redis unavailability is the caller's
 * responsibility (a rejected promise here, not a value this function
 * returns), since only the caller knows whether "unavailable" should stop
 * the whole batch.
 */
export async function checkAndIncrementRateLimit(
  redis: Redis,
  scope: RateLimitScope,
  id: string,
  limit: number,
  now: Date = new Date(),
): Promise<RateLimitCheck> {
  const minuteBucket = Math.floor(now.getTime() / 60_000);
  const key = `eow:rate:${scope}:${id}:${minuteBucket}`;
  const used = await redis.incr(key);
  if (used === 1) await redis.expire(key, 120);
  return { allowed: used <= limit };
}
