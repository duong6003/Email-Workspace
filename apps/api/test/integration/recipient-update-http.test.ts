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
 * HTTP-level regression for a bug found manually: `@Patch(':id')` on both
 * RecipientsController and CustomFieldsController carried a method-scoped
 * `@UsePipes(new ZodValidationPipe(updateSchema))`. NestJS runs a
 * method-scoped pipe against every business parameter of the handler, not
 * just @Body() -- so the string `id` from @Param('id') was validated against
 * the same object schema and failed with "expected object, received string"
 * on every call, before the body was ever looked at. A service-level test
 * (recipients.test.ts, custom-fields.test.ts) calls the service directly and
 * cannot see this class of bug -- only a real HTTP round trip through the
 * controller can. The fix moves the pipe to `@Body(new ZodValidationPipe(...))`,
 * matching the pattern already used elsewhere (campaigns.controller.ts).
 */
describe('Recipient update over HTTP (controller-level pipe wiring)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let tenant: TenantEntity;
  const password = 'correct-horse-battery-staple';
  const operatorEmail = `recipient-update-operator-${randomUUID()}@test.dev`;

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
    tenant = await dataSource.getRepository(TenantEntity).save({ name: `recipient-update-http-${randomUUID()}` });
    await dataSource.getRepository(AppUserEntity).save({
      tenantId: tenant.id, email: operatorEmail, displayName: 'Recipient Operator', role: 'operator', passwordHash: await hashPassword(password), status: 'active',
    });
  }, 30_000);

  afterAll(async () => {
    if (!dataSource) { await app?.close(); return; }
    await dataSource.query('DELETE FROM recipient WHERE tenant_id = $1', [tenant.id]);
    await dataSource.getRepository(UserSessionEntity).delete({ tenantId: tenant.id });
    await dataSource.getRepository(AppUserEntity).delete({ tenantId: tenant.id });
    await app.close();
  });

  async function login(): Promise<{ cookie: string; csrfToken: string }> {
    const response = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email: operatorEmail, password });
    const cookies = response.headers['set-cookie'] as unknown as string[];
    return {
      cookie: cookies.map((entry) => entry.split(';')[0]).join('; '),
      csrfToken: cookies.find((entry) => entry.startsWith('eow_csrf='))!.split(';')[0].split('=')[1],
    };
  }

  it('accepts a real PATCH body instead of validating the route id against the update schema', async () => {
    const session = await login();
    const created = await request(app.getHttpServer()).post('/api/v1/recipients')
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken)
      .send({ email: `recipient-${randomUUID()}@acme.vn`, firstName: 'Before' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    const updated = await request(app.getHttpServer()).patch(`/api/v1/recipients/${created.body.id}`)
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken)
      .send({ firstName: 'Dương', lastName: 'Vũ', phone: '', department: '', title: '', location: '' });

    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body).toMatchObject({ firstName: 'Dương', lastName: 'Vũ', phone: null, department: null, title: null, location: null });
  });
});
