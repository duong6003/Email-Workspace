import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { HttpExceptionFilter } from '../../src/common/http-exception.filter.js';
import { hashPassword } from '../../src/auth/password.service.js';
import { AppUserEntity } from '../../src/database/entities/app-user.entity.js';
import { TenantEntity } from '../../src/database/entities/tenant.entity.js';
import { UserSessionEntity } from '../../src/database/entities/user-session.entity.js';
import { testDatabaseUrl } from './test-database-url.js';
import { testRedisUrl } from './test-redis-url.js';

/**
 * HTTP-level regression, same root cause as recipient-update-http.test.ts:
 * `@Patch(':id')` carried a method-scoped `@UsePipes(new
 * ZodValidationPipe(customFieldUpdateRequestSchema))`, which NestJS also runs
 * against `@Param('id')` -- an object schema validating a plain id string
 * fails every time, before the body is read. Fixed by moving the pipe to
 * `@Body(new ZodValidationPipe(...))`.
 */
describe('Custom field update over HTTP (controller-level pipe wiring)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let tenant: TenantEntity;
  const password = 'correct-horse-battery-staple';
  const adminEmail = `custom-field-update-admin-${randomUUID()}@test.dev`;

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
    tenant = await dataSource.getRepository(TenantEntity).save({ name: `custom-field-update-http-${randomUUID()}` });
    await dataSource.getRepository(AppUserEntity).save({
      tenantId: tenant.id, email: adminEmail, displayName: 'Custom Field Admin', role: 'admin', passwordHash: await hashPassword(password), status: 'active',
    });
  }, 30_000);

  afterAll(async () => {
    if (!dataSource) { await app?.close(); return; }
    await dataSource.query('DELETE FROM custom_field_definition WHERE tenant_id = $1', [tenant.id]);
    await dataSource.getRepository(UserSessionEntity).delete({ tenantId: tenant.id });
    await dataSource.getRepository(AppUserEntity).delete({ tenantId: tenant.id });
    await app.close();
  });

  async function login(): Promise<{ cookie: string; csrfToken: string }> {
    const response = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email: adminEmail, password });
    const cookies = response.headers['set-cookie'] as unknown as string[];
    return {
      cookie: cookies.map((entry) => entry.split(';')[0]).join('; '),
      csrfToken: cookies.find((entry) => entry.startsWith('eow_csrf='))!.split(';')[0].split('=')[1],
    };
  }

  it('accepts a real PATCH body instead of validating the route id against the update schema', async () => {
    const session = await login();
    const created = await request(app.getHttpServer()).post('/api/v1/custom-fields')
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken)
      .send({ key: `field_${randomUUID().slice(0, 8)}`, label: 'Before', type: 'text' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    const updated = await request(app.getHttpServer()).patch(`/api/v1/custom-fields/${created.body.id}`)
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken)
      .send({ label: 'After' });

    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body).toMatchObject({ label: 'After' });
  });
});
