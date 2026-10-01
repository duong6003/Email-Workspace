import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { HttpExceptionFilter } from '../../src/common/http-exception.filter.js';
import { TenantEntity } from '../../src/database/entities/tenant.entity.js';
import { AppUserEntity } from '../../src/database/entities/app-user.entity.js';
import { UserSessionEntity } from '../../src/database/entities/user-session.entity.js';
import { LoginAttemptEntity } from '../../src/database/entities/login-attempt.entity.js';
import { AuditLogEntity } from '../../src/database/entities/audit-log.entity.js';
import { hashPassword } from '../../src/auth/password.service.js';
import { testDatabaseUrl } from './test-database-url.js';
import { testRedisUrl } from './test-redis-url.js';

// AppModule's @Module({ imports: [ConfigModule.forRoot({ validate })] })
// decorator runs env validation at class-definition time, i.e. at import
// time — so process.env must be populated *before* app.module.js is ever
// imported. A dynamic import() inside beforeAll (after the env is set)
// achieves that; a static top-level import would evaluate too early and
// always throw "DATABASE_URL: ... undefined" regardless of what beforeAll does.

/**
 * End-to-end HTTP proof of M1-S1's headline success condition: a real user
 * signs in against PostgreSQL through the actual Nest HTTP stack and
 * receives a Secure/HttpOnly/SameSite=Lax session cookie — not just a
 * service-level assertion.
 */
describe('Auth HTTP (integration, real PostgreSQL, real Nest app)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let tenant: TenantEntity;
  const email = `http-login-${randomUUID()}@test.dev`;
  const password = 'correct-horse-battery-staple';

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl();
    process.env.REDIS_URL = testRedisUrl();
    process.env.SESSION_SECRET = 'a'.repeat(64);
    process.env.WEB_ORIGIN = 'http://localhost:5173';

    const { AppModule } = await import('../../src/app.module.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();

    dataSource = moduleRef.get(getDataSourceToken());
    const tenants = dataSource.getRepository(TenantEntity);
    tenant = await tenants.save({ name: `http-auth-tenant-${randomUUID()}` });
    await dataSource.getRepository(AppUserEntity).save({
      tenantId: tenant.id,
      email,
      displayName: 'HTTP Test User',
      role: 'operator',
      passwordHash: await hashPassword(password),
      status: 'active',
    });
  });

  afterAll(async () => {
    // M1-S3: audit_log is now immutable (005_audit_log_immutability.sql) and
    // audit_log.tenant_id has no ON DELETE CASCADE, so a tenant that owns an
    // audit_log row can no longer be deleted either — see the matching
    // comment in auth-service.test.ts's afterAll for the full rationale.
    await dataSource.getRepository(UserSessionEntity).delete({ tenantId: tenant.id });
    await dataSource.getRepository(LoginAttemptEntity).delete({ tenantId: tenant.id });
    await dataSource.getRepository(AppUserEntity).delete({ tenantId: tenant.id });
    await app.close();
  });

  it('rejects invalid credentials with a generic 401 problem response', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: 'wrong-password' });

    expect(response.status).toBe(401);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.body.detail).not.toMatch(/wrong-password|does not exist|no such user/i);
  });

  it('logs in, sets a Secure HttpOnly SameSite=Lax session cookie, and lands an authenticated /auth/me', async () => {
    const loginResponse = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password, remember: true });

    expect(loginResponse.status).toBe(204);
    const setCookieHeader = loginResponse.headers['set-cookie'] as unknown as string[];
    expect(setCookieHeader).toBeDefined();
    const sessionCookieLine = setCookieHeader.find((c) => c.startsWith('eow_session='));
    expect(sessionCookieLine).toBeDefined();
    expect(sessionCookieLine).toMatch(/HttpOnly/i);
    expect(sessionCookieLine).toMatch(/SameSite=Lax/i);

    const csrfCookieLine = setCookieHeader.find((c) => c.startsWith('eow_csrf='));
    expect(csrfCookieLine).toBeDefined();
    expect(csrfCookieLine).not.toMatch(/HttpOnly/i); // must be JS-readable for double-submit

    const cookieHeader = setCookieHeader.map((c) => c.split(';')[0]).join('; ');
    const meResponse = await request(app.getHttpServer()).get('/api/v1/auth/me').set('Cookie', cookieHeader);

    expect(meResponse.status).toBe(200);
    expect(meResponse.body.email).toBe(email);
    expect(meResponse.body.tenantId).toBe(tenant.id);
  });

  it('rejects /auth/me without a session cookie', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/auth/me');
    expect(response.status).toBe(401);
  });

  it('logs out and revokes the cookie so it can no longer authenticate, and rejects logout without a matching CSRF header', async () => {
    const loginResponse = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password });
    const setCookieHeader = loginResponse.headers['set-cookie'] as unknown as string[];
    const cookieHeader = setCookieHeader.map((c) => c.split(';')[0]).join('; ');
    const csrfToken = setCookieHeader.find((c) => c.startsWith('eow_csrf='))!.split(';')[0].split('=')[1];

    const meBeforeLogout = await request(app.getHttpServer()).get('/api/v1/auth/me').set('Cookie', cookieHeader);
    const sessionOwnerId: string = meBeforeLogout.body.id;

    const logoutWithoutCsrf = await request(app.getHttpServer()).post('/api/v1/auth/logout').set('Cookie', cookieHeader);
    expect(logoutWithoutCsrf.status).toBe(403);

    const logoutWithCsrf = await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Cookie', cookieHeader)
      .set('x-csrf-token', csrfToken);
    expect(logoutWithCsrf.status).toBe(204);

    const meAfterLogout = await request(app.getHttpServer()).get('/api/v1/auth/me').set('Cookie', cookieHeader);
    expect(meAfterLogout.status).toBe(401);

    // M1-S3: logout is no longer hand-audited inside AuthService — it is
    // audited declaratively by the global AuditInterceptor reading
    // AuthController's @AuditLog(...) decorator. Proves the convention-based
    // mechanism actually fires end-to-end through the real HTTP stack.
    const logoutAudit = await dataSource.getRepository(AuditLogEntity).findOne({
      where: { tenantId: tenant.id, actorId: sessionOwnerId, action: 'auth.logout' },
      order: { occurredAt: 'DESC' },
    });
    expect(logoutAudit).not.toBeNull();
    expect(logoutAudit!.entityType).toBe('user_session');
    expect(logoutAudit!.entityId).not.toBeNull();
  });

  it('propagates the SAME traceId into the Problem response and the corresponding audit_log row on a failed audited action (D-26)', async () => {
    // No x-trace-id header sent, so the id must be generated exactly once
    // and shared between the exception filter's Problem body and the
    // auth.login_failed row auth.service.ts writes inside the same request
    // -- the real bug this node found and fixed in trace-id.ts (memoization).
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: 'still-wrong-password' });

    expect(response.status).toBe(401);
    expect(response.headers['content-type']).toContain('application/problem+json');
    const traceId: string = response.body.traceId;
    expect(traceId).toEqual(expect.stringMatching(/.+/));

    const auditRow = await dataSource.getRepository(AuditLogEntity).findOne({
      where: { tenantId: tenant.id, action: 'auth.login_failed', traceId },
    });
    expect(auditRow).not.toBeNull();
    expect(auditRow!.traceId).toBe(traceId);
  });
});
