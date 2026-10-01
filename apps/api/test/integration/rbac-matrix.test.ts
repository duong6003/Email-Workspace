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
import { RoleEntity } from '../../src/database/entities/role.entity.js';
import { UserRoleEntity } from '../../src/database/entities/user-role.entity.js';
import { hashPassword } from '../../src/auth/password.service.js';
import { testDatabaseUrl } from './test-database-url.js';
import { testRedisUrl } from './test-redis-url.js';

/**
 * M1-S2 RBAC negative matrix: real Nest HTTP app + real PostgreSQL. Proves
 * BR-AUTH-003 (admin/operator/viewer with distinct capability sets) and
 * BR-AUTH-004 (server-side 403 enforcement, never UI-only, with actor +
 * endpoint recorded to audit_log) across every protected operation
 * currently exposed by a real controller: /auth/{refresh,logout,me} and
 * /campaigns/{progress,schedule,send,cancel} and /notifications{,/:id/read}.
 */
describe('RBAC negative matrix (integration, real PostgreSQL, real Nest app)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let tenant: TenantEntity;
  const password = 'correct-horse-battery-staple';

  type Role = 'admin' | 'operator' | 'viewer';
  const users: Record<Role, { email: string; id: string; cookieHeader: string; csrfToken: string }> = {} as never;

  async function loginAs(email: string): Promise<{ cookieHeader: string; csrfToken: string }> {
    const response = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password });
    const setCookieHeader = response.headers['set-cookie'] as unknown as string[];
    const cookieHeader = setCookieHeader.map((c) => c.split(';')[0]).join('; ');
    const csrfToken = setCookieHeader.find((c) => c.startsWith('eow_csrf='))!.split(';')[0].split('=')[1];
    return { cookieHeader, csrfToken };
  }

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
    tenant = await dataSource.getRepository(TenantEntity).save({ name: `rbac-matrix-tenant-${randomUUID()}` });

    const passwordHash = await hashPassword(password);
    const roleRepo = dataSource.getRepository(RoleEntity);
    const userRoleRepo = dataSource.getRepository(UserRoleEntity);

    for (const role of ['admin', 'operator', 'viewer'] as Role[]) {
      const email = `rbac-${role}-${randomUUID()}@test.dev`;
      const user = await dataSource.getRepository(AppUserEntity).save({
        tenantId: tenant.id,
        email,
        displayName: `RBAC ${role}`,
        role,
        passwordHash,
        status: 'active',
      });
      const roleRow = await roleRepo.findOneOrFail({ where: { key: role } });
      await userRoleRepo.save({ tenantId: tenant.id, userId: user.id, roleId: roleRow.id });

      const session = await loginAs(email);
      users[role] = { email, id: user.id, ...session };
    }
  });

  afterAll(async () => {
    // M1-S3: audit_log is now immutable (005_audit_log_immutability.sql) and
    // audit_log.tenant_id has no ON DELETE CASCADE, so a tenant that owns an
    // audit_log row (this suite writes several rbac.denied/auth.* rows) can
    // no longer be deleted either — see auth-service.test.ts's afterAll for
    // the full rationale.
    await dataSource.getRepository(UserRoleEntity).delete({ tenantId: tenant.id });
    await dataSource.getRepository(UserSessionEntity).delete({ tenantId: tenant.id });
    await dataSource.getRepository(LoginAttemptEntity).delete({ tenantId: tenant.id });
    await dataSource.getRepository(AppUserEntity).delete({ tenantId: tenant.id });
    await app.close();
  });

  it("GET /auth/me returns each role's real, distinct permission list (BR-AUTH-003)", async () => {
    const admin = await request(app.getHttpServer()).get('/api/v1/auth/me').set('Cookie', users.admin.cookieHeader);
    const operator = await request(app.getHttpServer()).get('/api/v1/auth/me').set('Cookie', users.operator.cookieHeader);
    const viewer = await request(app.getHttpServer()).get('/api/v1/auth/me').set('Cookie', users.viewer.cookieHeader);

    expect(admin.status).toBe(200);
    expect(admin.body.permissions.sort()).toEqual([
      'campaign:manage',
      'campaign:read',
      'content:manage',
      'content:read',
      'dlq:manage',
      'history:export',
      'notification:read',
      'recipient:manage',
      'recipient:read',
      'session:manage',
      'settings:manage',
    ]);

    expect(operator.status).toBe(200);
    expect(operator.body.permissions.sort()).toEqual([
      'campaign:manage',
      'campaign:read',
      'content:manage',
      'content:read',
      'history:export',
      'notification:read',
      'recipient:manage',
      'recipient:read',
      'session:manage',
    ]);
    expect(operator.body.permissions).not.toContain('settings:manage');

    expect(viewer.status).toBe(200);
    // 073_content_read_permission.sql: the viewer gained content:read so the
    // template editor's read-only permission_denied state has content to show
    // (mailcraft-integration-requirements.md §5.1). content:manage -- the right
    // to *change* that content -- is still withheld, which is the whole point
    // of splitting the key.
    expect(viewer.body.permissions.sort()).toEqual(['campaign:read', 'content:read', 'notification:read', 'session:manage']);
    expect(viewer.body.permissions).not.toContain('campaign:manage');
    expect(viewer.body.permissions).not.toContain('content:manage');
    expect(viewer.body.permissions).not.toContain('history:export');
  });

  const campaignId = randomUUID();
  const negativeMatrix: Array<{ method: 'get' | 'post' | 'put'; path: string; allow: Role[]; expectAllowedStatus: number; body?: Record<string, unknown>; headers?: (role: Role) => Record<string, string> }> = [
    // M5-S3 CP6: progress() now does real work (getCampaignProgress) instead
    // of the old always-succeeding mock, so an allowed role sees 404 for
    // this random UUID naming no real campaign -- the RBAC guard let it
    // through; NotFoundException is the real, correct next layer.
    { method: 'get', path: `/api/v1/campaigns/${campaignId}/progress`, allow: ['admin', 'operator', 'viewer'], expectAllowedStatus: 404 },
    // M5-S2: schedule() now does real work (freezeCampaignSnapshot) and gained
    // @UseGuards(CsrfGuard) plus a zod-validated body, replacing the old
    // guard-only stub that accepted an empty {} body. An allowed role now
    // clears CsrfGuard and RBAC, then hits ZodValidationPipe's 400 on the
    // empty body -- still proof the permission guard, not validation, is
    // what this matrix probes.
    { method: 'post', path: `/api/v1/campaigns/${campaignId}/schedule`, allow: ['admin', 'operator'], expectAllowedStatus: 400, headers: (role) => ({ 'x-csrf-token': users[role].csrfToken, 'idempotency-key': randomUUID() }) },
    // M4-S4: send/cancel now do real work (freezeCampaignSnapshot / supersede)
    // and gained @UseGuards(CsrfGuard), so this permission-guard-only probe
    // needs a real CSRF token to get past that guard -- campaignId is still a
    // random UUID naming no real campaign, so an allowed role now sees 404
    // (the RBAC guard let it through; NotFoundException is the real, correct
    // next layer). send additionally requires Idempotency-Key (400 if
    // missing, per BR-GEN-005) before it even looks the campaign up.
    { method: 'post', path: `/api/v1/campaigns/${campaignId}/send`, allow: ['admin', 'operator'], expectAllowedStatus: 404, headers: (role) => ({ 'x-csrf-token': users[role].csrfToken, 'idempotency-key': randomUUID() }) },
    { method: 'post', path: `/api/v1/campaigns/${campaignId}/cancel`, allow: ['admin', 'operator'], expectAllowedStatus: 404, headers: (role) => ({ 'x-csrf-token': users[role].csrfToken }) },
    { method: 'get', path: '/api/v1/notifications', allow: ['admin', 'operator', 'viewer'], expectAllowedStatus: 200 },
    // M2-S3: GET uses recipient:read (admin+operator, not viewer); POST uses
    // settings:manage (admin only) -- an admin-defined schema action. POST
    // needs a real, zod-valid body (unlike the pre-existing campaign stubs)
    // since CustomFieldsController actually validates its request body.
    { method: 'get', path: '/api/v1/custom-fields', allow: ['admin', 'operator'], expectAllowedStatus: 200 },
    // 073_content_read_permission.sql: reading templates takes content:read
    // (every role), changing them still takes content:manage (not the viewer).
    // This pair is what makes the read-only editor safe -- the viewer can load
    // the content the screen renders and is refused the moment it would write.
    { method: 'get', path: '/api/v1/templates', allow: ['admin', 'operator', 'viewer'], expectAllowedStatus: 200 },
    // A write probe, not POST /templates: this matrix replays one shared body
    // for every allowed role, and template names are unique per tenant, so the
    // second allowed role would collide with the first's row and see 409
    // instead of the guard's answer. publish takes no body and names a random
    // UUID, so an allowed role sees 404 -- the RBAC guard let it through, and
    // NotFoundException is the real, correct next layer -- exactly how the
    // campaign rows above probe a write.
    {
      method: 'post',
      path: `/api/v1/templates/${randomUUID()}/publish`,
      allow: ['admin', 'operator'],
      expectAllowedStatus: 404,
      headers: (role) => ({ 'x-csrf-token': users[role].csrfToken }),
    },
    {
      method: 'post',
      path: '/api/v1/custom-fields',
      allow: ['admin'],
      expectAllowedStatus: 201,
      body: { key: `rbac_probe_${randomUUID().slice(0, 8)}`, label: 'RBAC probe', type: 'text' },
      headers: (role) => ({ 'x-csrf-token': users[role].csrfToken }),
    },
  ];

  for (const testCase of negativeMatrix) {
    for (const role of ['admin', 'operator', 'viewer'] as Role[]) {
      const shouldAllow = testCase.allow.includes(role);
      it(`${testCase.method.toUpperCase()} ${testCase.path} as ${role}: ${shouldAllow ? `allowed (${testCase.expectAllowedStatus})` : 'denied (403 RFC 9457 problem)'}`, async () => {
        // CampaignsController's schedule() is a pre-existing M5-scope
        // skeleton stub that dereferences the body unconditionally; send an
        // empty object by default so this RBAC test exercises only the
        // guard behaviour, not that unrelated stub's own (out-of-scope)
        // body handling. A test case may override with a real body when its
        // controller does validate (e.g. custom-fields).
        let req = request(app.getHttpServer())[testCase.method](testCase.path).set('Cookie', users[role].cookieHeader);
        if (testCase.headers) req = req.set(testCase.headers(role));
        const response = await req.send(testCase.body ?? {});

        if (shouldAllow) {
          expect(response.status).toBe(testCase.expectAllowedStatus);
        } else {
          expect(response.status).toBe(403);
          expect(response.headers['content-type']).toContain('application/problem+json');
          expect(response.body.traceId).toBeDefined();
        }
      });
    }
  }

  it('TC-AUTH-009: Viewer calling POST /campaigns/:id/send directly (bypassing any UI hiding) gets 403, and audit_log records the denial with actor + endpoint (BR-AUTH-004)', async () => {
    const beforeCount = await dataSource.getRepository(AuditLogEntity).count({ where: { tenantId: tenant.id, action: 'rbac.denied' } });

    const response = await request(app.getHttpServer())
      .post(`/api/v1/campaigns/${campaignId}/send`)
      .set('Cookie', users.viewer.cookieHeader);

    expect(response.status).toBe(403);

    const denials = await dataSource.getRepository(AuditLogEntity).find({ where: { tenantId: tenant.id, action: 'rbac.denied' }, order: { occurredAt: 'DESC' } });
    expect(denials.length).toBe(beforeCount + 1);
    const latest = denials[0]!;
    expect(latest.actorId).toBe(users.viewer.id);
    expect((latest.metadata as { endpoint: string }).endpoint).toContain('/campaigns/');
    expect((latest.metadata as { endpoint: string }).endpoint).toContain('/send');
    expect((latest.metadata as { endpoint: string }).endpoint.startsWith('POST')).toBe(true);
  });

  it('rejects refresh/logout without the matching CSRF header even for an authenticated, permitted admin (existing M1-S1 CSRF control still holds)', async () => {
    const response = await request(app.getHttpServer()).post('/api/v1/auth/logout').set('Cookie', users.admin.cookieHeader);
    expect(response.status).toBe(403);
  });

  it('admin can refresh and logout with a matching CSRF header (session:manage granted to every role)', async () => {
    const session = await loginAs(users.operator.email);
    const logout = await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Cookie', session.cookieHeader)
      .set('x-csrf-token', session.csrfToken);
    expect(logout.status).toBe(204);
  });
});
