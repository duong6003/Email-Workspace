import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { hashPassword } from '../../src/auth/password.service.js';
import { SessionService } from '../../src/auth/session.service.js';
import { AppUserEntity } from '../../src/database/entities/app-user.entity.js';
import { TenantEntity } from '../../src/database/entities/tenant.entity.js';
import { UserSessionEntity } from '../../src/database/entities/user-session.entity.js';
import { testDatabaseUrl } from '../integration/test-database-url.js';
import { testRedisUrl } from '../integration/test-redis-url.js';

const CROSS_TENANT_ROUTES = [
  'DELETE /campaigns/:id', 'DELETE /custom-fields/:id', 'DELETE /recipient-lists/:id',
  'DELETE /global-variables/:id', 'DELETE /template-variables/:id',
  'DELETE /recipient-lists/:id/members', 'DELETE /recipients/:id', 'DELETE /sender-configs/:id',
  'DELETE /tags/:id', 'DELETE /tags/:id/members', 'DELETE /template-versions/:id',
  'DELETE /templates/:id', 'GET /bulk-jobs', 'GET /bulk-jobs/:id',
  'GET /bulk-jobs/:id/error-file', 'GET /bulk-jobs/:id/result-file', 'GET /campaigns',
  'GET /campaigns/:id/exports/:id', 'GET /campaigns/:id/progress', 'GET /campaigns/:id/recipients', 'GET /campaigns/:id/snapshot',
  'GET /campaigns/history', 'GET /custom-fields', 'GET /custom-fields/:id', 'GET /import-jobs',
  'GET /global-variables', 'GET /templates/:id/variables',
  'GET /import-jobs/:id', 'GET /import-jobs/:id/error-file', 'GET /notification-preferences',
  'GET /notifications', 'GET /notifications/:id/deep-link', 'GET /recipient-lists',
  'GET /recipient-lists/:id', 'GET /recipients', 'GET /recipients/:id',
  'GET /recipients/:id/segments', 'GET /sender-configs', 'GET /sender-configs/:id',
  'GET /sending-policy', 'GET /tags', 'GET /tags/:id', 'GET /template-versions/:id',
  'GET /templates', 'GET /templates/:id', 'PATCH /campaigns/:id', 'PATCH /custom-fields/:id',
  'PATCH /global-variables/:id', 'PATCH /template-variables/:id',
  'PATCH /notifications/:id/action-state', 'PATCH /recipient-lists/:id', 'PATCH /recipients/:id',
  'PATCH /sender-configs/:id', 'PATCH /tags/:id', 'PATCH /template-versions/:id',
  'PATCH /templates/:id', 'POST /bulk-jobs', 'POST /bulk-jobs/preview',
  'POST /campaigns/:id/audience-waiver', 'POST /campaigns/:id/cancel',
  'POST /campaigns/:id/duplicate', 'POST /campaigns/:id/exports', 'POST /campaigns/:id/pause',
  'POST /campaigns/:id/resend', 'POST /campaigns/:id/resume', 'POST /campaigns/:id/send',
  'POST /campaigns/:id/send/cancel', 'POST /campaigns/:id/validate-audience',
  'POST /custom-fields', 'POST /import-jobs', 'POST /import-jobs/preview',
  'POST /global-variables', 'POST /templates/:id/variables',
  'POST /recipient-lists', 'POST /recipient-lists/:id/members', 'POST /recipients',
  'POST /sender-configs', 'POST /sender-configs/:id/test-connection', 'POST /tags',
  'POST /tags/:id/members', 'POST /template-versions/:id/preview',
  'POST /template-versions/:id/test-send', 'POST /templates', 'POST /templates/analyze',
  'POST /templates/:id/preview', 'POST /templates/:id/publish',
  'PUT /notification-preferences', 'PUT /notifications/:id/read', 'PUT /notifications/read-all',
  'PUT /sending-policy',
] as const;

const COLLECTION_ROUTES = new Set([
  'GET /bulk-jobs', 'GET /campaigns', 'GET /campaigns/history', 'GET /custom-fields',
  'GET /global-variables', 'GET /import-jobs', 'GET /notification-preferences', 'GET /notifications',
  'GET /recipient-lists', 'GET /recipients', 'GET /sender-configs', 'GET /sending-policy',
  'GET /tags', 'GET /templates',
]);

const TENANT_SCOPED_SUCCESS_ROUTES = new Set(['PUT /notifications/read-all']);

describe('M7-S2 cross-tenant matrix (BR-GEN-002 / TC-SEC-009)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let tenantA: TenantEntity;
  let tenantB: TenantEntity;
  let tenantBUser: AppUserEntity;
  let cookie: string;
  const marker = `tenant-b-marker-${randomUUID()}`;

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl();
    process.env.REDIS_URL = testRedisUrl();
    process.env.SESSION_SECRET = 'm7-s2-cross-tenant-session-secret'.repeat(2);
    process.env.WEB_ORIGIN = 'http://localhost:5173';
    const { AppModule } = await import('../../src/app.module.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    await app.init();
    dataSource = moduleRef.get(getDataSourceToken());

    tenantA = await dataSource.getRepository(TenantEntity).save({ name: `matrix-a-${randomUUID()}` });
    tenantB = await dataSource.getRepository(TenantEntity).save({ name: marker });
    const passwordHash = await hashPassword('correct-horse-battery-staple');
    const tenantAUser = await dataSource.getRepository(AppUserEntity).save({
      tenantId: tenantA.id, email: `matrix-a-${randomUUID()}@test.dev`, displayName: 'Matrix A', role: 'admin', passwordHash, status: 'active',
    });
    tenantBUser = await dataSource.getRepository(AppUserEntity).save({
      tenantId: tenantB.id, email: `matrix-b-${randomUUID()}@test.dev`, displayName: marker, role: 'admin', passwordHash, status: 'active',
    });

    const issued = await dataSource.transaction((manager) => new SessionService().create(manager, {
      tenantId: tenantA.id, userId: tenantAUser.id, remember: false,
    }));
    cookie = `eow_session=${issued.token.raw}; eow_csrf=matrix-csrf`;
  }, 30_000);

  afterAll(async () => {
    if (!dataSource) return app?.close();
    await dataSource.getRepository(UserSessionEntity).delete({ tenantId: tenantA.id });
    // Audit rows are intentionally immutable, so retain the fixture tenant A
    // as the audit owner rather than weakening BR-SEC-002 for test cleanup.
    await dataSource.getRepository(AppUserEntity).delete({ tenantId: tenantB.id });
    await dataSource.getRepository(TenantEntity).delete(tenantB.id);
    await app.close();
  }, 30_000);

  for (const route of CROSS_TENANT_ROUTES) {
    it(`cross-tenant: ${route} cannot use tenant B identity with tenant A session`, async () => {
      const [method, declaredPath] = route.split(' ', 2) as [string, string];
      const url = `/api/v1${declaredPath.replaceAll(':id', tenantBUser.id)}`;
      const before = await dataSource.getRepository(AppUserEntity).findOneByOrFail({ id: tenantBUser.id });
      const response = await request(app.getHttpServer())
        [method.toLowerCase() as 'get'](url)
        .set('Cookie', cookie)
        .set('x-csrf-token', 'matrix-csrf')
        .set('Idempotency-Key', randomUUID())
        .send({ recipientIds: [tenantBUser.id], mergeData: {}, action: 'delete', actionPayload: {} });

      if (COLLECTION_ROUTES.has(route)) expect(response.status).toBe(200);
      else if (TENANT_SCOPED_SUCCESS_ROUTES.has(route)) expect(response.status).toBe(204);
      else expect([400, 403, 404, 405, 409, 410, 422, 428]).toContain(response.status);
      expect(response.status).not.toBe(500);
      expect(JSON.stringify(response.body ?? {})).not.toContain(tenantB.id);
      expect(JSON.stringify(response.body ?? {})).not.toContain(marker);
      expect(await dataSource.getRepository(AppUserEntity).findOneByOrFail({ id: tenantBUser.id })).toEqual(before);
    }, 30_000);
  }
});
