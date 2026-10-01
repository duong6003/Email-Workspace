import { Injectable } from '@nestjs/common';
import { IsNull, type EntityManager } from 'typeorm';
import { UserSessionEntity } from '../database/entities/user-session.entity.js';
import { hashSessionSecret, issueSessionToken, secretMatchesHash, type SessionToken } from './session-token.js';

const SHORT_SESSION_MS = 12 * 60 * 60 * 1000; // 12h — not "remember me"
const REMEMBER_SESSION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — "remember me" checked

export type IssuedSession = {
  token: SessionToken;
  session: UserSessionEntity;
};

export type SessionValidation = { session: UserSessionEntity } | null;

@Injectable()
export class SessionService {
  /** Creates a brand-new session row (login). */
  async create(
    manager: EntityManager,
    params: { tenantId: string; userId: string; remember: boolean; userAgentHash?: string | null; ipHash?: string | null },
  ): Promise<IssuedSession> {
    const repo = manager.getRepository(UserSessionEntity);
    const saved = await repo.save({
      tenantId: params.tenantId,
      userId: params.userId,
      refreshTokenHash: 'pending', // replaced below once we know the row id
      expiresAt: new Date(Date.now() + (params.remember ? REMEMBER_SESSION_MS : SHORT_SESSION_MS)),
      userAgentHash: params.userAgentHash ?? null,
      ipHash: params.ipHash ?? null,
    });

    const token = issueSessionToken(saved.id);
    saved.refreshTokenHash = hashSessionSecret(token.secret);
    await repo.save(saved);

    return { token, session: saved };
  }

  /**
   * Validates a raw session token: looks the session up by id, confirms the
   * secret's hash matches, and that it is neither revoked nor expired.
   */
  async validate(manager: EntityManager, sessionId: string, secret: string): Promise<SessionValidation> {
    const repo = manager.getRepository(UserSessionEntity);
    const session = await repo.findOne({ where: { id: sessionId } });
    if (!session) return null;
    if (session.revokedAt) return null;
    if (session.expiresAt.getTime() < Date.now()) return null;
    if (!secretMatchesHash(secret, session.refreshTokenHash)) return null;
    return { session };
  }

  /**
   * Rotates a session: revokes the old row and issues a brand-new one linked
   * via rotated_from. The old token can never be replayed after this call —
   * BR-AUTH-002's "old refresh token cannot be reused after rotation".
   */
  async rotate(manager: EntityManager, current: UserSessionEntity, remember: boolean): Promise<IssuedSession> {
    const repo = manager.getRepository(UserSessionEntity);

    current.revokedAt = new Date();
    await repo.save(current);

    const next = await repo.save({
      tenantId: current.tenantId,
      userId: current.userId,
      refreshTokenHash: 'pending',
      expiresAt: new Date(Date.now() + (remember ? REMEMBER_SESSION_MS : SHORT_SESSION_MS)),
      rotatedFrom: current.id,
      userAgentHash: current.userAgentHash,
      ipHash: current.ipHash,
    });

    const token = issueSessionToken(next.id);
    next.refreshTokenHash = hashSessionSecret(token.secret);
    await repo.save(next);

    return { token, session: next };
  }

  /** Revokes a single session (logout). Idempotent. */
  async revoke(manager: EntityManager, sessionId: string): Promise<void> {
    await manager.getRepository(UserSessionEntity).update({ id: sessionId, revokedAt: IsNull() }, { revokedAt: new Date() });
  }

  /** Revokes every active session for a user (password change) — BR-AUTH-006. */
  async revokeAllForUser(manager: EntityManager, userId: string): Promise<void> {
    await manager.getRepository(UserSessionEntity).update({ userId, revokedAt: IsNull() }, { revokedAt: new Date() });
  }
}
