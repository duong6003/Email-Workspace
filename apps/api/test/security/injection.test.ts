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
import { RecipientEntity } from '../../src/database/entities/recipient.entity.js';
import { TenantEntity } from '../../src/database/entities/tenant.entity.js';
import { UserSessionEntity } from '../../src/database/entities/user-session.entity.js';
import { testDatabaseUrl } from '../integration/test-database-url.js';
import { testRedisUrl } from '../integration/test-redis-url.js';

const PAYLOADS = [
  `'; DROP TABLE recipient; --`,
  `' OR '1'='1`,
  `\\'; SELECT pg_sleep(5); --`,
  `%' UNION SELECT NULL, current_database(), NULL --`,
  `{"$ne": null}`,
  `1); DELETE FROM tag WHERE 1=1; --`,
] as const;

describe('M7-S2 injection negatives (TC-SEC-013)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let tenant: TenantEntity;
  let cookie: string;
  const email = `injection-${randomUUID()}@test.dev`;
  const password = 'correct-horse-battery-staple';

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl();
    process.env.REDIS_URL = testRedisUrl();
    process.env.SESSION_SECRET = 'm7-s2-injection-session-secret'.repeat(2);
    process.env.WEB_ORIGIN = 'http://localhost:5173';
    const { AppModule } = await import('../../src/app.module.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    await app.init();
    dataSource = moduleRef.get(getDataSourceToken());
    tenant = await dataSource.getRepository(TenantEntity).save({ name: `injection-${randomUUID()}` });
    await dataSource.getRepository(AppUserEntity).save({
      tenantId: tenant.id, email, displayName: 'Injection Admin', role: 'admin',
      passwordHash: await hashPassword(password), status: 'active',
    });
    await dataSource.getRepository(RecipientEntity).save({
      tenantId: tenant.id, email: `seed-${randomUUID()}@example.test`, firstName: 'Safe', lastName: null,
      phone: null, department: null, title: null, location: null, subscriptionStatus: 'active',
      customData: {}, unsubscribedAt: null, deletedAt: null,
    });
    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password }).expect(204);
    cookie = (login.headers['set-cookie'] as unknown as string[]).map((entry) => entry.split(';')[0]).join('; ');
  }, 30_000);

  afterAll(async () => {
    if (!dataSource) return app?.close();
    await dataSource.getRepository(RecipientEntity).delete({ tenantId: tenant.id });
    await dataSource.getRepository(UserSessionEntity).delete({ tenantId: tenant.id });
    await dataSource.getRepository(AppUserEntity).delete({ tenantId: tenant.id });
    await app.close();
  });

  // Every inspected raw query uses placeholders; dynamic export conditions
  // interpolate placeholder indices, never request values. This is a
  // regression guard, not a claim that this checkpoint found an SQL hole.
  for (const payload of PAYLOADS) {
    it(`treats recipient search payload ${JSON.stringify(payload).slice(0, 30)} as data`, async () => {
      const before = await dataSource.getRepository(RecipientEntity).count({ where: { tenantId: tenant.id } });
      const response = await request(app.getHttpServer())
        .get(`/api/v1/recipients?search=${encodeURIComponent(payload)}`)
        .set('Cookie', cookie);
      expect([200, 400]).toContain(response.status);
      expect(response.status).not.toBe(500);
      expect(JSON.stringify(response.body ?? {})).not.toMatch(/syntax error|SELECT .* FROM|\bat .*:\d+:\d+/i);
      expect(await dataSource.getRepository(RecipientEntity).count({ where: { tenantId: tenant.id } })).toBe(before);
    });
  }

  it.each(PAYLOADS)('treats campaign-history search payload %s as data', async (payload) => {
    const response = await request(app.getHttpServer())
      .get(`/api/v1/campaigns/history?search=${encodeURIComponent(payload)}`)
      .set('Cookie', cookie);
    expect([200, 400]).toContain(response.status);
    expect(response.status).not.toBe(500);
    expect(JSON.stringify(response.body ?? {})).not.toMatch(/syntax error|SELECT .* FROM|\bat .*:\d+:\d+/i);
  });

  it.each(PAYLOADS)('treats list/tag search payload %s as data', async (payload) => {
    for (const route of ['recipient-lists', 'tags']) {
      const response = await request(app.getHttpServer())
        .get(`/api/v1/${route}?search=${encodeURIComponent(payload)}`)
        .set('Cookie', cookie);
      expect([200, 400]).toContain(response.status);
      expect(response.status).not.toBe(500);
      expect(JSON.stringify(response.body ?? {})).not.toMatch(/syntax error|SELECT .* FROM|\bat .*:\d+:\d+/i);
    }
  });
});
