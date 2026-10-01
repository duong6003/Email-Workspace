import { Injectable } from '@nestjs/common';
import { MoreThan, type EntityManager } from 'typeorm';
import { LoginAttemptEntity } from '../database/entities/login-attempt.entity.js';

export const LOCKOUT_MAX_FAILURES = 5;
export const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;

export type LockoutState = { locked: false } | { locked: true; retryAfterSeconds: number };

/**
 * BR-AUTH-005: 5 failed attempts / 15 minutes locks the email out with a
 * sliding window; the response is 429 with Retry-After. Keyed by email
 * (not tenant) because the login request carries no tenant selector and an
 * attacker probing an unknown email must still be throttled.
 */
@Injectable()
export class LoginAttemptService {
  async record(
    manager: EntityManager,
    params: { tenantId: string | null; email: string; outcome: 'success' | 'failure'; ipHash: string | null },
  ): Promise<void> {
    await manager.getRepository(LoginAttemptEntity).save({
      tenantId: params.tenantId,
      email: params.email.toLowerCase(),
      outcome: params.outcome,
      ipHash: params.ipHash,
    });
  }

  async checkLockout(manager: EntityManager, email: string): Promise<LockoutState> {
    const windowStart = new Date(Date.now() - LOCKOUT_WINDOW_MS);
    const recentFailures = await manager.getRepository(LoginAttemptEntity).find({
      where: { email: email.toLowerCase(), outcome: 'failure', occurredAt: MoreThan(windowStart) },
      order: { occurredAt: 'ASC' },
    });

    if (recentFailures.length < LOCKOUT_MAX_FAILURES) return { locked: false };

    // Window is anchored to the failure that will next age out — the oldest
    // of the failures currently counted toward the lockout.
    const oldestCounted = recentFailures[recentFailures.length - LOCKOUT_MAX_FAILURES];
    const retryAfterMs = oldestCounted.occurredAt.getTime() + LOCKOUT_WINDOW_MS - Date.now();
    return { locked: true, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
  }
}
