import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomBytes, createHash } from 'node:crypto';
import type { DataSource, EntityManager } from 'typeorm';
import { AppUserEntity } from '../database/entities/app-user.entity.js';
import { PasswordResetTokenEntity } from '../database/entities/password-reset-token.entity.js';
import { appendAuditLog } from '../common/audit-writer.js';
import { hashIdentifier } from './ip-hash.js';
import { LoginAttemptService } from './login-attempt.service.js';
import { hashPassword, verifyPassword } from './password.service.js';
import { SessionService, type IssuedSession } from './session.service.js';
import type { ValidatedEnv } from '../config/env.js';
import { setTenantContext } from '../database/tenant-transaction.js';

export type LoginOutcome =
  | { ok: true; issued: IssuedSession; user: AppUserEntity }
  | { ok: false; reason: 'locked'; retryAfterSeconds: number }
  | { ok: false; reason: 'invalid' };

export type RequestMeta = { ip: string | null; userAgent: string | null; traceId: string };

const RESET_TOKEN_TTL_MS = 30 * 60 * 1000; // BR-AUTH-006: 30 minutes

@Injectable()
export class AuthService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly sessions: SessionService,
    private readonly loginAttempts: LoginAttemptService,
    private readonly config: ConfigService<ValidatedEnv, true>,
  ) {}

  private hashed(value: string | null): string | null {
    return hashIdentifier(this.config.get('SESSION_SECRET', { infer: true }), value);
  }

  async login(email: string, password: string, remember: boolean, meta: RequestMeta): Promise<LoginOutcome> {
    const normalizedEmail = email.trim().toLowerCase();
    const ipHash = this.hashed(meta.ip);
    const userAgentHash = this.hashed(meta.userAgent);

    return this.dataSource.transaction(async (manager) => {
      const lockout = await this.loginAttempts.checkLockout(manager, normalizedEmail);
      if (lockout.locked) {
        return { ok: false, reason: 'locked', retryAfterSeconds: lockout.retryAfterSeconds } as const;
      }

      // Email is only unique per-tenant (UNIQUE(tenant_id, email)), so a
      // login-by-email-only request may match more than one tenant's user in
      // theory. Take the first match — resolving which tenant a given
      // operator belongs to ahead of login (e.g. a subdomain or org picker)
      // is out of this slice's scope; see EXECPLAN Decision Log.
      const user = await manager.getRepository(AppUserEntity).findOne({ where: { email: normalizedEmail } });
      if (user) await setTenantContext(manager, user.tenantId);

      if (!user || !user.passwordHash || user.status !== 'active') {
        await this.loginAttempts.record(manager, { tenantId: user?.tenantId ?? null, email: normalizedEmail, outcome: 'failure', ipHash });
        if (user) {
          await appendAuditLog(manager, {
            tenantId: user.tenantId,
            actorId: null,
            action: 'auth.login_failed',
            entityType: 'app_user',
            entityId: user.id,
            traceId: meta.traceId,
            metadata: { reason: user.status !== 'active' ? 'inactive' : 'no_password_set' },
          });
        }
        return { ok: false, reason: 'invalid' } as const;
      }

      const passwordOk = await verifyPassword(user.passwordHash, password);
      if (!passwordOk) {
        await this.loginAttempts.record(manager, { tenantId: user.tenantId, email: normalizedEmail, outcome: 'failure', ipHash });
        await appendAuditLog(manager, {
          tenantId: user.tenantId,
          actorId: user.id,
          action: 'auth.login_failed',
          entityType: 'app_user',
          entityId: user.id,
          traceId: meta.traceId,
          metadata: { reason: 'bad_password' },
        });

        // Recheck: this failure may itself be the 5th within the window —
        // surface the lock immediately rather than making the caller retry
        // once more to discover it.
        const postFailureLockout = await this.loginAttempts.checkLockout(manager, normalizedEmail);
        if (postFailureLockout.locked) {
          await appendAuditLog(manager, {
            tenantId: user.tenantId,
            actorId: user.id,
            action: 'auth.locked',
            entityType: 'app_user',
            entityId: user.id,
            traceId: meta.traceId,
            metadata: {},
          });
          return { ok: false, reason: 'locked', retryAfterSeconds: postFailureLockout.retryAfterSeconds } as const;
        }
        return { ok: false, reason: 'invalid' } as const;
      }

      await this.loginAttempts.record(manager, { tenantId: user.tenantId, email: normalizedEmail, outcome: 'success', ipHash });

      const issued = await this.sessions.create(manager, {
        tenantId: user.tenantId,
        userId: user.id,
        remember,
        userAgentHash,
        ipHash,
      });

      user.lastLoginAt = new Date();
      await manager.getRepository(AppUserEntity).save(user);

      await appendAuditLog(manager, {
        tenantId: user.tenantId,
        actorId: user.id,
        action: 'auth.login',
        entityType: 'app_user',
        entityId: user.id,
        traceId: meta.traceId,
        metadata: {},
      });

      return { ok: true, issued, user } as const;
    });
  }

  /**
   * Rotation itself is audited declaratively by AuditInterceptor
   * (auth.controller.ts's @AuditLog on this route) rather than here — see
   * audit-log.decorator.ts's doc comment for why this single-outcome action
   * (unlike login's branchy outcomes) is a good fit for that mechanism.
   */
  async refresh(sessionId: string, secret: string, remember: boolean): Promise<IssuedSession | null> {
    return this.dataSource.transaction(async (manager) => {
      const validation = await this.sessions.validate(manager, sessionId, secret);
      if (!validation) return null;

      return this.sessions.rotate(manager, validation.session, remember);
    });
  }

  /** Audited declaratively by AuditInterceptor — see refresh() above. */
  async logout(sessionId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await this.sessions.revoke(manager, sessionId);
    });
  }

  async me(userId: string): Promise<AppUserEntity | null> {
    return this.dataSource.transaction(async (manager) => {
      const user = await manager.getRepository(AppUserEntity).findOne({ where: { id: userId } });
      if (user) await setTenantContext(manager, user.tenantId);
      return user;
    });
  }

  /**
   * Always resolves the same way regardless of whether the email is
   * registered (BR-AUTH-001's account-enumeration protection extends to
   * password recovery). Silently no-ops the token creation for an unknown
   * email.
   */
  async forgotPassword(email: string, traceId: string): Promise<void> {
    const normalizedEmail = email.trim().toLowerCase();
    await this.dataSource.transaction(async (manager) => {
      const user = await manager.getRepository(AppUserEntity).findOne({ where: { email: normalizedEmail } });
      if (!user) return;
      await setTenantContext(manager, user.tenantId);

      const rawToken = randomBytes(32).toString('base64url');
      const tokenHash = createHash('sha256').update(rawToken).digest('hex');
      await manager.getRepository(PasswordResetTokenEntity).save({
        tenantId: user.tenantId,
        userId: user.id,
        tokenHash,
        expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
      });

      await appendAuditLog(manager, {
        tenantId: user.tenantId,
        actorId: user.id,
        action: 'auth.password_reset_requested',
        entityType: 'app_user',
        entityId: user.id,
        traceId,
        metadata: {},
      });
      // Dispatching the actual recovery email is out of this slice's scope
      // (no transactional-email module exists yet); the token is persisted
      // and independently testable via resetPassword().
    });
  }

  async resetPassword(rawToken: string, newPassword: string, traceId: string): Promise<{ ok: true } | { ok: false; reason: 'invalid_or_expired' }> {
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');

    return this.dataSource.transaction(async (manager) => {
      const tokenRow = await manager.getRepository(PasswordResetTokenEntity).findOne({ where: { tokenHash } });
      if (!tokenRow || tokenRow.usedAt || tokenRow.expiresAt.getTime() < Date.now()) {
        return { ok: false, reason: 'invalid_or_expired' } as const;
      }

      const user = await manager.getRepository(AppUserEntity).findOne({ where: { id: tokenRow.userId } });
      if (!user) return { ok: false, reason: 'invalid_or_expired' } as const;
      await setTenantContext(manager, user.tenantId);

      user.passwordHash = await hashPassword(newPassword);
      await manager.getRepository(AppUserEntity).save(user);

      tokenRow.usedAt = new Date();
      await manager.getRepository(PasswordResetTokenEntity).save(tokenRow);

      await this.sessions.revokeAllForUser(manager, user.id);

      await appendAuditLog(manager, {
        tenantId: user.tenantId,
        actorId: user.id,
        action: 'auth.password_reset',
        entityType: 'app_user',
        entityId: user.id,
        traceId,
        metadata: {},
      });

      return { ok: true } as const;
    });
  }

  /** Exposed for tests/fixtures that need to seed a user with a real hash. */
  hashPasswordForFixture(plain: string): Promise<string> {
    return hashPassword(plain);
  }

  withManager<T>(fn: (manager: EntityManager) => Promise<T>): Promise<T> {
    return fn(this.dataSource.manager);
  }
}
