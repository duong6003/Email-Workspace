import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { hashPassword } from '../../src/auth/password.service.js';
import { AppUserEntity } from '../../src/database/entities/app-user.entity.js';
import { TenantEntity } from '../../src/database/entities/tenant.entity.js';
import { UserSessionEntity } from '../../src/database/entities/user-session.entity.js';
import { testDatabaseUrl } from '../integration/test-database-url.js';
import { testRedisUrl } from '../integration/test-redis-url.js';

const MUTATING_ROUTES = [
  'POST /auth/refresh', 'POST /auth/logout', 'POST /campaigns', 'PATCH /campaigns/:id',
  'DELETE /campaigns/:id', 'POST /campaigns/:id/duplicate', 'POST /campaigns/:id/audience/preview',
  'POST /campaigns/:id/validate-audience', 'POST /campaigns/:id/audience-waiver',
  'POST /campaigns/:id/schedule', 'POST /campaigns/:id/schedule/cancel', 'POST /campaigns/:id/send',
  'POST /campaigns/:id/cancel', 'POST /campaigns/:id/send/cancel', 'POST /campaigns/:id/pause',
  'POST /campaigns/:id/resume', 'POST /campaigns/:id/resend', 'POST /campaigns/:id/exports',
  'POST /custom-fields', 'PATCH /custom-fields/:id', 'DELETE /custom-fields/:id', 'POST /bulk-jobs',
  'POST /import-jobs/preview', 'POST /import-jobs', 'PUT /notifications/:id/read',
  'PUT /notifications/read-all', 'PATCH /notifications/:id/action-state', 'PUT /notification-preferences',
  'POST /recipients', 'PATCH /recipients/:id', 'DELETE /recipients/:id', 'PUT /retention-policy',
  'POST /recipient-lists', 'PATCH /recipient-lists/:id', 'POST /recipient-lists/:id/members',
  'DELETE /recipient-lists/:id/members', 'DELETE /recipient-lists/:id', 'POST /tags', 'PATCH /tags/:id',
  'POST /tags/:id/members', 'DELETE /tags/:id/members', 'DELETE /tags/:id', 'POST /sender-configs',
  'PATCH /sender-configs/:id', 'DELETE /sender-configs/:id', 'POST /sender-configs/:id/test-connection',
  'PUT /sending-policy', 'POST /templates', 'PATCH /templates/:id', 'DELETE /templates/:id',
  'POST /templates/:id/publish', 'POST /template-versions/:id/preview',
  'POST /template-versions/:id/test-send', 'PATCH /template-versions/:id', 'DELETE /template-versions/:id',
] as const;

function cookieValue(cookies: string[], name: string): string {
  return cookies.find((entry) => entry.startsWith(`${name}=`))!.split(';')[0].split('=')[1]!;
}

describe('M7-S2 session fixation and per-route CSRF negatives', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let tenant: TenantEntity;
  const email = `csrf-session-${randomUUID()}@test.dev`;
  const password = 'correct-horse-battery-staple';

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl();
    process.env.REDIS_URL = testRedisUrl();
    process.env.SESSION_SECRET = 'm7-s2-csrf-session-secret'.repeat(2);
    process.env.WEB_ORIGIN = 'http://localhost:5173';
    const { AppModule } = await import('../../src/app.module.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    await app.init();
    dataSource = moduleRef.get(getDataSourceToken());
    tenant = await dataSource.getRepository(TenantEntity).save({ name: `csrf-session-${randomUUID()}` });
    await dataSource.getRepository(AppUserEntity).save({
      tenantId: tenant.id, email, displayName: 'CSRF Session Admin', role: 'admin',
      passwordHash: await hashPassword(password), status: 'active',
    });
  }, 30_000);

  afterAll(async () => {
    if (!dataSource) return app?.close();
    await dataSource.getRepository(UserSessionEntity).delete({ tenantId: tenant.id });
    await dataSource.getRepository(AppUserEntity).delete({ tenantId: tenant.id });
    await app.close();
  });

  async function login(): Promise<{ cookie: string; csrf: string; sessionId: string }> {
    const response = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password }).expect(204);
    const cookies = response.headers['set-cookie'] as unknown as string[];
    const rawSession = cookieValue(cookies, 'eow_session');
    return {
      cookie: cookies.map((entry) => entry.split(';')[0]).join('; '),
      csrf: cookieValue(cookies, 'eow_csrf'),
      sessionId: rawSession.split('.')[0]!,
    };
  }

  it('BR-AUTH-002: an attacker-supplied pre-login session id is never adopted', async () => {
    const attackerSessionId = randomUUID();
    const attackerCookie = `eow_session=${attackerSessionId}.attacker-controlled-secret`;
    const response = await request(app.getHttpServer()).post('/api/v1/auth/login')
      .set('Cookie', attackerCookie).send({ email, password }).expect(204);
    const cookies = response.headers['set-cookie'] as unknown as string[];
    expect(cookieValue(cookies, 'eow_session').split('.')[0]).not.toBe(attackerSessionId);
    await request(app.getHttpServer()).get('/api/v1/auth/me').set('Cookie', attackerCookie).expect(401);
  });

  it('BR-AUTH-002: every login receives a new CSRF token', async () => {
    const first = await login();
    const second = await login();
    expect(second.csrf).not.toBe(first.csrf);
    expect(second.sessionId).not.toBe(first.sessionId);
  });

  it('BR-AUTH-002: refresh rotation invalidates the previous session token', async () => {
    const first = await login();
    const refreshed = await request(app.getHttpServer()).post('/api/v1/auth/refresh')
      .set('Cookie', first.cookie).set('x-csrf-token', first.csrf).expect(204);
    expect(refreshed.headers['set-cookie']).toBeDefined();
    await request(app.getHttpServer()).post('/api/v1/auth/refresh')
      .set('Cookie', first.cookie).set('x-csrf-token', first.csrf).expect(401);
  });

  it('refuses a mismatched CSRF header before every protected state-changing handler', async () => {
    const session = await login();
    const id = randomUUID();
    for (const route of MUTATING_ROUTES) {
      const [method, path] = route.split(' ', 2) as [string, string];
      const response = await request(app.getHttpServer())
        [method.toLowerCase() as 'post'](`/api/v1${path.replaceAll(':id', id)}`)
        .set('Cookie', session.cookie)
        .set('x-csrf-token', 'not-the-real-token')
        .set('Idempotency-Key', randomUUID())
        .send({});
      expect(response.status, route).toBe(403);
    }
  }, 60_000);
});
