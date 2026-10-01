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
import { testDatabaseUrl } from '../integration/test-database-url.js';
import { testRedisUrl } from '../integration/test-redis-url.js';

type Session = { cookie: string; csrfToken: string };

describe('DLQ inspect and controlled replay (real PostgreSQL and Nest HTTP)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let tenantId: string;
  let otherTenantId: string;
  let adminUserId: string;
  let operatorUserId: string;
  let otherAdminUserId: string;
  let outboxEventId: string;
  let deadLetterId: string;
  let admin: Session;
  let operator: Session;
  let otherAdmin: Session;
  const password = 'correct-horse-battery-staple';
  const replayKey = randomUUID();

  async function login(email: string): Promise<Session> {
    const response = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password });
    const cookies = response.headers['set-cookie'] as unknown as string[];
    return {
      cookie: cookies.map((entry) => entry.split(';')[0]).join('; '),
      csrfToken: cookies.find((entry) => entry.startsWith('eow_csrf='))!.split(';')[0].split('=')[1],
    };
  }

  async function countDownstreamEffect(): Promise<number> {
    const [row] = await dataSource.query(
      `SELECT count(*)::int AS count FROM outbox_event
       WHERE id = $1 AND published_at IS NULL AND dead_lettered_at IS NULL`,
      [outboxEventId],
    ) as Array<{ count: number }>;
    return Number(row.count);
  }

  async function snapshotDeadLetterRow(): Promise<{ replayCount: number; payload: Record<string, unknown> }> {
    const [row] = await dataSource.query(
      `SELECT replay_count, payload FROM dead_letter_event WHERE id = $1`,
      [deadLetterId],
    ) as Array<{ replay_count: number; payload: Record<string, unknown> }>;
    return { replayCount: Number(row.replay_count), payload: row.payload };
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

    tenantId = (await dataSource.getRepository(TenantEntity).save({ name: `dlq-api-${randomUUID()}` })).id;
    otherTenantId = (await dataSource.getRepository(TenantEntity).save({ name: `dlq-api-other-${randomUUID()}` })).id;
    const passwordHash = await hashPassword(password);
    const adminEmail = `dlq-admin-${randomUUID()}@test.dev`;
    const operatorEmail = `dlq-operator-${randomUUID()}@test.dev`;
    const otherAdminEmail = `dlq-other-admin-${randomUUID()}@test.dev`;
    adminUserId = (await dataSource.getRepository(AppUserEntity).save({ tenantId, email: adminEmail, displayName: 'DLQ Admin', role: 'admin', passwordHash, status: 'active' })).id;
    operatorUserId = (await dataSource.getRepository(AppUserEntity).save({ tenantId, email: operatorEmail, displayName: 'DLQ Operator', role: 'operator', passwordHash, status: 'active' })).id;
    otherAdminUserId = (await dataSource.getRepository(AppUserEntity).save({ tenantId: otherTenantId, email: otherAdminEmail, displayName: 'Other DLQ Admin', role: 'admin', passwordHash, status: 'active' })).id;

    const aggregateId = randomUUID();
    const [outboxEvent] = await dataSource.query(
      `INSERT INTO outbox_event
       (tenant_id, event_type, aggregate_type, aggregate_id, aggregate_version, payload, attempts, dead_lettered_at, last_error)
       VALUES ($1, 'import.job.created', 'import_job', $2, 0, $3::jsonb, 5, now(), 'poison queue payload')
       RETURNING id`,
      [tenantId, aggregateId, JSON.stringify({ jobId: aggregateId, tenantId })],
    ) as Array<{ id: string }>;
    outboxEventId = outboxEvent.id;
    const [deadLetterEvent] = await dataSource.query(
      `INSERT INTO dead_letter_event
       (tenant_id, source, event_id, event_type, aggregate_type, aggregate_id, payload, attempts, last_error)
       SELECT tenant_id, 'outbox', id, event_type, aggregate_type, aggregate_id, payload, attempts, last_error
       FROM outbox_event WHERE id = $1 RETURNING id`,
      [outboxEventId],
    ) as Array<{ id: string }>;
    deadLetterId = deadLetterEvent.id;

    admin = await login(adminEmail);
    operator = await login(operatorEmail);
    otherAdmin = await login(otherAdminEmail);
  }, 30_000);

  afterAll(async () => {
    await dataSource.query('DELETE FROM idempotency_key WHERE tenant_id = ANY($1::uuid[])', [[tenantId, otherTenantId]]);
    await dataSource.query('DELETE FROM dead_letter_event WHERE id = $1', [deadLetterId]);
    await dataSource.query('DELETE FROM outbox_event WHERE id = $1', [outboxEventId]);
    await dataSource.getRepository(UserSessionEntity).delete({ tenantId });
    await dataSource.getRepository(UserSessionEntity).delete({ tenantId: otherTenantId });
    await dataSource.getRepository(AppUserEntity).delete({ id: adminUserId });
    await dataSource.getRepository(AppUserEntity).delete({ id: operatorUserId });
    await dataSource.getRepository(AppUserEntity).delete({ id: otherAdminUserId });
    await app.close();
  }, 30_000);

  it('TC-SEC-007: an admin can list and inspect dead-lettered events for its own tenant only', async () => {
    const list = await request(app.getHttpServer()).get('/api/v1/dead-letter-events').set('Cookie', admin.cookie).expect(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].eventType).toBe('import.job.created');

    const detail = await request(app.getHttpServer()).get(`/api/v1/dead-letter-events/${deadLetterId}`).set('Cookie', admin.cookie).expect(200);
    expect(detail.body.id).toBe(deadLetterId);
    expect(detail.body.lastError).toContain('poison queue payload');

    const other = await request(app.getHttpServer()).get('/api/v1/dead-letter-events').set('Cookie', otherAdmin.cookie).expect(200);
    expect(other.body.items).toHaveLength(0);
  }, 30_000);

  it('TC-SEC-007 cross-tenant: detail and replay do not expose another tenant event', async () => {
    await request(app.getHttpServer()).get(`/api/v1/dead-letter-events/${deadLetterId}`).set('Cookie', otherAdmin.cookie).expect(404);
    await request(app.getHttpServer()).post(`/api/v1/dead-letter-events/${deadLetterId}/replay`)
      .set('Cookie', otherAdmin.cookie).set('x-csrf-token', otherAdmin.csrfToken)
      .set('Idempotency-Key', randomUUID()).expect(404);
  }, 30_000);

  it('TC-SEC-007: an operator without dlq:manage is refused', async () => {
    await request(app.getHttpServer()).get('/api/v1/dead-letter-events').set('Cookie', operator.cookie).expect(403);
  }, 30_000);

  it('TC-SEC-010: replaying once produces exactly one downstream relay effect', async () => {
    const before = await countDownstreamEffect();
    await request(app.getHttpServer()).post(`/api/v1/dead-letter-events/${deadLetterId}/replay`)
      .set('Cookie', admin.cookie).set('x-csrf-token', admin.csrfToken)
      .set('Idempotency-Key', replayKey).expect(202);
    expect(await countDownstreamEffect()).toBe(before + 1);
  }, 30_000);

  it('TC-SEC-010: replaying with the same and a fresh key creates no second downstream effect', async () => {
    const before = await countDownstreamEffect();
    const state = await snapshotDeadLetterRow();

    await request(app.getHttpServer()).post(`/api/v1/dead-letter-events/${deadLetterId}/replay`)
      .set('Cookie', admin.cookie).set('x-csrf-token', admin.csrfToken)
      .set('Idempotency-Key', replayKey).expect(202);
    expect(await countDownstreamEffect()).toBe(before);

    await request(app.getHttpServer()).post(`/api/v1/dead-letter-events/${deadLetterId}/replay`)
      .set('Cookie', admin.cookie).set('x-csrf-token', admin.csrfToken)
      .set('Idempotency-Key', randomUUID()).expect(202);
    expect(await countDownstreamEffect()).toBe(before);

    const after = await snapshotDeadLetterRow();
    expect(after.replayCount).toBeGreaterThan(state.replayCount);
    expect(after.payload).toEqual(state.payload);
  }, 60_000);

  it('TC-SEC-007: every replay writes an audit row naming the actor', async () => {
    const audit = await dataSource.query(
      `SELECT actor_id, action, entity_id FROM audit_log
       WHERE tenant_id = $1 AND action = 'dead_letter.replayed' ORDER BY occurred_at`,
      [tenantId],
    ) as Array<{ actor_id: string; action: string; entity_id: string }>;
    expect(audit.length).toBeGreaterThanOrEqual(1);
    expect(audit[0].actor_id).toBe(adminUserId);
    expect(audit[0].entity_id).toBe(deadLetterId);
  }, 30_000);
});
