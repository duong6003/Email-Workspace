import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { Redis } from 'ioredis';
import { encryptSenderSecret, parseSenderCredentialKey } from '@eow/sender-credentials';
import { sendClaimedBatch, type SmtpSendFn } from './send.js';
import type { ProgressEvent, ResyncEvent } from './progress-event.js';
import { purgeCampaignSendFixtures } from '../test-cleanup-helpers.js';
import { testAppDatabaseUrl, testOwnerDatabaseUrl, testRedisUrl } from '../test-urls.js';

const MAILPIT_API = 'http://127.0.0.1:8025';

async function messagesTo(email: string): Promise<Array<{ To: Array<{ Address: string }>; Subject: string }>> {
  const res = await fetch(`${MAILPIT_API}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`);
  const body = (await res.json()) as { messages: Array<{ To: Array<{ Address: string }>; Subject: string }> };
  return body.messages;
}

/**
 * M5-S3 CP4 (BR-SEND-006/011/012, A7/A8/A9/A10/A11/A17/A21). Real SMTP for
 * the success path (A7 -- arrival asserted at Mailpit's own HTTP API, not
 * the SMTP call's return value); an injected `sendFn` for provider outcomes
 * Mailpit itself never produces (permanent rejection, hard bounce) -- the
 * same seam EmailProviderAdapter/FakeProviderAdapter already uses in
 * apps/api for exactly this reason.
 */
describe('sendClaimedBatch (M5-S3 CP4)', () => {
  const pool = new pg.Pool({ connectionString: testOwnerDatabaseUrl() });
  let tenantId: string;
  let templateVersionId: string;

  beforeAll(async () => {
    // Host-run tests need the loopback port mapping (docker port: 1025/tcp
    // -> 127.0.0.1:1025), not the container-internal 'mailpit' hostname
    // apps/api's own SMTP_HOST config default resolves inside the compose
    // network only (same distinction test-urls.ts's own comment makes for
    // Postgres/Redis).
    process.env.SMTP_HOST = '127.0.0.1';
    process.env.SMTP_PORT = '1025';
    tenantId = (await pool.query<{ id: string }>('INSERT INTO tenant (name) VALUES ($1) RETURNING id', [`worker-send-${randomUUID()}`])).rows[0].id;
    const template = (await pool.query<{ id: string }>(
      `INSERT INTO email_template (tenant_id, name, status) VALUES ($1, $2, 'published') RETURNING id`,
      [tenantId, `send-template-${randomUUID()}`],
    )).rows[0];
    templateVersionId = (await pool.query<{ id: string }>(
      `INSERT INTO email_template_version (tenant_id, template_id, version, subject, html, text_body, variable_schema_json, content_hash, published_at)
       VALUES ($1, $2, 1, 'subject', '<p>body</p>', 'body', '{"required":[],"optional":[]}'::jsonb, repeat('2', 64), now()) RETURNING id`,
      [tenantId, template.id],
    )).rows[0].id;
  });

  afterAll(async () => {
    await purgeCampaignSendFixtures(pool, tenantId, 'eow_campaign_send_send_test_cleanup');
    await pool.query('DELETE FROM recipient WHERE tenant_id = $1', [tenantId]);
    await pool.query('DELETE FROM sender_config WHERE tenant_id = $1', [tenantId]);
    await pool.query('DELETE FROM email_template WHERE tenant_id = $1', [tenantId]);
    await pool.query('DELETE FROM tenant WHERE id = $1', [tenantId]);
    await pool.end();
  });

  async function fixture(opts: { toEmail: string; subject?: string; senderJson?: Record<string, unknown>; mergeData?: Record<string, unknown> }): Promise<{ campaignId: string; executionId: string; campaignRecipientId: string; recipientId: string }> {
    const campaign = (await pool.query<{ id: string }>(
      `INSERT INTO campaign (tenant_id, name, status, template_version_id, sender_json) VALUES ($1, $2, 'sending', $3, $4::jsonb) RETURNING id`,
      [tenantId, `send-${randomUUID()}`, templateVersionId, JSON.stringify(opts.senderJson ?? { fromEmail: 'ops@example.test', fromName: 'Ops' })],
    )).rows[0];
    const snapshot = (await pool.query<{ id: string }>(
      `INSERT INTO campaign_snapshot (tenant_id, campaign_id, template_version_id, sender_json, audience_query_json, policy_result_json)
       VALUES ($1, $2, $3, $4::jsonb, '{}'::jsonb, '{}'::jsonb) RETURNING id`,
      [tenantId, campaign.id, templateVersionId, JSON.stringify(opts.senderJson ?? { fromEmail: 'ops@example.test', fromName: 'Ops' })],
    )).rows[0];
    const execution = (await pool.query<{ id: string }>(
      `INSERT INTO campaign_execution (tenant_id, campaign_id, snapshot_id, correlation_id, status)
       VALUES ($1, $2, $3, $4, 'sending') RETURNING id`,
      [tenantId, campaign.id, snapshot.id, `send-${randomUUID()}`],
    )).rows[0];
    const recipient = (await pool.query<{ id: string }>(
      `INSERT INTO recipient (tenant_id, email) VALUES ($1, $2) RETURNING id`,
      [tenantId, opts.toEmail],
    )).rows[0];
    const campaignRecipient = (await pool.query<{ id: string }>(
      `INSERT INTO campaign_recipient (tenant_id, campaign_id, snapshot_id, recipient_id, merge_data_json, email_snapshot, eligibility, status, execution_id, batch_no)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, 'sendable', 'queued', $7, 1) RETURNING id`,
      [tenantId, campaign.id, snapshot.id, recipient.id, JSON.stringify(opts.mergeData ?? { email: opts.toEmail }), JSON.stringify({ subject: opts.subject ?? 'Hello', html: '<p>Hello</p>', textBody: 'Hello' }), execution.id],
    )).rows[0];
    return { campaignId: campaign.id, executionId: execution.id, campaignRecipientId: campaignRecipient.id, recipientId: recipient.id };
  }

  async function fixtureExecution(senderJson: Record<string, unknown>): Promise<{ campaignId: string; executionId: string }> {
    const campaign = (await pool.query<{ id: string }>(
      `INSERT INTO campaign (tenant_id, name, status, template_version_id, sender_json) VALUES ($1, $2, 'sending', $3, $4::jsonb) RETURNING id`,
      [tenantId, `send-multi-${randomUUID()}`, templateVersionId, JSON.stringify(senderJson)],
    )).rows[0];
    const snapshot = (await pool.query<{ id: string }>(
      `INSERT INTO campaign_snapshot (tenant_id, campaign_id, template_version_id, sender_json, audience_query_json, policy_result_json)
       VALUES ($1, $2, $3, $4::jsonb, '{}'::jsonb, '{}'::jsonb) RETURNING id`,
      [tenantId, campaign.id, templateVersionId, JSON.stringify(senderJson)],
    )).rows[0];
    const execution = (await pool.query<{ id: string }>(
      `INSERT INTO campaign_execution (tenant_id, campaign_id, snapshot_id, correlation_id, status, sender_config_id)
       VALUES ($1, $2, $3, $4, 'sending', $5) RETURNING id`,
      [tenantId, campaign.id, snapshot.id, `send-multi-${randomUUID()}`, (senderJson as { senderConfigId?: string }).senderConfigId ?? null],
    )).rows[0];
    return { campaignId: campaign.id, executionId: execution.id };
  }

  async function addRecipient(campaignId: string, executionId: string, toEmail: string): Promise<string> {
    const [snapshot] = (await pool.query<{ snapshot_id: string }>(`SELECT snapshot_id FROM campaign_execution WHERE id = $1`, [executionId])).rows;
    const recipient = (await pool.query<{ id: string }>(`INSERT INTO recipient (tenant_id, email) VALUES ($1, $2) RETURNING id`, [tenantId, toEmail])).rows[0];
    const campaignRecipient = (await pool.query<{ id: string }>(
      `INSERT INTO campaign_recipient (tenant_id, campaign_id, snapshot_id, recipient_id, merge_data_json, email_snapshot, eligibility, status, execution_id, batch_no)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, 'sendable', 'queued', $7, 1) RETURNING id`,
      [tenantId, campaignId, snapshot.snapshot_id, recipient.id, JSON.stringify({ email: toEmail }), JSON.stringify({ subject: 'Rate limit test', html: '<p>Hi</p>', textBody: 'Hi' }), executionId],
    )).rows[0];
    return campaignRecipient.id;
  }

  it('A7: submits a real message to Mailpit, records a submitted attempt, and flips the recipient to submitted', async () => {
    const toEmail = `send-a7-${randomUUID()}@example.test`;
    const { campaignId, executionId, campaignRecipientId } = await fixture({ toEmail, subject: 'Real send test' });

    const outcome = await sendClaimedBatch(testAppDatabaseUrl(), testRedisUrl(), tenantId, campaignId, executionId, 100);

    expect(outcome).toEqual({ submitted: 1, retrying: 0, failed: 0 });
    const messages = await messagesTo(toEmail);
    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages.some((m) => m.Subject === 'Real send test')).toBe(true);
    const row = (await pool.query<{ status: string; content_hash: string }>('SELECT status, content_hash FROM campaign_recipient WHERE id = $1', [campaignRecipientId])).rows[0];
    expect(row.status).toBe('submitted');
    expect(row.content_hash).toMatch(/^[0-9a-f]{64}$/);
    const attempt = (await pool.query<{ outcome: string; provider_message_id: string }>('SELECT outcome, provider_message_id FROM message_attempt WHERE campaign_recipient_id = $1', [campaignRecipientId])).rows[0];
    expect(attempt.outcome).toBe('submitted');
    expect(attempt.provider_message_id).toBeTruthy();
  });

  it('ADR-029: sends a legacy snapshot after the migration freezes its recipient envelope independently of merge data', async () => {
    const toEmail = `send-envelope-${randomUUID()}@example.test`;
    const { campaignId, executionId } = await fixture({ toEmail, subject: 'Frozen envelope test', mergeData: {} });

    const outcome = await sendClaimedBatch(testAppDatabaseUrl(), testRedisUrl(), tenantId, campaignId, executionId, 100);

    expect(outcome).toEqual({ submitted: 1, retrying: 0, failed: 0 });
    expect((await messagesTo(toEmail)).some((message) => message.Subject === 'Frozen envelope test')).toBe(true);
  });

  it('A17: a retry after the live recipient row is mutated produces an identical content_hash (worker never reads live data)', async () => {
    const toEmail = `send-a17-${randomUUID()}@example.test`;
    const { campaignId, executionId, recipientId } = await fixture({ toEmail });
    await pool.query(`UPDATE recipient SET email = $1 WHERE id = $2`, [`mutated-${randomUUID()}@example.test`, recipientId]);

    await sendClaimedBatch(testAppDatabaseUrl(), testRedisUrl(), tenantId, campaignId, executionId, 100);

    const messages = await messagesTo(toEmail);
    expect(messages.length).toBeGreaterThanOrEqual(1);
  });

  it('passes the frozen reply-to address to the SMTP adapter', async () => {
    const toEmail = `send-reply-to-${randomUUID()}@example.test`;
    const { campaignId, executionId } = await fixture({
      toEmail,
      senderJson: { fromEmail: 'ops@example.test', fromName: 'Ops', replyTo: 'replies@example.test' },
    });
    let capturedReplyTo: string | null = null;
    const captureSend: SmtpSendFn = async (message) => {
      capturedReplyTo = message.replyTo;
      return { providerMessageId: `reply-to-${randomUUID()}` };
    };

    const outcome = await sendClaimedBatch(testAppDatabaseUrl(), testRedisUrl(), tenantId, campaignId, executionId, 100, captureSend);

    expect(outcome).toEqual({ submitted: 1, retrying: 0, failed: 0 });
    expect(capturedReplyTo).toBe('replies@example.test');
  });

  it('A9/A10 transient: a connection failure schedules a retry, and exhausting max_attempts fails the recipient', async () => {
    const failingSend: SmtpSendFn = async () => {
      throw { code: 'ECONNREFUSED' };
    };
    const toEmail = `send-transient-${randomUUID()}@example.test`;
    const { campaignId, executionId, campaignRecipientId } = await fixture({ toEmail });
    await pool.query(`UPDATE campaign_execution SET max_attempts = 2 WHERE campaign_id = $1`, [campaignId]);

    const first = await sendClaimedBatch(testAppDatabaseUrl(), testRedisUrl(), tenantId, campaignId, executionId, 100, failingSend);
    expect(first).toEqual({ submitted: 0, retrying: 1, failed: 0 });
    const afterFirst = (await pool.query<{ status: string; attempt_count: number; next_retry_at: Date }>('SELECT status, attempt_count, next_retry_at FROM campaign_recipient WHERE id = $1', [campaignRecipientId])).rows[0];
    expect(afterFirst.status).toBe('queued');
    expect(afterFirst.attempt_count).toBe(1);
    expect(afterFirst.next_retry_at).not.toBeNull();

    await pool.query(`UPDATE campaign_recipient SET next_retry_at = now() - interval '1 second' WHERE id = $1`, [campaignRecipientId]);
    const second = await sendClaimedBatch(testAppDatabaseUrl(), testRedisUrl(), tenantId, campaignId, executionId, 100, failingSend);
    expect(second).toEqual({ submitted: 0, retrying: 0, failed: 1 });
    const afterSecond = (await pool.query<{ status: string; attempt_count: number }>('SELECT status, attempt_count FROM campaign_recipient WHERE id = $1', [campaignRecipientId])).rows[0];
    expect(afterSecond.status).toBe('failed');
    expect(afterSecond.attempt_count).toBe(2);

    const attempts = await pool.query<{ outcome: string; error_class: string }>('SELECT outcome, error_class FROM message_attempt WHERE campaign_recipient_id = $1 ORDER BY attempt_no', [campaignRecipientId]);
    expect(attempts.rows.map((r) => r.outcome)).toEqual(['transient_error', 'transient_error']);
  });

  it('A10: a permanent (non-bounce) error fails immediately without scheduling a retry', async () => {
    const failingSend: SmtpSendFn = async () => {
      throw { responseCode: 552, response: '552 5.2.3 Message too large' };
    };
    const toEmail = `send-permanent-${randomUUID()}@example.test`;
    const { campaignId, executionId, campaignRecipientId } = await fixture({ toEmail });

    const outcome = await sendClaimedBatch(testAppDatabaseUrl(), testRedisUrl(), tenantId, campaignId, executionId, 100, failingSend);

    expect(outcome).toEqual({ submitted: 0, retrying: 0, failed: 1 });
    const row = (await pool.query<{ status: string; next_retry_at: Date | null }>('SELECT status, next_retry_at FROM campaign_recipient WHERE id = $1', [campaignRecipientId])).rows[0];
    expect(row.status).toBe('failed');
    expect(row.next_retry_at).toBeNull();
    const recipientRow = (await pool.query<{ subscription_status: string }>(
      `SELECT r.subscription_status FROM recipient r JOIN campaign_recipient cr ON cr.recipient_id = r.id WHERE cr.id = $1`, [campaignRecipientId],
    )).rows[0];
    expect(recipientRow.subscription_status).toBe('active');
  });

  it('A11: a hard-bounce error fails the recipient AND atomically suppresses the underlying recipient', async () => {
    const failingSend: SmtpSendFn = async () => {
      throw { responseCode: 550, response: '550 5.1.1 No such user here' };
    };
    const toEmail = `send-bounce-${randomUUID()}@example.test`;
    const { campaignId, executionId, campaignRecipientId, recipientId } = await fixture({ toEmail });

    const outcome = await sendClaimedBatch(testAppDatabaseUrl(), testRedisUrl(), tenantId, campaignId, executionId, 100, failingSend);

    expect(outcome).toEqual({ submitted: 0, retrying: 0, failed: 1 });
    const row = (await pool.query<{ status: string }>('SELECT status FROM campaign_recipient WHERE id = $1', [campaignRecipientId])).rows[0];
    expect(row.status).toBe('failed');
    const recipientRow = (await pool.query<{ subscription_status: string; suppression_reason: string; suppressed_at: Date | null }>(
      'SELECT subscription_status, suppression_reason, suppressed_at FROM recipient WHERE id = $1', [recipientId],
    )).rows[0];
    expect(recipientRow).toMatchObject({ subscription_status: 'bounced', suppression_reason: 'hard_bounce' });
    expect(recipientRow.suppressed_at).not.toBeNull();
  });

  it('D-108/DEC-107: a second hard bounce against an already-suppressed recipient writes no second recipient.suppressed audit row and does not bump recipient.version', async () => {
    const failingSend: SmtpSendFn = async () => {
      throw { responseCode: 550, response: '550 5.1.1 No such user here' };
    };
    const toEmail = `send-bounce-twice-${randomUUID()}@example.test`;
    const first = await fixture({ toEmail });

    await sendClaimedBatch(testAppDatabaseUrl(), testRedisUrl(), tenantId, first.campaignId, first.executionId, 100, failingSend);

    const afterFirst = (await pool.query<{ version: string }>('SELECT version FROM recipient WHERE id = $1', [first.recipientId])).rows[0];
    const auditAfterFirst = await pool.query('SELECT id FROM audit_log WHERE tenant_id = $1 AND action = $2 AND entity_id = $3', [tenantId, 'recipient.suppressed', first.recipientId]);
    expect(auditAfterFirst.rowCount).toBe(1);

    // A second campaign, second execution, second campaign_recipient row --
    // but the SAME underlying recipient, already suppressed by the first
    // bounce above. This is what a real second campaign's freeze would
    // exclude via skipped_reason='status_bounced' -- reached directly here
    // to isolate suppressRecipient()'s own idempotency from the resolver's.
    const { campaignId: secondCampaignId, executionId: secondExecutionId } = await fixtureExecution({ fromEmail: 'ops@example.test', fromName: 'Ops' });
    const [snapshot] = (await pool.query<{ snapshot_id: string }>(`SELECT snapshot_id FROM campaign_execution WHERE id = $1`, [secondExecutionId])).rows;
    const secondCampaignRecipient = (await pool.query<{ id: string }>(
      `INSERT INTO campaign_recipient (tenant_id, campaign_id, snapshot_id, recipient_id, merge_data_json, email_snapshot, eligibility, status, execution_id, batch_no)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, 'sendable', 'queued', $7, 1) RETURNING id`,
      [tenantId, secondCampaignId, snapshot.snapshot_id, first.recipientId, JSON.stringify({ email: toEmail }), JSON.stringify({ subject: 'Second bounce', html: '<p>Hi</p>', textBody: 'Hi' }), secondExecutionId],
    )).rows[0];

    const secondOutcome = await sendClaimedBatch(testAppDatabaseUrl(), testRedisUrl(), tenantId, secondCampaignId, secondExecutionId, 100, failingSend);
    expect(secondOutcome).toEqual({ submitted: 0, retrying: 0, failed: 1 });
    const secondCampaignRecipientRow = (await pool.query<{ status: string }>('SELECT status FROM campaign_recipient WHERE id = $1', [secondCampaignRecipient.id])).rows[0];
    expect(secondCampaignRecipientRow.status).toBe('failed');

    const afterSecond = (await pool.query<{ version: string; subscription_status: string; suppression_reason: string }>(
      'SELECT version, subscription_status, suppression_reason FROM recipient WHERE id = $1', [first.recipientId],
    )).rows[0];
    expect(afterSecond.version).toBe(afterFirst.version);
    expect(afterSecond).toMatchObject({ subscription_status: 'bounced', suppression_reason: 'hard_bounce' });
    const auditAfterSecond = await pool.query('SELECT id FROM audit_log WHERE tenant_id = $1 AND action = $2 AND entity_id = $3', [tenantId, 'recipient.suppressed', first.recipientId]);
    expect(auditAfterSecond.rowCount).toBe(1);
  });

  it('A21: no message_attempt row or audit_log metadata contains the sender secret value', async () => {
    const sender = (await pool.query<{ id: string }>(
      `INSERT INTO sender_config (tenant_id, name, from_email, host, port, username, secret_ref, status)
       VALUES ($1, 'Send secret sender', 'secretsend@example.test', 'mailpit', 1025, 'someuser', 'EOW_SENDER_SECRET_SEND_A21_TEST', 'verified') RETURNING id`,
      [tenantId],
    )).rows[0];
    process.env.EOW_SENDER_SECRET_SEND_A21_TEST = 'super-secret-value-should-never-leak';
    const failingSend: SmtpSendFn = async () => {
      throw { responseCode: 550, response: '550 5.1.1 No such user here' };
    };
    const toEmail = `send-a21-${randomUUID()}@example.test`;
    const { campaignId, executionId, campaignRecipientId } = await fixture({ toEmail, senderJson: { senderConfigId: sender.id, fromEmail: 'secretsend@example.test' } });

    await sendClaimedBatch(testAppDatabaseUrl(), testRedisUrl(), tenantId, campaignId, executionId, 100, failingSend);

    const attempt = (await pool.query<{ provider_response: string | null; error_code: string | null }>('SELECT provider_response, error_code FROM message_attempt WHERE campaign_recipient_id = $1', [campaignRecipientId])).rows[0];
    const serialized = JSON.stringify(attempt);
    expect(serialized).not.toContain('super-secret-value-should-never-leak');
    delete process.env.EOW_SENDER_SECRET_SEND_A21_TEST;
  });

  it('passes a durable encrypted credential to the SMTP send function', async () => {
    const secretRef = `EOW_SENDER_SECRET_SEND_${randomUUID().replaceAll('-', '')}`;
    const secret = `shared-${randomUUID()}`;
    const sender = (await pool.query<{ id: string }>(
      `INSERT INTO sender_config (tenant_id, name, from_email, host, port, username, secret_ref, status)
       VALUES ($1, 'Encrypted sender', 'encrypted-send@example.test', 'smtp.example.test', 587, 'smtp-user', $2, 'verified') RETURNING id`,
      [tenantId, secretRef],
    )).rows[0];
    const ciphertext = encryptSenderSecret(parseSenderCredentialKey(process.env.SENDER_CREDENTIAL_KEY), tenantId, secretRef, secret);
    await pool.query('INSERT INTO sender_credential (tenant_id, secret_ref, ciphertext) VALUES ($1, $2, $3)', [tenantId, secretRef, ciphertext]);
    const { campaignId, executionId } = await fixtureExecution({ senderConfigId: sender.id, fromEmail: 'encrypted-send@example.test' });
    await addRecipient(campaignId, executionId, `encrypted-send-${randomUUID()}@example.test`);
    let capturedSecret = '';
    const capture: SmtpSendFn = async (message) => { capturedSecret = message.secret; return { providerMessageId: `encrypted-${randomUUID()}` }; };

    const outcome = await sendClaimedBatch(testAppDatabaseUrl(), testRedisUrl(), tenantId, campaignId, executionId, 10, capture);

    expect(outcome).toEqual({ submitted: 1, retrying: 0, failed: 0 });
    expect(capturedSecret).toBe(secret);
  });

  it('a second call over an already-submitted recipient submits nothing further (idempotent claim)', async () => {
    const toEmail = `send-idempotent-${randomUUID()}@example.test`;
    const { campaignId, executionId, campaignRecipientId } = await fixture({ toEmail });
    const first = await sendClaimedBatch(testAppDatabaseUrl(), testRedisUrl(), tenantId, campaignId, executionId, 100);
    expect(first).toEqual({ submitted: 1, retrying: 0, failed: 0 });

    const second = await sendClaimedBatch(testAppDatabaseUrl(), testRedisUrl(), tenantId, campaignId, executionId, 100);

    expect(second).toEqual({ submitted: 0, retrying: 0, failed: 0 });
    const attempts = await pool.query('SELECT id FROM message_attempt WHERE campaign_recipient_id = $1', [campaignRecipientId]);
    expect(attempts.rowCount).toBe(1);
  });

  it('A12: a provider 429/Retry-After produces next_retry_at honouring the header, not the shorter backoff floor', async () => {
    const failingSend: SmtpSendFn = async () => {
      throw { responseCode: 421, response: '421 4.7.0 Try again later', retryAfterSeconds: 30 };
    };
    const toEmail = `send-a12-${randomUUID()}@example.test`;
    const { campaignId, executionId, campaignRecipientId } = await fixture({ toEmail });
    const before = new Date();

    await sendClaimedBatch(testAppDatabaseUrl(), testRedisUrl(), tenantId, campaignId, executionId, 100, failingSend);

    const row = (await pool.query<{ next_retry_at: Date }>('SELECT next_retry_at FROM campaign_recipient WHERE id = $1', [campaignRecipientId])).rows[0];
    expect(row.next_retry_at.getTime()).toBeGreaterThanOrEqual(before.getTime() + 30_000);
  });

  it('TC-SEND-017: after a 429/Retry-After the row is not claimed before the window, then submits exactly once when it is due', async () => {
    const failingSend: SmtpSendFn = async () => {
      throw { responseCode: 421, response: '421 4.7.0 Try again later', retryAfterSeconds: 30 };
    };
    const toEmail = `send-tc017-${randomUUID()}@example.test`;
    const { campaignId, executionId, campaignRecipientId } = await fixture({ toEmail });

    const throttled = await sendClaimedBatch(testAppDatabaseUrl(), testRedisUrl(), tenantId, campaignId, executionId, 100, failingSend);
    expect(throttled).toEqual({ submitted: 0, retrying: 1, failed: 0 });

    // Inside the Retry-After window: nothing is claimed, nothing is attempted.
    const tooSoon = await sendClaimedBatch(testAppDatabaseUrl(), testRedisUrl(), tenantId, campaignId, executionId, 100);
    expect(tooSoon).toEqual({ submitted: 0, retrying: 0, failed: 0 });
    const duringWindow = await pool.query('SELECT id FROM message_attempt WHERE campaign_recipient_id = $1', [campaignRecipientId]);
    expect(duringWindow.rowCount).toBe(1);

    // The window elapses (moved, not slept): one success, one further attempt row.
    await pool.query(`UPDATE campaign_recipient SET next_retry_at = now() - interval '1 second' WHERE id = $1`, [campaignRecipientId]);
    const afterWindow = await sendClaimedBatch(testAppDatabaseUrl(), testRedisUrl(), tenantId, campaignId, executionId, 100);

    expect(afterWindow).toEqual({ submitted: 1, retrying: 0, failed: 0 });
    const row = (await pool.query<{ status: string; next_retry_at: Date | null }>(
      'SELECT status, next_retry_at FROM campaign_recipient WHERE id = $1', [campaignRecipientId],
    )).rows[0];
    expect(row).toMatchObject({ status: 'submitted', next_retry_at: null });
    const outcomes = await pool.query<{ outcome: string }>(
      'SELECT outcome FROM message_attempt WHERE campaign_recipient_id = $1 ORDER BY attempt_no', [campaignRecipientId],
    );
    expect(outcomes.rows.map((r) => r.outcome)).toEqual(['transient_error', 'submitted']);
  });

  it('A13: a sender rate limit of N stops submitting after N in the same minute, leaving the rest queued for the next window', async () => {
    const sender = (await pool.query<{ id: string }>(
      `INSERT INTO sender_config (tenant_id, name, from_email, host, port, username, secret_ref, status, rate_limit_per_minute)
       VALUES ($1, 'A13 sender', 'a13@example.test', '127.0.0.1', 1025, '', 'EOW_SENDER_SECRET_A13_UNUSED', 'verified', 2) RETURNING id`,
      [tenantId],
    )).rows[0];
    const { campaignId, executionId } = await fixtureExecution({ senderConfigId: sender.id, fromEmail: 'a13@example.test' });
    const recipientIds = await Promise.all(
      Array.from({ length: 4 }, (_, i) => addRecipient(campaignId, executionId, `send-a13-${i}-${randomUUID()}@example.test`)),
    );

    const outcome = await sendClaimedBatch(testAppDatabaseUrl(), testRedisUrl(), tenantId, campaignId, executionId, 100);

    expect(outcome.submitted).toBe(2);
    expect(outcome.submitted + outcome.retrying).toBe(4);
    const rows = await pool.query<{ status: string }>(`SELECT status FROM campaign_recipient WHERE id = ANY($1)`, [recipientIds]);
    expect(rows.rows.filter((r) => r.status === 'submitted')).toHaveLength(2);
    expect(rows.rows.filter((r) => r.status === 'queued')).toHaveLength(2);
  });

  it('A14: a reached sender daily ceiling refuses further submissions this pass, losing nothing', async () => {
    const sender = (await pool.query<{ id: string }>(
      `INSERT INTO sender_config (tenant_id, name, from_email, host, port, username, secret_ref, status, daily_send_limit)
       VALUES ($1, 'A14 sender', 'a14@example.test', '127.0.0.1', 1025, '', 'EOW_SENDER_SECRET_A14_UNUSED', 'verified', 1) RETURNING id`,
      [tenantId],
    )).rows[0];
    const { campaignId, executionId } = await fixtureExecution({ senderConfigId: sender.id, fromEmail: 'a14@example.test' });
    const first = await addRecipient(campaignId, executionId, `send-a14-first-${randomUUID()}@example.test`);
    const second = await addRecipient(campaignId, executionId, `send-a14-second-${randomUUID()}@example.test`);

    const outcome = await sendClaimedBatch(testAppDatabaseUrl(), testRedisUrl(), tenantId, campaignId, executionId, 100);

    expect(outcome.submitted).toBe(1);
    expect(outcome.submitted + outcome.retrying).toBe(2);
    const firstRow = (await pool.query<{ status: string }>('SELECT status FROM campaign_recipient WHERE id = $1', [first])).rows[0];
    const secondRow = (await pool.query<{ status: string }>('SELECT status FROM campaign_recipient WHERE id = $1', [second])).rows[0];
    expect([firstRow.status, secondRow.status].sort()).toEqual(['queued', 'submitted']);
  });

  it('A15: a row reserved but never recorded (simulated crash) is reclaimed by a later call once stale, not before', async () => {
    const toEmail = `send-a15-${randomUUID()}@example.test`;
    const { campaignId, executionId, campaignRecipientId } = await fixture({ toEmail });
    // Simulate the exact post-crash state: reserveBatch's own claim (claimed_at
    // set) ran, but the process died before send/record ever executed.
    await pool.query(`UPDATE campaign_recipient SET claimed_at = now() WHERE id = $1`, [campaignRecipientId]);

    const tooSoon = await sendClaimedBatch(testAppDatabaseUrl(), testRedisUrl(), tenantId, campaignId, executionId, 100);
    expect(tooSoon).toEqual({ submitted: 0, retrying: 0, failed: 0 });

    await pool.query(`UPDATE campaign_recipient SET claimed_at = now() - interval '6 minutes' WHERE id = $1`, [campaignRecipientId]);
    const afterStale = await sendClaimedBatch(testAppDatabaseUrl(), testRedisUrl(), tenantId, campaignId, executionId, 100);
    expect(afterStale).toEqual({ submitted: 1, retrying: 0, failed: 0 });
    const attempts = await pool.query('SELECT id FROM message_attempt WHERE campaign_recipient_id = $1', [campaignRecipientId]);
    expect(attempts.rowCount).toBe(1);
  });

  it('A15/DEC-103: Redis being unreachable fails the batch closed -- no submission, nothing lost', async () => {
    const toEmail = `send-a15-redis-${randomUUID()}@example.test`;
    const { campaignId, executionId, campaignRecipientId } = await fixture({ toEmail });
    const unreachableRedisUrl = 'redis://127.0.0.1:1';

    const outcome = await sendClaimedBatch(testAppDatabaseUrl(), unreachableRedisUrl, tenantId, campaignId, executionId, 100);

    expect(outcome).toEqual({ submitted: 0, retrying: 1, failed: 0 });
    const row = (await pool.query<{ status: string }>('SELECT status FROM campaign_recipient WHERE id = $1', [campaignRecipientId])).rows[0];
    expect(row.status).toBe('queued');
  });

  it('A15/DEC-103: a mid-run Redis disconnect still leaves every unsent recipient queued, not lost', async () => {
    const { campaignId, executionId } = await fixtureExecution({ fromEmail: 'a15flush@example.test' });
    const recipientIds = await Promise.all(
      Array.from({ length: 3 }, (_, i) => addRecipient(campaignId, executionId, `send-a15-flush-${i}-${randomUUID()}@example.test`)),
    );
    const redisConn = new Redis(testRedisUrl());
    await redisConn.flushdb();
    await redisConn.quit();

    const outcome = await sendClaimedBatch(testAppDatabaseUrl(), testRedisUrl(), tenantId, campaignId, executionId, 100);

    const rows = await pool.query<{ status: string }>(`SELECT status FROM campaign_recipient WHERE id = ANY($1)`, [recipientIds]);
    expect(outcome.submitted + rows.rows.filter((r) => r.status === 'queued').length).toBe(3);
    expect(rows.rows.every((r) => r.status === 'submitted' || r.status === 'queued')).toBe(true);
  });

  it('A7 (M6-S1 CP6): a 600-recipient batch publishes each complete 250-recipient interval with a strictly higher version', async () => {
    // Its own tenant, not the file's shared `tenantId`: sending_policy's
    // default tenant_rate_limit_per_minute is exactly 600, so 600 real
    // submissions on the shared tenant would exhaust that minute's budget
    // and starve every other test in this file sharing the same bucket.
    const throttleTenantId = (await pool.query<{ id: string }>('INSERT INTO tenant (name) VALUES ($1) RETURNING id', [`worker-send-progress-${randomUUID()}`])).rows[0].id;
    const template = (await pool.query<{ id: string }>(
      `INSERT INTO email_template (tenant_id, name, status) VALUES ($1, $2, 'published') RETURNING id`,
      [throttleTenantId, `send-progress-template-${randomUUID()}`],
    )).rows[0];
    const throttleTemplateVersionId = (await pool.query<{ id: string }>(
      `INSERT INTO email_template_version (tenant_id, template_id, version, subject, html, text_body, variable_schema_json, content_hash, published_at)
       VALUES ($1, $2, 1, 'subject', '<p>body</p>', 'body', '{"required":[],"optional":[]}'::jsonb, repeat('9', 64), now()) RETURNING id`,
      [throttleTenantId, template.id],
    )).rows[0].id;
    // status='completed' (not 'sending'): this fixture's 600 recipients take
    // several real seconds of wall-clock time to process, and
    // queued_campaign_executions() (the live docker-compose worker's own
    // campaign-send-scan, ticking every 60s against this same shared
    // database) matches 'sending' campaigns. A single-recipient fixture
    // finishes near-instantly and rarely lands on a tick; this one does not
    // get that protection for free, so it opts out of the scan's IN-list
    // instead (D-118's mechanism). D-124 (M6-S3 CP5): this used to be
    // 'paused' until BR-SEND-009 gave that value a real enforcement meaning
    // (sendClaimedBatch now stops mid-batch on it) -- 'completed' keeps the
    // same scan-hiding property without colliding with genuine pause
    // semantics, since sendClaimedBatch checks specifically for 'paused',
    // not merely "not sending".
    const campaign = (await pool.query<{ id: string }>(
      `INSERT INTO campaign (tenant_id, name, status, template_version_id, sender_json) VALUES ($1, $2, 'completed', $3, $4::jsonb) RETURNING id`,
      [throttleTenantId, `send-progress-${randomUUID()}`, throttleTemplateVersionId, JSON.stringify({ fromEmail: 'progress-publish@example.test' })],
    )).rows[0];
    const snapshot = (await pool.query<{ id: string }>(
      `INSERT INTO campaign_snapshot (tenant_id, campaign_id, template_version_id, sender_json, audience_query_json, policy_result_json)
       VALUES ($1, $2, $3, $4::jsonb, '{}'::jsonb, '{}'::jsonb) RETURNING id`,
      [throttleTenantId, campaign.id, throttleTemplateVersionId, JSON.stringify({ fromEmail: 'progress-publish@example.test' })],
    )).rows[0];
    const execution = (await pool.query<{ id: string }>(
      `INSERT INTO campaign_execution (tenant_id, campaign_id, snapshot_id, correlation_id, status) VALUES ($1, $2, $3, $4, 'sending') RETURNING id`,
      [throttleTenantId, campaign.id, snapshot.id, `send-progress-${randomUUID()}`],
    )).rows[0];
    const campaignId = campaign.id;
    const executionId = execution.id;

    await Promise.all(
      Array.from({ length: 600 }, async (_, i) => {
        const toEmail = `send-progress-${i}-${randomUUID()}@example.test`;
        const recipient = (await pool.query<{ id: string }>(`INSERT INTO recipient (tenant_id, email) VALUES ($1, $2) RETURNING id`, [throttleTenantId, toEmail])).rows[0];
        await pool.query(
          `INSERT INTO campaign_recipient (tenant_id, campaign_id, snapshot_id, recipient_id, merge_data_json, email_snapshot, eligibility, status, execution_id, batch_no)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, 'sendable', 'queued', $7, 1)`,
          [throttleTenantId, campaignId, snapshot.id, recipient.id, JSON.stringify({ email: toEmail }), JSON.stringify({ subject: 'Progress publish test', html: '<p>Hi</p>', textBody: 'Hi' }), executionId],
        );
      }),
    );

    const stubSend: SmtpSendFn = async () => ({ providerMessageId: `stub-${randomUUID()}` });
    const published: Array<ProgressEvent | ResyncEvent> = [];
    const capture = async (event: ProgressEvent | ResyncEvent): Promise<void> => { published.push(event); };

    try {
      const outcome = await sendClaimedBatch(testAppDatabaseUrl(), testRedisUrl(), throttleTenantId, campaignId, executionId, 600, stubSend, capture);

      expect(outcome.submitted).toBe(600);
      expect(published.length).toBeGreaterThanOrEqual(Math.floor(600 / 250));
      const versions = published.map((event) => event.version);
      expect(new Set(versions).size).toBe(versions.length);
      for (let i = 1; i < versions.length; i += 1) expect(versions[i]).toBeGreaterThan(versions[i - 1]);

      // sendClaimedBatch alone does not guarantee the LAST throttled publish
      // reflects the fully-drained state -- that end-of-pass guarantee is
      // runOneCampaign's mandatory flush (run.ts, below), not this
      // function's own contract. What sendClaimedBatch does guarantee: every
      // publish it does emit is internally consistent with the database at
      // the moment it was written (checked by progress-snapshot's own
      // integration test, CP5) and strictly increasing in version (above).
    } finally {
      await purgeCampaignSendFixtures(pool, throttleTenantId, 'eow_send_progress_publish_test_cleanup');
      await pool.query('DELETE FROM recipient WHERE tenant_id = $1', [throttleTenantId]);
      await pool.query('DELETE FROM email_template WHERE tenant_id = $1', [throttleTenantId]);
      await pool.query('DELETE FROM tenant WHERE id = $1', [throttleTenantId]);
    }
    // 240s, against the 30s this file's other tests share. Not a loosened
    // budget: this one test submits 600 real messages over SMTP to Mailpit
    // because 600 is the default tenant_rate_limit_per_minute the assertion
    // depends on, while every other test here sends one and finishes in 1-7s.
    // Measured 2026-09-04 with the cap lifted: 116.8s. At 30s it had no margin
    // at all and failed whenever the machine was busy, which reads as a flaky
    // send path rather than as what it is -- an expensive test told it had a
    // cheap test's budget.
  }, 240_000);

  it('DEC-124: a publisher that throws does not fail the batch -- realtime is a hint, PostgreSQL already has the fact', async () => {
    const toEmail = `send-publish-fail-${randomUUID()}@example.test`;
    const { campaignId, executionId, campaignRecipientId } = await fixture({ toEmail });
    const stubSend: SmtpSendFn = async () => ({ providerMessageId: `stub-${randomUUID()}` });
    const throwingPublisher = async (): Promise<void> => { throw new Error('redis unreachable'); };

    const outcome = await sendClaimedBatch(testAppDatabaseUrl(), testRedisUrl(), tenantId, campaignId, executionId, 100, stubSend, throwingPublisher);

    expect(outcome).toEqual({ submitted: 1, retrying: 0, failed: 0 });
    const row = (await pool.query<{ status: string }>('SELECT status FROM campaign_recipient WHERE id = $1', [campaignRecipientId])).rows[0];
    expect(row.status).toBe('submitted');
  });
});
