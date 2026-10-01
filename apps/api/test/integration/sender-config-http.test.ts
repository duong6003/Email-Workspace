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
 * M5-GATE (TC-CFG-003, TC-CFG-007): both rules were `closed` in
 * traceability.csv on CP18's own one-time manual "live reproduction" --
 * confirmed by direct code read plus a single ad hoc HTTP/SQL check -- with
 * no automated test recorded and no `test_files` cell filled in. That is not
 * "executing" per this gate's own success condition. Real Mailpit is already
 * used for connection probes elsewhere (`visual-capture.spec.ts`'s
 * `verifyAndSetDefaultSender`); this file gives that same real probe a
 * repeatable home in the vitest suite.
 */
describe('Sender config HTTP (M5-GATE: TC-CFG-003, TC-CFG-007)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let tenant: TenantEntity;
  const password = 'correct-horse-battery-staple';
  const admin = `sender-cfg-http-admin-${randomUUID()}@test.dev`;

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl();
    process.env.REDIS_URL = testRedisUrl();
    process.env.SESSION_SECRET = 'a'.repeat(64);
    process.env.SENDER_CREDENTIAL_KEY = 'b'.repeat(64);
    process.env.WEB_ORIGIN = 'http://localhost:5173';
    const { AppModule } = await import('../../src/app.module.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
    dataSource = moduleRef.get(getDataSourceToken());
    tenant = await dataSource.getRepository(TenantEntity).save({ name: `sender-cfg-http-${randomUUID()}` });
    await dataSource.getRepository(AppUserEntity).save({
      tenantId: tenant.id, email: admin, displayName: 'Sender Config HTTP Admin', role: 'admin', passwordHash: await hashPassword(password), status: 'active',
    });
  }, 30_000);

  afterAll(async () => {
    if (!dataSource) { await app?.close(); return; }
    await dataSource.query('DELETE FROM user_notification WHERE tenant_id = $1', [tenant.id]);
    await dataSource.query('DELETE FROM notification WHERE tenant_id = $1', [tenant.id]);
    await dataSource.query('DELETE FROM sending_policy WHERE tenant_id = $1', [tenant.id]);
    await dataSource.query('DELETE FROM sender_credential WHERE tenant_id = $1', [tenant.id]);
    await dataSource.query('DELETE FROM sender_config WHERE tenant_id = $1', [tenant.id]);
    await dataSource.getRepository(UserSessionEntity).delete({ tenantId: tenant.id });
    await dataSource.getRepository(AppUserEntity).delete({ tenantId: tenant.id });
    await app.close();
  });

  async function login(): Promise<{ cookie: string; csrfToken: string }> {
    const response = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email: admin, password });
    const cookies = response.headers['set-cookie'] as unknown as string[];
    return {
      cookie: cookies.map((entry) => entry.split(';')[0]).join('; '),
      csrfToken: cookies.find((entry) => entry.startsWith('eow_csrf='))!.split(';')[0].split('=')[1],
    };
  }

  async function createSender(session: { cookie: string; csrfToken: string }, overrides: Partial<{ host: string; port: number; secret: string }> = {}) {
    const created = await request(app.getHttpServer()).post('/api/v1/sender-configs')
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken)
      .send({
        name: `sender-http-${randomUUID()}`, fromName: 'HTTP Test', fromEmail: `sender-http-${randomUUID()}@example.test`,
        host: overrides.host ?? '127.0.0.1', port: overrides.port ?? 1025, username: '', secret: overrides.secret ?? 'not-a-real-secret',
      });
    expect(created.status).toBe(201);
    expect(created.body.credentialConfigured).toBe(Boolean((overrides.secret ?? 'not-a-real-secret').length));
    return created.body.id as string;
  }

  it('persists all sender values and encrypted credentials for later reads', async () => {
    const session = await login();
    const secret = `durable-${randomUUID()}`;
    const created = await request(app.getHttpServer()).post('/api/v1/sender-configs')
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken)
      .send({
        name: 'SMTP Alta', fromName: 'Alta Operations', fromEmail: `alta-${randomUUID()}@example.test`, replyTo: 'reply@example.test',
        host: 'smtp.example.test', port: 587, username: 'noreply@example.test', secret,
      });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'SMTP Alta', fromName: 'Alta Operations', replyTo: 'reply@example.test', host: 'smtp.example.test', port: 587, username: 'noreply@example.test', credentialConfigured: true });

    const [credential] = await dataSource.query('SELECT ciphertext FROM sender_credential WHERE tenant_id = $1 AND secret_ref = (SELECT secret_ref FROM sender_config WHERE id = $2)', [tenant.id, created.body.id]);
    expect(credential.ciphertext).not.toContain(secret);
    const fetched = await request(app.getHttpServer()).get(`/api/v1/sender-configs/${created.body.id}`).set('Cookie', session.cookie);
    expect(fetched.body).toMatchObject({ name: 'SMTP Alta', fromName: 'Alta Operations', replyTo: 'reply@example.test', host: 'smtp.example.test', port: 587, username: 'noreply@example.test', credentialConfigured: true });
    expect(JSON.stringify(fetched.body)).not.toContain(secret);
  });

  it('TC-CFG-003: a real successful probe against Mailpit writes a finite-outcome audit row with no secret leaked', async () => {
    const session = await login();
    const senderId = await createSender(session);
    const secretValue = 'not-a-real-secret';

    const response = await request(app.getHttpServer()).post(`/api/v1/sender-configs/${senderId}/test-connection`)
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken)
      .set('Idempotency-Key', randomUUID()).send({});

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ ok: true, status: 'verified' });

    const rows = await dataSource.query(
      `SELECT metadata FROM audit_log WHERE tenant_id = $1 AND entity_id = $2 AND action = 'sender_config.connection_tested' ORDER BY occurred_at DESC LIMIT 1`,
      [tenant.id, senderId],
    ) as Array<{ metadata: Record<string, unknown> }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toMatchObject({ ok: true, code: 'OK' });
    expect(JSON.stringify(rows[0].metadata)).not.toContain(secretValue);

    const [row] = await dataSource.query('SELECT status FROM sender_config WHERE id = $1', [senderId]);
    expect(row.status).toBe('verified');
  });

  it('TC-CFG-003: a failed probe (unreachable host) writes a classified failure outcome with no secret leaked', async () => {
    const session = await login();
    const senderId = await createSender(session, { host: '127.0.0.1', port: 1 });
    const secretValue = 'not-a-real-secret';

    const response = await request(app.getHttpServer()).post(`/api/v1/sender-configs/${senderId}/test-connection`)
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken)
      .set('Idempotency-Key', randomUUID()).send({});

    expect(response.status).toBe(201);
    expect(response.body.ok).toBe(false);
    expect(typeof response.body.code).toBe('string');
    expect(typeof response.body.classification).toBe('string');

    const rows = await dataSource.query(
      `SELECT metadata FROM audit_log WHERE tenant_id = $1 AND entity_id = $2 AND action = 'sender_config.connection_tested' ORDER BY occurred_at DESC LIMIT 1`,
      [tenant.id, senderId],
    ) as Array<{ metadata: Record<string, unknown> }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata.ok).toBe(false);
    expect(rows[0].metadata.code).toBeDefined();
    expect(rows[0].metadata.classification).toBeDefined();
    expect(JSON.stringify(rows[0].metadata)).not.toContain(secretValue);

    const [row] = await dataSource.query('SELECT status FROM sender_config WHERE id = $1', [senderId]);
    expect(row.status).toBe('failed');
  });

  it('TC-CFG-007: disabling a sender writes an owner notification and the config remains visible in the list, not hidden', async () => {
    const session = await login();
    const senderId = await createSender(session);

    const response = await request(app.getHttpServer()).delete(`/api/v1/sender-configs/${senderId}`)
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken);

    expect(response.status).toBe(204);

    const [row] = await dataSource.query('SELECT status FROM sender_config WHERE id = $1', [senderId]);
    expect(row.status).toBe('disabled');

    const notifications = await dataSource.query(
      `SELECT n.type, n.severity FROM notification n
       JOIN user_notification un ON un.notification_id = n.id
       WHERE n.tenant_id = $1 AND n.entity_id = $2 AND n.type = 'sender_disabled'`,
      [tenant.id, senderId],
    ) as Array<{ type: string; severity: string }>;
    expect(notifications.length).toBeGreaterThan(0);

    const list = await request(app.getHttpServer()).get('/api/v1/sender-configs')
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken);
    expect(list.status).toBe(200);
    const items = (list.body as { items: Array<{ id: string; status: string }> }).items;
    const listedEntry = items.find((entry) => entry.id === senderId);
    expect(listedEntry?.status).toBe('disabled');
  });

  it('persists and returns every default sending policy field', async () => {
    const session = await login();
    const senderId = await createSender(session);
    await request(app.getHttpServer()).post(`/api/v1/sender-configs/${senderId}/test-connection`)
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken)
      .set('Idempotency-Key', randomUUID()).send({});

    const updated = await request(app.getHttpServer()).put('/api/v1/sending-policy')
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken)
      .send({
        defaultSenderConfigId: senderId,
        replyTo: 'reply-policy@example.test',
        batchSize: 240,
        maxAttempts: 7,
        tenantRateLimitPerMinute: 1_200,
        // ADR-036 scope item 3: the tenant default timezone for rendering typed
        // variables lives on this existing per-tenant settings row.
        defaultTimezone: 'Asia/Ho_Chi_Minh',
      });

    expect(updated.status).toBe(200);
    expect(updated.body).toEqual({
      defaultSenderConfigId: senderId,
      replyTo: 'reply-policy@example.test',
      batchSize: 240,
      maxAttempts: 7,
      tenantRateLimitPerMinute: 1_200,
      defaultTimezone: 'Asia/Ho_Chi_Minh',
    });
    const fetched = await request(app.getHttpServer()).get('/api/v1/sending-policy').set('Cookie', session.cookie);
    expect(fetched.body).toEqual(updated.body);
    const [row] = await dataSource.query('SELECT batch_size, max_attempts, tenant_rate_limit_per_minute, default_timezone FROM sending_policy WHERE tenant_id = $1', [tenant.id]);
    expect(row).toEqual({ batch_size: 240, max_attempts: 7, tenant_rate_limit_per_minute: 1200, default_timezone: 'Asia/Ho_Chi_Minh' });
  });

  it('refuses a default timezone Node cannot resolve rather than storing one nothing can render in', async () => {
    const session = await login(admin);

    const rejected = await request(app.getHttpServer()).put('/api/v1/sending-policy')
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken)
      .send({ defaultSenderConfigId: null, batchSize: 100, maxAttempts: 5, tenantRateLimitPerMinute: 600, defaultTimezone: 'Asia/Hanoi' });

    expect(rejected.status).toBe(400);
  });

  // A saved default sender can stop being usable long after it was chosen --
  // someone disables it, or a credential rotation fails verification. The
  // settings form resubmits every field including that stored id, so gating any
  // non-null value locked the whole screen: nothing could be saved, not even the
  // tenant timezone that shares this row. Resubmitting what the server supplied
  // is not the operator choosing an unusable sender.
  it('still saves the policy when the stored default sender is no longer verified', async () => {
    const session = await login();
    const senderId = await createSender(session);
    await request(app.getHttpServer()).post(`/api/v1/sender-configs/${senderId}/test-connection`)
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken)
      .set('Idempotency-Key', randomUUID()).send({});
    await request(app.getHttpServer()).put('/api/v1/sending-policy')
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken)
      .send({ defaultSenderConfigId: senderId, batchSize: 100, maxAttempts: 5, tenantRateLimitPerMinute: 600 })
      .expect(200);

    await request(app.getHttpServer()).delete(`/api/v1/sender-configs/${senderId}`)
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken)
      .expect(204);

    // Same id back, plus an unrelated field the operator actually wants changed.
    const resaved = await request(app.getHttpServer()).put('/api/v1/sending-policy')
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken)
      .send({ defaultSenderConfigId: senderId, batchSize: 175, maxAttempts: 5, tenantRateLimitPerMinute: 600 });

    expect(resaved.status).toBe(200);
    expect(resaved.body.batchSize).toBe(175);
  });

  it('still refuses to newly point the policy at a sender that is not verified', async () => {
    const session = await login();
    const unverified = await createSender(session);

    const rejected = await request(app.getHttpServer()).put('/api/v1/sending-policy')
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken)
      .send({ defaultSenderConfigId: unverified, batchSize: 100, maxAttempts: 5, tenantRateLimitPerMinute: 600 });

    expect(rejected.status).toBe(409);
    expect(rejected.body).toMatchObject({ code: 'SENDER_NOT_USABLE' });
  });
});
