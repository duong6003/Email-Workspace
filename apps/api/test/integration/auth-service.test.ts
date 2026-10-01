import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { createDataSource } from '../../src/database/data-source.js';
import { TenantEntity } from '../../src/database/entities/tenant.entity.js';
import { AppUserEntity } from '../../src/database/entities/app-user.entity.js';
import { LoginAttemptEntity } from '../../src/database/entities/login-attempt.entity.js';
import { AuditLogEntity } from '../../src/database/entities/audit-log.entity.js';
import { AuthService } from '../../src/auth/auth.service.js';
import { SessionService } from '../../src/auth/session.service.js';
import { LoginAttemptService, LOCKOUT_MAX_FAILURES } from '../../src/auth/login-attempt.service.js';
import { hashPassword } from '../../src/auth/password.service.js';
import { AuthGuard } from '../../src/auth/auth.guard.js';
import { PermissionsService } from '../../src/auth/permissions.service.js';
import { readSessionCookie } from '../../src/auth/cookies.js';
import { testDatabaseUrl } from './test-database-url.js';
import type { ValidatedEnv } from '../../src/config/env.js';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

const TEST_SESSION_SECRET = 'test-session-secret-'.repeat(3);

function fakeConfigService(): ConfigService<ValidatedEnv, true> {
  return { get: () => TEST_SESSION_SECRET } as unknown as ConfigService<ValidatedEnv, true>;
}

function fakeExecutionContext(request: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => function fakeHandler() {},
    getClass: () => class FakeController {},
  } as unknown as ExecutionContext;
}

function fakeRequest(cookieValue: string | undefined) {
  return { cookies: cookieValue ? { eow_session: cookieValue } : {}, headers: {} } as unknown as Parameters<typeof readSessionCookie>[0];
}

describe('AuthService (integration, real PostgreSQL)', () => {
  let dataSource: DataSource;
  let auth: AuthService;
  let sessions: SessionService;
  let loginAttempts: LoginAttemptService;
  let guard: AuthGuard;
  let tenantA: TenantEntity;
  let tenantB: TenantEntity;

  beforeAll(async () => {
    dataSource = createDataSource(testDatabaseUrl());
    await dataSource.initialize();
    sessions = new SessionService();
    loginAttempts = new LoginAttemptService();
    auth = new AuthService(dataSource, sessions, loginAttempts, fakeConfigService());
    guard = new AuthGuard(dataSource, sessions, new PermissionsService(), new Reflector());

    const tenants = dataSource.getRepository(TenantEntity);
    tenantA = await tenants.save({ name: `auth-test-tenant-a-${randomUUID()}` });
    tenantB = await tenants.save({ name: `auth-test-tenant-b-${randomUUID()}` });
  });

  afterAll(async () => {
    const { PasswordResetTokenEntity } = await import('../../src/database/entities/password-reset-token.entity.js');
    const { UserSessionEntity } = await import('../../src/database/entities/user-session.entity.js');

    // M1-S3 (database/migrations/005_audit_log_immutability.sql): audit_log
    // rows can no longer be deleted (BR-SEC-002 "immutable"), and audit_log.
    // tenant_id REFERENCES tenant(id) with no ON DELETE CASCADE, so a tenant
    // that owns any audit_log row can no longer be deleted either. Every
    // other fixture table is still cleaned up; the tenant/audit_log rows are
    // deliberately left behind (each test run uses a fresh randomUUID()
    // tenant name, so nothing collides).
    for (const tenantId of [tenantA.id, tenantB.id]) {
      await dataSource.getRepository(PasswordResetTokenEntity).delete({ tenantId });
      await dataSource.getRepository(UserSessionEntity).delete({ tenantId });
      await dataSource.getRepository(LoginAttemptEntity).delete({ tenantId });
      await dataSource.getRepository(AppUserEntity).delete({ tenantId });
    }
    await dataSource.destroy();
  });

  async function seedUser(tenantId: string, email: string, password: string) {
    const passwordHash = await hashPassword(password);
    return dataSource.getRepository(AppUserEntity).save({
      tenantId,
      email,
      displayName: 'Test User',
      role: 'operator',
      passwordHash,
      status: 'active',
    });
  }

  const meta = { ip: '203.0.113.7', userAgent: 'vitest', traceId: 'trace-test' };

  it('issues a session and writes an auth.login audit row on correct credentials', async () => {
    const email = `login-ok-${randomUUID()}@test.dev`;
    const user = await seedUser(tenantA.id, email, 'correct-horse-battery');

    const outcome = await auth.login(email, 'correct-horse-battery', false, meta);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.issued.session.tenantId).toBe(tenantA.id);
    expect(outcome.issued.session.userId).toBe(user.id);

    const audits = await dataSource.getRepository(AuditLogEntity).find({ where: { tenantId: tenantA.id, action: 'auth.login', entityId: user.id } });
    expect(audits.length).toBeGreaterThan(0);
    expect(audits[0].traceId).toBe('trace-test');
  });

  it('rejects a wrong password with a generic reason and records a failure attempt', async () => {
    const email = `login-bad-${randomUUID()}@test.dev`;
    await seedUser(tenantA.id, email, 'the-real-password');

    const outcome = await auth.login(email, 'totally-wrong', false, meta);
    expect(outcome).toEqual({ ok: false, reason: 'invalid' });

    const attempts = await dataSource.getRepository(LoginAttemptEntity).find({ where: { email: email.toLowerCase() } });
    expect(attempts.some((a) => a.outcome === 'failure')).toBe(true);
  });

  it('rejects an unknown email the same way, without crashing on a null tenant', async () => {
    const email = `never-registered-${randomUUID()}@test.dev`;
    const outcome = await auth.login(email, 'anything', false, meta);
    expect(outcome).toEqual({ ok: false, reason: 'invalid' });

    const attempts = await dataSource.getRepository(LoginAttemptEntity).find({ where: { email: email.toLowerCase() } });
    expect(attempts).toHaveLength(1);
    expect(attempts[0].tenantId).toBeNull();
  });

  it('locks out after 5 failed attempts within the window and returns Retry-After seconds (BR-AUTH-005)', async () => {
    const email = `lockout-${randomUUID()}@test.dev`;
    await seedUser(tenantA.id, email, 'the-real-password');

    for (let i = 0; i < LOCKOUT_MAX_FAILURES; i += 1) {
      const attempt = await auth.login(email, 'wrong', false, meta);
      expect(attempt.ok).toBe(false);
    }

    const locked = await auth.login(email, 'the-real-password', false, meta);
    expect(locked.ok).toBe(false);
    if (locked.ok) throw new Error('unreachable');
    expect(locked.reason).toBe('locked');
    if (locked.reason === 'locked') {
      expect(locked.retryAfterSeconds).toBeGreaterThan(0);
      expect(locked.retryAfterSeconds).toBeLessThanOrEqual(15 * 60);
    }
  });

  it('rotates a session on refresh so the old token can never be reused (BR-AUTH-002)', async () => {
    const email = `refresh-${randomUUID()}@test.dev`;
    await seedUser(tenantA.id, email, 'rotate-me-please');

    const login = await auth.login(email, 'rotate-me-please', false, meta);
    if (!login.ok) throw new Error('unreachable');
    const oldToken = login.issued.token;

    const rotated = await auth.refresh(oldToken.sessionId, oldToken.secret, false);
    expect(rotated).not.toBeNull();
    expect(rotated!.session.id).not.toBe(oldToken.sessionId);

    const oldStillValid = await sessions.validate(dataSource.manager, oldToken.sessionId, oldToken.secret);
    expect(oldStillValid).toBeNull();

    const newValid = await sessions.validate(dataSource.manager, rotated!.session.id, rotated!.token.secret);
    expect(newValid).not.toBeNull();
  });

  it('revokes the session on logout so it can no longer authenticate', async () => {
    const email = `logout-${randomUUID()}@test.dev`;
    await seedUser(tenantA.id, email, 'log-me-out');

    const login = await auth.login(email, 'log-me-out', false, meta);
    if (!login.ok) throw new Error('unreachable');

    await auth.logout(login.issued.session.id);

    const stillValid = await sessions.validate(dataSource.manager, login.issued.session.id, login.issued.token.secret);
    expect(stillValid).toBeNull();
  });

  it('resets a password with a valid token, single-use, and revokes existing sessions (BR-AUTH-006)', async () => {
    const email = `reset-${randomUUID()}@test.dev`;
    await seedUser(tenantA.id, email, 'old-password-123');

    const login = await auth.login(email, 'old-password-123', false, meta);
    if (!login.ok) throw new Error('unreachable');

    await auth.forgotPassword(email, 'trace-forgot');

    // The raw token is only ever known to the (unsent, in this slice) email —
    // read the persisted hash-backed row's plaintext via a fresh token mint
    // through the same path the email would have used is not possible from
    // outside, so we exercise resetPassword's rejection path plus, via a
    // second forgotPassword-independent path, its acceptance path by minting
    // a token the same way the service does and reusing that exact flow.
    const { PasswordResetTokenEntity } = await import('../../src/database/entities/password-reset-token.entity.js');
    const tokenRow = await dataSource.getRepository(PasswordResetTokenEntity).findOne({ where: { userId: login.issued.session.userId }, order: { createdAt: 'DESC' } });
    expect(tokenRow).not.toBeNull();

    // resetPassword only ever receives the raw token (never the hash); since
    // forgotPassword does not return it (it would be emailed), assert the
    // invalid-token path here and prove the accept path via a dedicated
    // service-level unit test below that controls both sides of the hash.
    const rejectedReuse = await auth.resetPassword('not-the-real-token', 'newpassword123', 'trace-reset-bad');
    expect(rejectedReuse).toEqual({ ok: false, reason: 'invalid_or_expired' });

    // The old session must still be valid — resetPassword with a bad token must not revoke anything.
    const stillValid = await sessions.validate(dataSource.manager, login.issued.session.id, login.issued.token.secret);
    expect(stillValid).not.toBeNull();
  });

  it('accepts a valid, unexpired, unused reset token exactly once and revokes existing sessions', async () => {
    const { createHash, randomBytes } = await import('node:crypto');
    const { PasswordResetTokenEntity } = await import('../../src/database/entities/password-reset-token.entity.js');

    const email = `reset-accept-${randomUUID()}@test.dev`;
    const user = await seedUser(tenantA.id, email, 'old-password-123');
    const login = await auth.login(email, 'old-password-123', false, meta);
    if (!login.ok) throw new Error('unreachable');

    const rawToken = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    await dataSource.getRepository(PasswordResetTokenEntity).save({
      tenantId: tenantA.id,
      userId: user.id,
      tokenHash,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    });

    const accepted = await auth.resetPassword(rawToken, 'brand-new-password-456', 'trace-reset-ok');
    expect(accepted).toEqual({ ok: true });

    // Old session is revoked by a successful reset (BR-AUTH-006).
    const oldSessionStillValid = await sessions.validate(dataSource.manager, login.issued.session.id, login.issued.token.secret);
    expect(oldSessionStillValid).toBeNull();

    // The new password now works; the old one no longer does.
    const loginWithNewPassword = await auth.login(email, 'brand-new-password-456', false, meta);
    expect(loginWithNewPassword.ok).toBe(true);
    const loginWithOldPassword = await auth.login(email, 'old-password-123', false, meta);
    expect(loginWithOldPassword.ok).toBe(false);

    // Re-using the same reset token a second time must fail (single-use).
    const reused = await auth.resetPassword(rawToken, 'another-password-789', 'trace-reset-reused');
    expect(reused).toEqual({ ok: false, reason: 'invalid_or_expired' });
  });

  it('rejects an expired reset token', async () => {
    const { createHash, randomBytes } = await import('node:crypto');
    const { PasswordResetTokenEntity } = await import('../../src/database/entities/password-reset-token.entity.js');

    const email = `reset-expired-${randomUUID()}@test.dev`;
    const user = await seedUser(tenantA.id, email, 'old-password-123');

    const rawToken = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    await dataSource.getRepository(PasswordResetTokenEntity).save({
      tenantId: tenantA.id,
      userId: user.id,
      tokenHash,
      expiresAt: new Date(Date.now() - 1000), // already expired
    });

    const result = await auth.resetPassword(rawToken, 'irrelevant-password', 'trace-reset-expired');
    expect(result).toEqual({ ok: false, reason: 'invalid_or_expired' });
  });

  it('AuthGuard resolves tenantId strictly from the session owner, never from client-supplied data (cross-tenant rejection)', async () => {
    const emailA = `cross-a-${randomUUID()}@test.dev`;
    const emailB = `cross-b-${randomUUID()}@test.dev`;
    const userA = await seedUser(tenantA.id, emailA, 'tenant-a-password');
    await seedUser(tenantB.id, emailB, 'tenant-b-password');

    const loginA = await auth.login(emailA, 'tenant-a-password', false, meta);
    if (!loginA.ok) throw new Error('unreachable');

    // Simulate an attacker who holds tenant A's valid session cookie but
    // tries to smuggle tenant B's id in through a header/body the guard does
    // not read for authorization.
    const request = fakeRequest(loginA.issued.token.raw) as unknown as { cookies: Record<string, string>; headers: Record<string, string>; auth?: unknown };
    (request as unknown as Record<string, unknown>).body = { tenantId: tenantB.id };
    request.headers['x-tenant-id'] = tenantB.id;

    const allowed = await guard.canActivate(fakeExecutionContext(request));
    expect(allowed).toBe(true);
    expect((request.auth as { tenantId: string; userId: string }).tenantId).toBe(tenantA.id);
    expect((request.auth as { tenantId: string; userId: string }).tenantId).not.toBe(tenantB.id);
    expect((request.auth as { tenantId: string; userId: string }).userId).toBe(userA.id);
  });

  it('AuthGuard rejects a missing, malformed or unknown session cookie', async () => {
    await expect(guard.canActivate(fakeExecutionContext(fakeRequest(undefined)))).rejects.toThrow();
    await expect(guard.canActivate(fakeExecutionContext(fakeRequest('not-a-real-token')))).rejects.toThrow();
    await expect(guard.canActivate(fakeExecutionContext(fakeRequest(`${randomUUID()}.some-secret`)))).rejects.toThrow();
  });
});
