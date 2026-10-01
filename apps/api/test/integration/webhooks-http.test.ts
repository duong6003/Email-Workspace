import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { HttpExceptionFilter } from '../../src/common/http-exception.filter.js';
import { JSON_BODY_LIMIT_BYTES } from '../../src/common/http-body-limit.js';
import { TenantEntity } from '../../src/database/entities/tenant.entity.js';
import { testDatabaseUrl } from './test-database-url.js';
import { testRedisUrl } from './test-redis-url.js';

const WEBHOOK_SECRET = 'a'.repeat(32);

function sign(rawBody: string, secret: string, timestampSeconds: number): string {
  const digest = createHmac('sha256', secret).update(`${timestampSeconds}.${rawBody}`).digest('hex');
  return `t=${timestampSeconds},v1=${digest}`;
}

/**
 * M5-S4 CP3 (BR-SEND-008 signature verification, D-109). Only the route's
 * negative space and its raw-body wiring -- the actual verify/parse/apply
 * algorithm (SS3.4) is CP4's. Every negative case here asserts not just the
 * status code but that zero delivery_event rows exist and the fixture
 * recipient's status is untouched, because "returns 401" is not the rule,
 * "returns 401 and writes no state" is (BR-SEND-008's own acceptance text).
 */
describe('Provider webhook HTTP (M5-S4 CP3/CP4: signature verification + apply, D-109/D-110)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let tenant: TenantEntity;
  let campaignId: string;
  let snapshotId: string;
  let executionId: string;
  let campaignRecipientId: string;
  let providerMessageId: string;
  const publishedEvents: Array<{ aggregate_id?: unknown; data?: unknown }> = [];

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl();
    process.env.REDIS_URL = testRedisUrl();
    process.env.SESSION_SECRET = 'a'.repeat(64);
    process.env.WEB_ORIGIN = 'http://localhost:5173';
    process.env.PROVIDER_WEBHOOK_SECRET = WEBHOOK_SECRET;
    const { AppModule } = await import('../../src/app.module.js');
    const { RedisCampaignPublisher } = await import('../../src/realtime/redis-campaign-publisher.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      // M6-S1 CP8 (A13): a capturing publisher, not a real Redis round trip --
      // the relay mechanism itself (Redis -> gateway -> room) is already
      // proven by realtime-campaign.test.ts (CP7) and
      // redis-campaign-event-publisher.test.ts; this suite only needs to
      // prove WebhooksService calls publish() exactly when BR-SEND-008's own
      // apply outcome is 'applied', with the right payload, after commit.
      .overrideProvider(RedisCampaignPublisher)
      .useValue({ publish: async (event: { aggregate_id?: unknown; data?: unknown }) => { publishedEvents.push(event); } })
      .compile();
    // D-109: rawBody: true is the app-construction option this route's
    // signature verification depends on -- must match main.ts's own
    // NestFactory.create(AppModule, { rawBody: true }) exactly, or this test
    // proves nothing about the production wiring (R1).
    app = moduleRef.createNestApplication({ rawBody: true });
    app.setGlobalPrefix('api/v1');
    // Matches main.ts's own global limit (16 MiB) so A16's oversize case
    // exercises this route's own tighter WEBHOOK_BODY_LIMIT_BYTES check
    // (1 MiB) rather than accidentally tripping express.json()'s much
    // smaller 100kb default -- no other integration test file configures
    // this, so a payload sized between those two ceilings would otherwise
    // "pass" 413 for the wrong reason regardless of whether this route's own
    // check exists.
    app.useBodyParser('json', { limit: JSON_BODY_LIMIT_BYTES });
    app.use(cookieParser());
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
    dataSource = moduleRef.get(getDataSourceToken());
    tenant = await dataSource.getRepository(TenantEntity).save({ name: `webhooks-http-${randomUUID()}` });

    const [template] = await dataSource.query(
      `INSERT INTO email_template (tenant_id, name, status) VALUES ($1, $2, 'published') RETURNING id`,
      [tenant.id, `webhooks-http-template-${randomUUID()}`],
    );
    const [version] = await dataSource.query(
      `INSERT INTO email_template_version (tenant_id, template_id, version, subject, html, text_body, variable_schema_json, content_hash, published_at)
       VALUES ($1, $2, 1, 'subject', '<p>body</p>', 'body', '{"required":[],"optional":[]}'::jsonb, repeat('a', 64), now()) RETURNING id`,
      [tenant.id, template.id],
    );
    const [campaign] = await dataSource.query(
      `INSERT INTO campaign (tenant_id, name, status, template_version_id) VALUES ($1, $2, 'sending', $3) RETURNING id`,
      [tenant.id, `webhooks-http-campaign-${randomUUID()}`, version.id],
    );
    campaignId = campaign.id;
    const [snapshot] = await dataSource.query(
      `INSERT INTO campaign_snapshot (tenant_id, campaign_id, template_version_id, sender_json, audience_query_json, policy_result_json)
       VALUES ($1, $2, $3, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb) RETURNING id`,
      [tenant.id, campaign.id, version.id],
    );
    snapshotId = snapshot.id;
    const [execution] = await dataSource.query(
      `INSERT INTO campaign_execution (tenant_id, campaign_id, snapshot_id, correlation_id) VALUES ($1, $2, $3, $4) RETURNING id`,
      [tenant.id, campaign.id, snapshot.id, `webhooks-http-${randomUUID()}`],
    );
    executionId = execution.id;
    const fixture = await insertRecipientAndAttempt();
    campaignRecipientId = fixture.campaignRecipientId;
    providerMessageId = fixture.providerMessageId;
  });

  /**
   * Every apply-side integration case (CP4) needs its own fresh recipient so
   * cases do not interfere with each other's status/delivery_state_at --
   * shares the one campaign/snapshot/execution the suite already froze.
   */
  async function insertRecipientAndAttempt(
    status: 'pending' | 'queued' | 'submitted' | 'delivered' | 'bounced' | 'failed' | 'cancelled' = 'submitted',
  ): Promise<{ campaignRecipientId: string; recipientId: string; providerMessageId: string }> {
    const [recipient] = await dataSource.query(
      `INSERT INTO recipient (tenant_id, email) VALUES ($1, $2) RETURNING id`,
      [tenant.id, `webhooks-http-${randomUUID()}@example.test`],
    );
    const [campaignRecipient] = await dataSource.query(
      `INSERT INTO campaign_recipient (tenant_id, campaign_id, snapshot_id, recipient_id, merge_data_json, eligibility, status, execution_id)
       VALUES ($1, $2, $3, $4, '{}'::jsonb, 'sendable', $5, $6) RETURNING id`,
      [tenant.id, campaignId, snapshotId, recipient.id, status, executionId],
    );
    const providerMessageIdValue = `mid-webhooks-http-${randomUUID()}`;
    await dataSource.query(
      `INSERT INTO message_attempt (tenant_id, execution_id, campaign_recipient_id, attempt_no, outcome, provider_message_id, content_hash)
       VALUES ($1, $2, $3, 1, 'submitted', $4, repeat('a', 64))`,
      [tenant.id, executionId, campaignRecipient.id, providerMessageIdValue],
    );
    return { campaignRecipientId: campaignRecipient.id, recipientId: recipient.id, providerMessageId: providerMessageIdValue };
  }

  async function postWebhook(payload: Record<string, unknown>, options?: { secret?: string; timestampSeconds?: number; provider?: string }): Promise<request.Response> {
    const rawBody = JSON.stringify(payload);
    const timestampSeconds = options?.timestampSeconds ?? Math.floor(Date.now() / 1000);
    const header = sign(rawBody, options?.secret ?? WEBHOOK_SECRET, timestampSeconds);
    return request(app.getHttpServer())
      .post(`/api/v1/webhooks/providers/${options?.provider ?? 'smtp'}`)
      .set('Content-Type', 'application/json')
      .set('X-EOW-Signature', header)
      .send(rawBody);
  }

  afterAll(async () => {
    if (!dataSource) { await app?.close(); return; }
    delete process.env.PROVIDER_WEBHOOK_SECRET;
    await dataSource.query('DELETE FROM delivery_event WHERE tenant_id = $1', [tenant.id]);
    await dataSource.query('DELETE FROM message_attempt WHERE tenant_id = $1', [tenant.id]);
    await dataSource.query('DELETE FROM campaign_execution WHERE tenant_id = $1', [tenant.id]);
    await dataSource.transaction(async (manager) => {
      await manager.query("SELECT pg_advisory_xact_lock(hashtext('eow_webhooks_http_test_cleanup'))");
      await manager.query('ALTER TABLE campaign_recipient DISABLE TRIGGER campaign_recipient_snapshot_immutable_trigger');
      await manager.query('ALTER TABLE campaign_snapshot DISABLE TRIGGER campaign_snapshot_immutable_trigger');
      await manager.query('ALTER TABLE email_template_version DISABLE TRIGGER email_template_version_immutable_trigger');
      // A9/A10's suppression cases write audit_log rows via suppressRecipient();
      // that table carries the same immutability trigger campaign_snapshot does.
      await manager.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_immutable');
      try {
        await manager.query('DELETE FROM audit_log WHERE tenant_id = $1', [tenant.id]);
        await manager.query('DELETE FROM campaign_recipient WHERE tenant_id = $1', [tenant.id]);
        await manager.query('DELETE FROM campaign_snapshot WHERE tenant_id = $1', [tenant.id]);
        await manager.query('DELETE FROM campaign WHERE tenant_id = $1', [tenant.id]);
        await manager.query('DELETE FROM email_template_version WHERE tenant_id = $1', [tenant.id]);
      } finally {
        await manager.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_immutable');
        await manager.query('ALTER TABLE email_template_version ENABLE TRIGGER email_template_version_immutable_trigger');
        await manager.query('ALTER TABLE campaign_snapshot ENABLE TRIGGER campaign_snapshot_immutable_trigger');
        await manager.query('ALTER TABLE campaign_recipient ENABLE TRIGGER campaign_recipient_snapshot_immutable_trigger');
      }
    });
    await dataSource.query('DELETE FROM email_template WHERE tenant_id = $1', [tenant.id]);
    await dataSource.query('DELETE FROM recipient WHERE tenant_id = $1', [tenant.id]);
    await dataSource.getRepository(TenantEntity).delete(tenant.id);
    await dataSource.destroy();
    await app?.close();
  });

  /**
   * Scoped to the suite's one shared fixture (campaignRecipientId), not a
   * tenant-wide zero-rows check: CP4's own apply-path tests share this
   * tenant and legitimately write delivery_event rows against their own,
   * separately-created fixtures. What must stay untouched by every
   * negative-space (CP3) case is specifically the shared fixture.
   */
  async function assertNoStateChanged(): Promise<void> {
    const events = await dataSource.query('SELECT id FROM delivery_event WHERE tenant_id = $1 AND campaign_recipient_id = $2', [tenant.id, campaignRecipientId]);
    expect(events).toHaveLength(0);
    const [row] = await dataSource.query('SELECT status FROM campaign_recipient WHERE id = $1', [campaignRecipientId]);
    expect(row.status).toBe('submitted');
  }

  it('R1/D-109: the route receives the exact raw request body bytes, not a re-parsed object', async () => {
    // Its own fixture, not the shared campaignRecipientId: this case applies
    // for real, which would otherwise poison every later negative-space
    // test's assertNoStateChanged() (those all assert the *shared* fixture
    // stays 'submitted').
    const fixture = await insertRecipientAndAttempt();
    // Deliberately includes a non-ASCII character and specific key order:
    // re-serialising this via JSON.stringify(JSON.parse(rawBody)) would very
    // likely produce different bytes (different unicode escaping), so a
    // literal-bytes match through req.rawBody is the only way this signature
    // can verify. Now that CP4's apply logic is real, a successful verify
    // against a submitted recipient's own providerMessageId applies for
    // real -- 200 {status:'applied'} is proof the exact literal bytes reached
    // the handler and both verified AND parsed correctly (the JSON parser
    // must also tolerate the "note" key it does not itself use).
    const rawBody = `{"id":"evt-raw-1","type":"delivered","messageId":"${fixture.providerMessageId}","note":"café","occurredAt":"2026-08-18T09:30:00.000Z"}`;
    const timestamp = Math.floor(Date.now() / 1000);
    const header = sign(rawBody, WEBHOOK_SECRET, timestamp);

    const response = await request(app.getHttpServer())
      .post('/api/v1/webhooks/providers/smtp')
      .set('Content-Type', 'application/json')
      .set('X-EOW-Signature', header)
      .send(rawBody);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'applied', eventId: 'evt-raw-1' });
    const [row] = await dataSource.query('SELECT status FROM campaign_recipient WHERE id = $1', [fixture.campaignRecipientId]);
    expect(row.status).toBe('delivered');
  });

  it('A6: rejects a missing signature header with 400 and writes no state', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/webhooks/providers/smtp')
      .set('Content-Type', 'application/json')
      .send('{"id":"evt-missing-sig"}');
    expect(response.status).toBe(400);
    await assertNoStateChanged();
  });

  it('A6: rejects a malformed signature header with 400 and writes no state', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/webhooks/providers/smtp')
      .set('Content-Type', 'application/json')
      .set('X-EOW-Signature', 'not-a-valid-signature-header')
      .send('{"id":"evt-malformed-sig"}');
    expect(response.status).toBe(400);
    await assertNoStateChanged();
  });

  it('A6: rejects an expired timestamp with 401 and writes no state', async () => {
    const rawBody = '{"id":"evt-expired"}';
    const staleTimestamp = Math.floor(Date.now() / 1000) - 301;
    const header = sign(rawBody, WEBHOOK_SECRET, staleTimestamp);
    const response = await request(app.getHttpServer())
      .post('/api/v1/webhooks/providers/smtp')
      .set('Content-Type', 'application/json')
      .set('X-EOW-Signature', header)
      .send(rawBody);
    expect(response.status).toBe(401);
    await assertNoStateChanged();
  });

  it('A4: rejects a signature computed with the wrong secret with 401 and writes no state', async () => {
    const rawBody = '{"id":"evt-forged"}';
    const timestamp = Math.floor(Date.now() / 1000);
    const header = sign(rawBody, 'wrong-secret-wrong-secret-wrong', timestamp);
    const response = await request(app.getHttpServer())
      .post('/api/v1/webhooks/providers/smtp')
      .set('Content-Type', 'application/json')
      .set('X-EOW-Signature', header)
      .send(rawBody);
    expect(response.status).toBe(401);
    await assertNoStateChanged();
  });

  it('A5: rejects a tampered body signed under the original bytes with 401 and writes no state', async () => {
    const originalBody = '{"id":"evt-tamper","type":"delivered"}';
    const tamperedBody = '{"id":"evt-tamper","type":"bounced"}';
    const timestamp = Math.floor(Date.now() / 1000);
    const header = sign(originalBody, WEBHOOK_SECRET, timestamp);
    const response = await request(app.getHttpServer())
      .post('/api/v1/webhooks/providers/smtp')
      .set('Content-Type', 'application/json')
      .set('X-EOW-Signature', header)
      .send(tamperedBody);
    expect(response.status).toBe(401);
    await assertNoStateChanged();
  });

  it('rejects an unknown provider with 404 and writes no state', async () => {
    const rawBody = '{"id":"evt-unknown-provider"}';
    const timestamp = Math.floor(Date.now() / 1000);
    const header = sign(rawBody, WEBHOOK_SECRET, timestamp);
    const response = await request(app.getHttpServer())
      .post('/api/v1/webhooks/providers/bogus-provider')
      .set('Content-Type', 'application/json')
      .set('X-EOW-Signature', header)
      .send(rawBody);
    expect(response.status).toBe(404);
    await assertNoStateChanged();
  });

  it('A16: rejects a body over the webhook size limit with 413 and writes no state', async () => {
    const oversizedPayload = JSON.stringify({ id: 'evt-oversize', padding: 'x'.repeat(2 * 1024 * 1024) });
    const timestamp = Math.floor(Date.now() / 1000);
    const header = sign(oversizedPayload, WEBHOOK_SECRET, timestamp);
    const response = await request(app.getHttpServer())
      .post('/api/v1/webhooks/providers/smtp')
      .set('Content-Type', 'application/json')
      .set('X-EOW-Signature', header)
      .send(oversizedPayload);
    expect(response.status).toBe(413);
    await assertNoStateChanged();
  });

  it('A15: with the signing secret unset, returns 503 and writes no state, never accepting an unverified event', async () => {
    delete process.env.PROVIDER_WEBHOOK_SECRET;
    try {
      const rawBody = '{"id":"evt-no-secret"}';
      const timestamp = Math.floor(Date.now() / 1000);
      const header = sign(rawBody, WEBHOOK_SECRET, timestamp);
      const response = await request(app.getHttpServer())
        .post('/api/v1/webhooks/providers/smtp')
        .set('Content-Type', 'application/json')
        .set('X-EOW-Signature', header)
        .send(rawBody);
      expect(response.status).toBe(503);
      await assertNoStateChanged();
    } finally {
      process.env.PROVIDER_WEBHOOK_SECRET = WEBHOOK_SECRET;
    }
  });

  it('A17: no error response body contains the configured webhook secret', async () => {
    const rawBody = '{"id":"evt-secret-leak-check"}';
    const timestamp = Math.floor(Date.now() / 1000);
    const header = sign(rawBody, 'wrong-secret-wrong-secret-wrong', timestamp);
    const response = await request(app.getHttpServer())
      .post('/api/v1/webhooks/providers/smtp')
      .set('Content-Type', 'application/json')
      .set('X-EOW-Signature', header)
      .send(rawBody);
    expect(JSON.stringify(response.body)).not.toContain(WEBHOOK_SECRET);
  });

  it('A2: a delivered event for a submitted recipient applies -- status=delivered, delivery_state_at set, exactly one applied delivery_event row', async () => {
    const fixture = await insertRecipientAndAttempt();
    const occurredAt = '2026-08-18T09:00:00.000Z';
    const eventId = `evt-a2-${randomUUID()}`;
    const response = await postWebhook({ id: eventId, type: 'delivered', messageId: fixture.providerMessageId, occurredAt });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'applied', eventId });
    const [row] = await dataSource.query('SELECT status, delivery_state_at FROM campaign_recipient WHERE id = $1', [fixture.campaignRecipientId]);
    expect(row.status).toBe('delivered');
    expect(new Date(row.delivery_state_at).toISOString()).toBe(occurredAt);
    const events = await dataSource.query('SELECT outcome FROM delivery_event WHERE tenant_id = $1 AND campaign_recipient_id = $2', [tenant.id, fixture.campaignRecipientId]);
    expect(events).toEqual([{ outcome: 'applied' }]);
  });

  it('M6-S1 CP8 (A13): an applied delivered event publishes exactly one campaign.progress carrying the campaign id and an incremented delivered count', async () => {
    const fixture = await insertRecipientAndAttempt();
    const beforeCount = publishedEvents.length;

    const eventId = `evt-cp8-a13-${randomUUID()}`;
    const response = await postWebhook({ id: eventId, type: 'delivered', messageId: fixture.providerMessageId, occurredAt: '2026-08-18T09:05:00.000Z' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'applied', eventId });
    const newEvents = publishedEvents.slice(beforeCount);
    expect(newEvents).toHaveLength(1);
    expect(newEvents[0].aggregate_id).toBe(campaignId);
    expect((newEvents[0].data as { counts: { delivered: number } }).counts.delivered).toBeGreaterThanOrEqual(1);
  });

  it('M6-S1 CP8 (A13): a rejected (unmatched) event publishes nothing', async () => {
    const beforeCount = publishedEvents.length;

    const response = await postWebhook({ id: `evt-cp8-a13-unmatched-${randomUUID()}`, type: 'delivered', messageId: `mid-unknown-${randomUUID()}`, occurredAt: '2026-08-18T09:06:00.000Z' });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('unmatched');
    expect(publishedEvents.slice(beforeCount)).toHaveLength(0);
  });

  it('M6-S1 CP8 (A13): a duplicate replay publishes nothing a second time', async () => {
    const fixture = await insertRecipientAndAttempt();
    const eventId = `evt-cp8-a13-dup-${randomUUID()}`;
    await postWebhook({ id: eventId, type: 'delivered', messageId: fixture.providerMessageId, occurredAt: '2026-08-18T09:07:00.000Z' });
    const beforeCount = publishedEvents.length;

    const replay = await postWebhook({ id: eventId, type: 'delivered', messageId: fixture.providerMessageId, occurredAt: '2026-08-18T09:07:00.000Z' });

    expect(replay.body.status).toBe('duplicate');
    expect(publishedEvents.slice(beforeCount)).toHaveLength(0);
  });

  it('A9: a bounced event applies -- status=bounced, and atomically suppresses the underlying recipient (hard_bounce)', async () => {
    const fixture = await insertRecipientAndAttempt();
    const eventId = `evt-a9-${randomUUID()}`;
    const response = await postWebhook({ id: eventId, type: 'bounced', messageId: fixture.providerMessageId, occurredAt: '2026-08-18T09:00:00.000Z' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'applied', eventId });
    const [row] = await dataSource.query('SELECT status FROM campaign_recipient WHERE id = $1', [fixture.campaignRecipientId]);
    expect(row.status).toBe('bounced');
    // The subscription_status -> skipped_reason='status_bounced' mapping
    // itself is proven by audience-resolution.test.ts; this asserts the
    // webhook path produces the same suppression fact the synchronous
    // hard-bounce path (send.ts) does, per DEC-105/DEC-107.
    const [recipientRow] = await dataSource.query(
      'SELECT subscription_status, suppression_reason, suppressed_at FROM recipient WHERE id = $1', [fixture.recipientId],
    );
    expect(recipientRow).toMatchObject({ subscription_status: 'bounced', suppression_reason: 'hard_bounce' });
    expect(recipientRow.suppressed_at).not.toBeNull();
    const auditRows = await dataSource.query(
      `SELECT id FROM audit_log WHERE tenant_id = $1 AND action = 'recipient.suppressed' AND entity_id = $2`, [tenant.id, fixture.recipientId],
    );
    expect(auditRows).toHaveLength(1);
  });

  it('A10: a complaint event suppresses with reason=complaint and leaves the message status untouched; a second complaint writes no second audit row', async () => {
    const fixture = await insertRecipientAndAttempt();
    const firstEventId = `evt-a10-1-${randomUUID()}`;
    const first = await postWebhook({ id: firstEventId, type: 'complaint', messageId: fixture.providerMessageId, occurredAt: '2026-08-18T09:00:00.000Z' });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ status: 'applied', eventId: firstEventId });

    const [row] = await dataSource.query('SELECT status FROM campaign_recipient WHERE id = $1', [fixture.campaignRecipientId]);
    expect(row.status).toBe('submitted');
    const [recipientRow] = await dataSource.query(
      'SELECT subscription_status, suppression_reason FROM recipient WHERE id = $1', [fixture.recipientId],
    );
    expect(recipientRow).toMatchObject({ subscription_status: 'bounced', suppression_reason: 'complaint' });

    const secondEventId = `evt-a10-2-${randomUUID()}`;
    const second = await postWebhook({ id: secondEventId, type: 'complaint', messageId: fixture.providerMessageId, occurredAt: '2026-08-18T09:05:00.000Z' });
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ status: 'applied', eventId: secondEventId });
    const auditRows = await dataSource.query(
      `SELECT id FROM audit_log WHERE tenant_id = $1 AND action = 'recipient.suppressed' AND entity_id = $2`, [tenant.id, fixture.recipientId],
    );
    expect(auditRows).toHaveLength(1);
    const [afterSecond] = await dataSource.query('SELECT suppression_reason FROM recipient WHERE id = $1', [fixture.recipientId]);
    expect(afterSecond.suppression_reason).toBe('complaint');
  });

  it('A3: replaying the identical event id returns duplicate, leaves exactly one delivery_event row, and the count stays at exactly one delivered', async () => {
    const fixture = await insertRecipientAndAttempt();
    const eventId = `evt-a3-${randomUUID()}`;
    const payload = { id: eventId, type: 'delivered', messageId: fixture.providerMessageId, occurredAt: '2026-08-18T09:00:00.000Z' };

    const first = await postWebhook(payload);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ status: 'applied', eventId });

    const replay = await postWebhook(payload);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ status: 'duplicate', eventId });

    const events = await dataSource.query('SELECT id FROM delivery_event WHERE tenant_id = $1 AND campaign_recipient_id = $2', [tenant.id, fixture.campaignRecipientId]);
    expect(events).toHaveLength(1);
    const deliveredCount = await dataSource.query(
      `SELECT count(*)::int AS n FROM campaign_recipient WHERE tenant_id = $1 AND id = $2 AND status = 'delivered'`, [tenant.id, fixture.campaignRecipientId],
    );
    expect(deliveredCount[0].n).toBe(1);
  });

  it('A7/D-110: a delivered event older than an already-applied bounced event is ignored_out_of_order and changes nothing', async () => {
    const fixture = await insertRecipientAndAttempt();
    const bounceEventId = `evt-a7-bounce-${randomUUID()}`;
    const bounceAt = '2026-08-18T09:00:00.000Z';
    const bounceResponse = await postWebhook({ id: bounceEventId, type: 'bounced', messageId: fixture.providerMessageId, occurredAt: bounceAt });
    expect(bounceResponse.body).toEqual({ status: 'applied', eventId: bounceEventId });

    const [beforeStale] = await dataSource.query('SELECT status, delivery_state_at FROM campaign_recipient WHERE id = $1', [fixture.campaignRecipientId]);

    const staleEventId = `evt-a7-stale-${randomUUID()}`;
    const staleResponse = await postWebhook({ id: staleEventId, type: 'delivered', messageId: fixture.providerMessageId, occurredAt: '2026-08-18T08:00:00.000Z' });
    expect(staleResponse.status).toBe(200);
    expect(staleResponse.body).toEqual({ status: 'ignored', eventId: staleEventId });

    const [afterStale] = await dataSource.query('SELECT status, delivery_state_at FROM campaign_recipient WHERE id = $1', [fixture.campaignRecipientId]);
    expect(afterStale).toEqual(beforeStale);
    const staleEvent = await dataSource.query(
      `SELECT outcome FROM delivery_event WHERE tenant_id = $1 AND provider = 'smtp' AND provider_event_id = $2`, [tenant.id, staleEventId],
    );
    expect(staleEvent).toEqual([{ outcome: 'ignored_out_of_order' }]);
  });

  it('A8: a delivered event for a failed recipient is ignored_illegal_transition and changes nothing', async () => {
    const fixture = await insertRecipientAndAttempt('failed');
    const eventId = `evt-a8-failed-${randomUUID()}`;
    const response = await postWebhook({ id: eventId, type: 'delivered', messageId: fixture.providerMessageId, occurredAt: '2026-08-18T09:00:00.000Z' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ignored', eventId });
    const [row] = await dataSource.query('SELECT status FROM campaign_recipient WHERE id = $1', [fixture.campaignRecipientId]);
    expect(row.status).toBe('failed');
    const event = await dataSource.query(
      `SELECT outcome FROM delivery_event WHERE tenant_id = $1 AND provider = 'smtp' AND provider_event_id = $2`, [tenant.id, eventId],
    );
    expect(event).toEqual([{ outcome: 'ignored_illegal_transition' }]);
  });

  it('A8: a delivered event for a pending recipient is ignored_illegal_transition and changes nothing', async () => {
    const fixture = await insertRecipientAndAttempt('pending');
    const eventId = `evt-a8-pending-${randomUUID()}`;
    const response = await postWebhook({ id: eventId, type: 'delivered', messageId: fixture.providerMessageId, occurredAt: '2026-08-18T09:00:00.000Z' });
    expect(response.body).toEqual({ status: 'ignored', eventId });
    const [row] = await dataSource.query('SELECT status FROM campaign_recipient WHERE id = $1', [fixture.campaignRecipientId]);
    expect(row.status).toBe('pending');
  });

  it('A8: a delivered event for an already-bounced recipient (timestamp not stale) is ignored_illegal_transition, not out-of-order', async () => {
    const fixture = await insertRecipientAndAttempt();
    const bounceEventId = `evt-a8-bounce-${randomUUID()}`;
    await postWebhook({ id: bounceEventId, type: 'bounced', messageId: fixture.providerMessageId, occurredAt: '2026-08-18T09:00:00.000Z' });

    // D-110: this event is *newer* than the bounce's own delivery_state_at,
    // so it is not stale -- the illegal-transition check is what must catch
    // it, proving the two guards are genuinely independent, not just the
    // ordering guard doing all the work.
    const laterEventId = `evt-a8-later-${randomUUID()}`;
    const response = await postWebhook({ id: laterEventId, type: 'delivered', messageId: fixture.providerMessageId, occurredAt: '2026-08-18T10:00:00.000Z' });
    expect(response.body).toEqual({ status: 'ignored', eventId: laterEventId });
    const [row] = await dataSource.query('SELECT status FROM campaign_recipient WHERE id = $1', [fixture.campaignRecipientId]);
    expect(row.status).toBe('bounced');
    const event = await dataSource.query(
      `SELECT outcome FROM delivery_event WHERE tenant_id = $1 AND provider = 'smtp' AND provider_event_id = $2`, [tenant.id, laterEventId],
    );
    expect(event).toEqual([{ outcome: 'ignored_illegal_transition' }]);
  });

  it('DEC-111: an event whose providerMessageId matches no message_attempt row is unmatched and writes zero rows anywhere', async () => {
    const eventId = `evt-unmatched-${randomUUID()}`;
    const response = await postWebhook({ id: eventId, type: 'delivered', messageId: `mid-does-not-exist-${randomUUID()}`, occurredAt: '2026-08-18T09:00:00.000Z' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'unmatched', eventId });
    // Asserting no row for *this event's own id* specifically, rather than
    // zero total delivery_event rows for the tenant -- other tests in this
    // file share the same tenant and legitimately have their own rows.
    const thisEvent = await dataSource.query(
      `SELECT id FROM delivery_event WHERE tenant_id = $1 AND provider_event_id = $2`, [tenant.id, eventId],
    );
    expect(thisEvent).toHaveLength(0);
  });

  it('D-107: a provider_message_id shared by two distinct recipients (ambiguous) is unmatched and writes zero rows', async () => {
    const sharedProviderMessageId = `mid-ambiguous-${randomUUID()}`;
    const [recipientA] = await dataSource.query(`INSERT INTO recipient (tenant_id, email) VALUES ($1, $2) RETURNING id`, [tenant.id, `webhooks-http-amb-a-${randomUUID()}@example.test`]);
    const [recipientB] = await dataSource.query(`INSERT INTO recipient (tenant_id, email) VALUES ($1, $2) RETURNING id`, [tenant.id, `webhooks-http-amb-b-${randomUUID()}@example.test`]);
    for (const recipient of [recipientA, recipientB]) {
      const [cr] = await dataSource.query(
        `INSERT INTO campaign_recipient (tenant_id, campaign_id, snapshot_id, recipient_id, merge_data_json, eligibility, status, execution_id)
         VALUES ($1, $2, $3, $4, '{}'::jsonb, 'sendable', 'submitted', $5) RETURNING id`,
        [tenant.id, campaignId, snapshotId, recipient.id, executionId],
      );
      await dataSource.query(
        `INSERT INTO message_attempt (tenant_id, execution_id, campaign_recipient_id, attempt_no, outcome, provider_message_id, content_hash)
         VALUES ($1, $2, $3, 1, 'submitted', $4, repeat('a', 64))`,
        [tenant.id, executionId, cr.id, sharedProviderMessageId],
      );
    }
    const eventId = `evt-ambiguous-${randomUUID()}`;
    const response = await postWebhook({ id: eventId, type: 'delivered', messageId: sharedProviderMessageId, occurredAt: '2026-08-18T09:00:00.000Z' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'unmatched', eventId });
    const thisEvent = await dataSource.query(`SELECT id FROM delivery_event WHERE tenant_id = $1 AND provider_event_id = $2`, [tenant.id, eventId]);
    expect(thisEvent).toHaveLength(0);
  });

  it('A12: hostile payload keys (tenantId/campaignRecipientId/status) are ignored entirely; the event applies only to the recipient the providerMessageId actually resolves to', async () => {
    const otherTenant = await dataSource.getRepository(TenantEntity).save({ name: `webhooks-http-hostile-${randomUUID()}` });
    try {
      const fixture = await insertRecipientAndAttempt();
      const eventId = `evt-hostile-${randomUUID()}`;
      const response = await postWebhook({
        id: eventId,
        type: 'delivered',
        messageId: fixture.providerMessageId,
        occurredAt: '2026-08-18T09:00:00.000Z',
        tenantId: otherTenant.id,
        campaignRecipientId: randomUUID(),
        status: 'delivered',
      });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ status: 'applied', eventId });

      const [row] = await dataSource.query('SELECT tenant_id, status FROM campaign_recipient WHERE id = $1', [fixture.campaignRecipientId]);
      expect(row.tenant_id).toBe(tenant.id);
      expect(row.status).toBe('delivered');
      const otherTenantEvents = await dataSource.query('SELECT id FROM delivery_event WHERE tenant_id = $1', [otherTenant.id]);
      expect(otherTenantEvents).toHaveLength(0);
    } finally {
      await dataSource.getRepository(TenantEntity).delete(otherTenant.id);
    }
  });

  it('A13: two genuinely concurrent POSTs of the same event id produce exactly one delivery_event row and one state change', async () => {
    const fixture = await insertRecipientAndAttempt();
    const eventId = `evt-concurrent-${randomUUID()}`;
    const payload = { id: eventId, type: 'delivered', messageId: fixture.providerMessageId, occurredAt: '2026-08-18T09:00:00.000Z' };

    const [first, second] = await Promise.all([postWebhook(payload), postWebhook(payload)]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 200]);
    const bodies = [first.body.status, second.body.status].sort();
    expect(bodies).toEqual(['applied', 'duplicate']);

    const events = await dataSource.query('SELECT id FROM delivery_event WHERE tenant_id = $1 AND campaign_recipient_id = $2', [tenant.id, fixture.campaignRecipientId]);
    expect(events).toHaveLength(1);
    const [row] = await dataSource.query('SELECT status FROM campaign_recipient WHERE id = $1', [fixture.campaignRecipientId]);
    expect(row.status).toBe('delivered');
  });
});
