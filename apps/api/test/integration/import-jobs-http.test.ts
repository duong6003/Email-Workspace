import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { HttpExceptionFilter } from '../../src/common/http-exception.filter.js';
import { JSON_BODY_LIMIT_BYTES } from '../../src/common/http-body-limit.js';
import { TenantEntity } from '../../src/database/entities/tenant.entity.js';
import { AppUserEntity } from '../../src/database/entities/app-user.entity.js';
import { UserSessionEntity } from '../../src/database/entities/user-session.entity.js';
import { ImportJobEntity } from '../../src/database/entities/import-job.entity.js';
import { CustomFieldDefinitionEntity } from '../../src/database/entities/custom-field-definition.entity.js';
import { ImportJobRowEntity } from '../../src/database/entities/import-job-row.entity.js';
import { OutboxEventEntity } from '../../src/database/entities/outbox-event.entity.js';
import { IdempotencyKeyEntity } from '../../src/database/entities/idempotency-key.entity.js';
import { hashPassword } from '../../src/auth/password.service.js';
import { testDatabaseUrl } from './test-database-url.js';
import { testRedisUrl } from './test-redis-url.js';

describe('Import job HTTP (M2-S4)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let tenant: TenantEntity;
  const email = `http-import-${randomUUID()}@test.dev`;
  const password = 'correct-horse-battery-staple';

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl();
    process.env.REDIS_URL = testRedisUrl();
    process.env.SESSION_SECRET = 'a'.repeat(64);
    process.env.WEB_ORIGIN = 'http://localhost:5173';
    const { AppModule } = await import('../../src/app.module.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.setGlobalPrefix('api/v1');
    app.useBodyParser('json', { limit: JSON_BODY_LIMIT_BYTES });
    app.use(cookieParser());
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
    dataSource = moduleRef.get(getDataSourceToken());
    tenant = await dataSource.getRepository(TenantEntity).save({ name: `http-import-tenant-${randomUUID()}` });
    await dataSource.getRepository(AppUserEntity).save({
      tenantId: tenant.id,
      email,
      displayName: 'HTTP Import Operator',
      role: 'operator',
      passwordHash: await hashPassword(password),
      status: 'active',
    });
  }, 30_000);

  afterAll(async () => {
    if (!dataSource || !tenant) {
      await app?.close();
      return;
    }
    const jobs = await dataSource.getRepository(ImportJobEntity).find({ where: { tenantId: tenant.id } });
    const jobIds = jobs.map((job) => job.id);
    if (jobIds.length > 0) {
      await dataSource.getRepository(ImportJobRowEntity).createQueryBuilder().delete().where('job_id IN (:...jobIds)', { jobIds }).execute();
      await dataSource.getRepository(OutboxEventEntity).createQueryBuilder().delete().where('aggregate_type = :type AND aggregate_id IN (:...jobIds)', { type: 'import_job', jobIds }).execute();
      await dataSource.getRepository(ImportJobEntity).createQueryBuilder().delete().where('id IN (:...jobIds)', { jobIds }).execute();
    }
    await dataSource.getRepository(IdempotencyKeyEntity).delete({ tenantId: tenant.id });
    await dataSource.getRepository(UserSessionEntity).delete({ tenantId: tenant.id });
    await dataSource.getRepository(AppUserEntity).delete({ tenantId: tenant.id });
    await app.close();
  });

  async function auth(): Promise<{ cookie: string; csrfToken: string }> {
    const response = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password });
    const setCookie = response.headers['set-cookie'] as unknown as string[];
    return {
      cookie: setCookie.map((entry) => entry.split(';')[0]).join('; '),
      csrfToken: setCookie.find((entry) => entry.startsWith('eow_csrf='))!.split(';')[0].split('=')[1],
    };
  }

  const body = {
    fileName: 'recipients.csv',
    fileSizeBytes: 42,
    mode: 'upsert',
    mapping: { email: 'Email' },
    rows: [{ rowNumber: 2, rawData: { Email: 'person@example.test' } }],
  };

  it('requires CSRF on the state-changing import endpoint', async () => {
    const session = await auth();
    const response = await request(app.getHttpServer()).post('/api/v1/import-jobs').set('Cookie', session.cookie).send(body);
    expect(response.status).toBe(403);
  });

  it('requires Idempotency-Key before accepting an import job', async () => {
    const session = await auth();
    const response = await request(app.getHttpServer())
      .post('/api/v1/import-jobs')
      .set('Cookie', session.cookie)
      .set('x-csrf-token', session.csrfToken)
      .send(body);
    expect(response.status).toBe(400);
  });

  it('returns row, column and canonical custom-field coercion errors without creating an import job', async () => {
    const session = await auth();
    await dataSource.getRepository(CustomFieldDefinitionEntity).save({
      tenantId: tenant.id, fieldKey: 'age', label: 'Age', dataType: 'number', required: false,
    });

    const response = await request(app.getHttpServer())
      .post('/api/v1/import-jobs/preview')
      .set('Cookie', session.cookie)
      .set('x-csrf-token', session.csrfToken)
      .send({
        ...body,
        mapping: { email: 'Email', custom_age: 'Age' },
        rows: [{ rowNumber: 2, rawData: { Email: 'person@example.test', Age: 'not-a-number' } }],
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      rows: [{ rowNumber: 2 }],
      errors: [{ rowNumber: 2, column: 'Age', reason: 'Custom field "age" expects a numeric value.' }],
    });
    expect(await dataSource.getRepository(ImportJobEntity).count({ where: { tenantId: tenant.id } })).toBe(0);
  });

  it('accepts a 2,000-row JSON preview past Express’s former 100 KB default', async () => {
    const session = await auth();
    const rows = Array.from({ length: 2_000 }, (_, index) => ({
      rowNumber: index + 2,
      rawData: { Email: `recipient-${index}@example.test`, Notes: 'x'.repeat(48) },
    }));

    const response = await request(app.getHttpServer())
      .post('/api/v1/import-jobs')
      .set('Cookie', session.cookie)
      .set('x-csrf-token', session.csrfToken)
      .set('Idempotency-Key', `http-import-parser-limit-${randomUUID()}`)
      .send({ ...body, fileName: 'bad-extension.txt', rows });

    // A 400 proves the request reached DTO validation; with the former default,
    // this same payload failed in body parsing before the controller.
    expect(response.status).toBe(400);
    expect(response.body.detail).toContain('fileName: Only CSV and XLSX files are supported.');
  });

  it('returns an RFC 9457 413 problem when the configured JSON parser limit is exceeded', async () => {
    const session = await auth();
    const rows = [{ rowNumber: 2, rawData: { Padding: 'x'.repeat(JSON_BODY_LIMIT_BYTES) } }];

    const response = await request(app.getHttpServer())
      .post('/api/v1/import-jobs')
      .set('Cookie', session.cookie)
      .set('x-csrf-token', session.csrfToken)
      .set('Idempotency-Key', `http-import-parser-limit-${randomUUID()}`)
      .send({ ...body, fileName: 'bad-extension.txt', rows });

    expect(response.status).toBe(413);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.body).toMatchObject({
      title: 'Payload Too Large',
      status: 413,
      detail: 'Request body exceeds the maximum allowed size.',
    });
  });

  it('rejects an oversized import before persisting a job or checkpoints', async () => {
    const session = await auth();
    const jobsBefore = await dataSource.getRepository(ImportJobEntity).count({ where: { tenantId: tenant.id } });

    const response = await request(app.getHttpServer())
      .post('/api/v1/import-jobs')
      .set('Cookie', session.cookie)
      .set('x-csrf-token', session.csrfToken)
      .set('Idempotency-Key', `http-import-oversized-${randomUUID()}`)
      .send({ ...body, fileSizeBytes: 50 * 1024 * 1024 + 1 });

    expect(response.status).toBe(400);
    expect(await dataSource.getRepository(ImportJobEntity).count({ where: { tenantId: tenant.id } })).toBe(jobsBefore);
  });

  it('accepts a valid import, returns 202, and replays it with the same key without creating a second job', async () => {
    const session = await auth();
    const key = `http-import-${randomUUID()}`;
    const first = await request(app.getHttpServer())
      .post('/api/v1/import-jobs')
      .set('Cookie', session.cookie)
      .set('x-csrf-token', session.csrfToken)
      .set('Idempotency-Key', key)
      .send(body);
    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({ kind: 'import', status: 'queued', totalRows: 1, idempotencyReplayed: false });

    const replay = await request(app.getHttpServer())
      .post('/api/v1/import-jobs')
      .set('Cookie', session.cookie)
      .set('x-csrf-token', session.csrfToken)
      .set('Idempotency-Key', key)
      .send(body);
    expect(replay.status).toBe(202);
    expect(replay.body).toMatchObject({ jobId: first.body.jobId, idempotencyReplayed: true });
  });

  it('downloads only the current tenant\'s failed-row CSV artifact', async () => {
    const session = await auth();
    const created = await request(app.getHttpServer())
      .post('/api/v1/import-jobs')
      .set('Cookie', session.cookie)
      .set('x-csrf-token', session.csrfToken)
      .set('Idempotency-Key', `http-import-errors-${randomUUID()}`)
      .send(body);
    await dataSource.getRepository(ImportJobRowEntity).update({ jobId: created.body.jobId, rowNumber: 2 }, { status: 'failed', error: 'INVALID_EMAIL' });

    const response = await request(app.getHttpServer()).get(`/api/v1/import-jobs/${created.body.jobId}/error-file`).set('Cookie', session.cookie);
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.text).toContain('2,INVALID_EMAIL');
  });
});
