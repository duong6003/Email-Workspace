import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { encryptSenderSecret, parseSenderCredentialKey } from '@eow/sender-credentials';
import { runValidation } from './validate.js';
import { purgeCampaignSendFixtures } from '../test-cleanup-helpers.js';
import { testAppDatabaseUrl, testOwnerDatabaseUrl } from '../test-urls.js';

/**
 * M5-S3 CP3 (BR-SEND-001, D-87): the real 'validate' + 'freeze' DAG nodes,
 * replacing worker/main.ts's fabricated-success stubs. Same harness shape as
 * campaign-dispatcher.integration.test.ts (M5-S2 CP4): direct fixtures over
 * the owner connection, the function under test runs over the narrow app
 * connection.
 */
describe('runValidation (M5-S3 CP3: BR-SEND-001 validate+freeze, A4/A5/A20)', () => {
  const pool = new pg.Pool({ connectionString: testOwnerDatabaseUrl() });
  let tenantId: string;
  let templateVersionId: string;

  beforeAll(async () => {
    tenantId = (await pool.query<{ id: string }>('INSERT INTO tenant (name) VALUES ($1) RETURNING id', [`worker-validate-${randomUUID()}`])).rows[0].id;
    const template = (await pool.query<{ id: string }>(
      `INSERT INTO email_template (tenant_id, name, status) VALUES ($1, $2, 'published') RETURNING id`,
      [tenantId, `validate-template-${randomUUID()}`],
    )).rows[0];
    templateVersionId = (await pool.query<{ id: string }>(
      `INSERT INTO email_template_version (tenant_id, template_id, version, subject, html, text_body, variable_schema_json, content_hash, published_at)
       VALUES ($1, $2, 1, 'subject', '<p>body</p>', 'body', '{"required":[],"optional":[]}'::jsonb, repeat('e', 64), now()) RETURNING id`,
      [tenantId, template.id],
    )).rows[0].id;
  });

  async function purgeTenantFixtures(id: string): Promise<void> {
    await purgeCampaignSendFixtures(pool, id, 'eow_campaign_send_validate_test_cleanup');
    await pool.query('DELETE FROM sending_policy WHERE tenant_id = $1', [id]);
    await pool.query('DELETE FROM email_template WHERE tenant_id = $1', [id]);
    await pool.query('DELETE FROM sender_config WHERE tenant_id = $1', [id]);
    await pool.query('DELETE FROM tenant WHERE id = $1', [id]);
  }

  afterAll(async () => {
    await purgeTenantFixtures(tenantId);
    await pool.end();
  });

  async function insertQueuedCampaign(senderJson: Record<string, unknown>, opts: { withSnapshot?: boolean } = {}): Promise<string> {
    const campaign = (await pool.query<{ id: string }>(
      `INSERT INTO campaign (tenant_id, name, status, template_version_id, sender_json)
       VALUES ($1, $2, 'queued', $3, $4::jsonb) RETURNING id`,
      [tenantId, `validate-${randomUUID()}`, templateVersionId, JSON.stringify(senderJson)],
    )).rows[0];
    if (opts.withSnapshot !== false) {
      await pool.query(
        `INSERT INTO campaign_snapshot (tenant_id, campaign_id, template_version_id, sender_json, audience_query_json, policy_result_json, total_snapshot, sendable_count, skipped_count)
         VALUES ($1, $2, $3, $4::jsonb, '{}'::jsonb, '{}'::jsonb, 0, 0, 0)`,
        [tenantId, campaign.id, templateVersionId, JSON.stringify(senderJson)],
      );
    }
    return campaign.id as string;
  }

  it('A4: no live snapshot -- fails validating with no campaign_execution row created', async () => {
    const campaignId = await insertQueuedCampaign({ fromEmail: 'ops@example.test' }, { withSnapshot: false });

    const outcome = await runValidation(testAppDatabaseUrl(), tenantId, campaignId);

    expect(outcome).toEqual({ result: 'failed', failureCode: 'NO_LIVE_SNAPSHOT' });
    const row = (await pool.query<{ status: string }>('SELECT status FROM campaign WHERE id = $1', [campaignId])).rows[0];
    expect(row.status).toBe('failed');
    const execution = await pool.query('SELECT 1 FROM campaign_execution WHERE campaign_id = $1', [campaignId]);
    expect(execution.rowCount).toBe(0);
  });

  it('A4: sender missing (no senderConfigId, no fromEmail) -- fails validating and records failure_code on the execution row', async () => {
    const campaignId = await insertQueuedCampaign({});

    const outcome = await runValidation(testAppDatabaseUrl(), tenantId, campaignId);

    expect(outcome).toEqual({ result: 'failed', failureCode: 'SENDER_MISSING' });
    const row = (await pool.query<{ status: string }>('SELECT status FROM campaign WHERE id = $1', [campaignId])).rows[0];
    expect(row.status).toBe('failed');
    const execution = (await pool.query<{ status: string; failure_code: string }>(
      'SELECT status, failure_code FROM campaign_execution WHERE campaign_id = $1', [campaignId],
    )).rows[0];
    expect(execution).toMatchObject({ status: 'failed', failure_code: 'SENDER_MISSING' });
  });

  it('A4: sender disabled -- fails validating with SENDER_DISABLED', async () => {
    const sender = (await pool.query<{ id: string }>(
      `INSERT INTO sender_config (tenant_id, name, from_email, host, port, username, secret_ref, status)
       VALUES ($1, 'Validate sender', 'disabled@example.test', 'smtp.example.test', 587, '', 'EOW_SENDER_SECRET_VALIDATE_TEST', 'disabled') RETURNING id`,
      [tenantId],
    )).rows[0];
    const campaignId = await insertQueuedCampaign({ senderConfigId: sender.id });

    const outcome = await runValidation(testAppDatabaseUrl(), tenantId, campaignId);

    expect(outcome).toEqual({ result: 'failed', failureCode: 'SENDER_DISABLED' });
  });

  it('D-91: sender secret unresolvable (username set, env var absent) -- fails validating with SENDER_SECRET_UNRESOLVED', async () => {
    const sender = (await pool.query<{ id: string }>(
      `INSERT INTO sender_config (tenant_id, name, from_email, host, port, username, secret_ref, status)
       VALUES ($1, 'Validate sender 2', 'auth@example.test', 'smtp.example.test', 587, 'someuser', 'EOW_SENDER_SECRET_DOES_NOT_EXIST_XYZ', 'verified') RETURNING id`,
      [tenantId],
    )).rows[0];
    const campaignId = await insertQueuedCampaign({ senderConfigId: sender.id });

    const outcome = await runValidation(testAppDatabaseUrl(), tenantId, campaignId);

    expect(outcome).toEqual({ result: 'failed', failureCode: 'SENDER_SECRET_UNRESOLVED' });
  });

  it('accepts an authenticated sender whose encrypted credential is shared through PostgreSQL', async () => {
    const secretRef = `EOW_SENDER_SECRET_VALIDATE_${randomUUID().replaceAll('-', '')}`;
    const sender = (await pool.query<{ id: string }>(
      `INSERT INTO sender_config (tenant_id, name, from_email, host, port, username, secret_ref, status)
       VALUES ($1, 'Validate encrypted sender', 'encrypted@example.test', 'smtp.example.test', 587, 'someuser', $2, 'verified') RETURNING id`,
      [tenantId, secretRef],
    )).rows[0];
    const ciphertext = encryptSenderSecret(parseSenderCredentialKey(process.env.SENDER_CREDENTIAL_KEY), tenantId, secretRef, 'shared-worker-secret');
    await pool.query('INSERT INTO sender_credential (tenant_id, secret_ref, ciphertext) VALUES ($1, $2, $3)', [tenantId, secretRef, ciphertext]);
    const campaignId = await insertQueuedCampaign({ senderConfigId: sender.id });

    const outcome = await runValidation(testAppDatabaseUrl(), tenantId, campaignId);

    expect(outcome.result).toBe('validated');
  });

  it('BR-CFG-002/D-113: a sender that regressed to pending after scheduling fails validating with SENDER_NOT_VERIFIED', async () => {
    const sender = (await pool.query<{ id: string }>(
      `INSERT INTO sender_config (tenant_id, name, from_email, host, port, username, secret_ref, status)
       VALUES ($1, 'Validate pending sender', 'pending@example.test', 'smtp.example.test', 587, '', 'EOW_SENDER_SECRET_VALIDATE_PENDING', 'pending') RETURNING id`,
      [tenantId],
    )).rows[0];
    const campaignId = await insertQueuedCampaign({ senderConfigId: sender.id });

    const outcome = await runValidation(testAppDatabaseUrl(), tenantId, campaignId);

    expect(outcome).toEqual({ result: 'failed', failureCode: 'SENDER_NOT_VERIFIED' });
    const execution = (await pool.query<{ status: string; failure_code: string }>(
      'SELECT status, failure_code FROM campaign_execution WHERE campaign_id = $1', [campaignId],
    )).rows[0];
    expect(execution).toMatchObject({ status: 'failed', failure_code: 'SENDER_NOT_VERIFIED' });
  });

  it('BR-CFG-002/D-113: a failed sender is refused the same way, and stays distinct from SENDER_DISABLED', async () => {
    const sender = (await pool.query<{ id: string }>(
      `INSERT INTO sender_config (tenant_id, name, from_email, host, port, username, secret_ref, status)
       VALUES ($1, 'Validate failed sender', 'failed@example.test', 'smtp.example.test', 587, '', 'EOW_SENDER_SECRET_VALIDATE_FAILED', 'failed') RETURNING id`,
      [tenantId],
    )).rows[0];
    const campaignId = await insertQueuedCampaign({ senderConfigId: sender.id });

    const outcome = await runValidation(testAppDatabaseUrl(), tenantId, campaignId);

    expect(outcome).toEqual({ result: 'failed', failureCode: 'SENDER_NOT_VERIFIED' });
  });

  it('A4: an empty-username sender (Mailpit-shaped, no auth) needs no secret and passes', async () => {
    const sender = (await pool.query<{ id: string }>(
      `INSERT INTO sender_config (tenant_id, name, from_email, host, port, username, secret_ref, status)
       VALUES ($1, 'Validate sender 3', 'noauth@example.test', 'mailpit', 1025, '', 'EOW_SENDER_SECRET_UNUSED', 'verified') RETURNING id`,
      [tenantId],
    )).rows[0];
    const campaignId = await insertQueuedCampaign({ senderConfigId: sender.id });

    const outcome = await runValidation(testAppDatabaseUrl(), tenantId, campaignId);

    expect(outcome.result).toBe('validated');
    const row = (await pool.query<{ status: string }>('SELECT status FROM campaign WHERE id = $1', [campaignId])).rows[0];
    expect(row.status).toBe('validating');
  });

  it('freezes the tenant batch and retry defaults into the execution', async () => {
    await pool.query(
      `INSERT INTO sending_policy (tenant_id, batch_size, max_attempts, tenant_rate_limit_per_minute)
       VALUES ($1, 37, 9, 901)
       ON CONFLICT (tenant_id) DO UPDATE SET batch_size = EXCLUDED.batch_size, max_attempts = EXCLUDED.max_attempts, tenant_rate_limit_per_minute = EXCLUDED.tenant_rate_limit_per_minute`,
      [tenantId],
    );
    const campaignId = await insertQueuedCampaign({ fromEmail: 'policy@example.test' });

    const outcome = await runValidation(testAppDatabaseUrl(), tenantId, campaignId);

    expect(outcome.result).toBe('validated');
    const [execution] = (await pool.query<{ batch_size: number; max_attempts: number }>(
      'SELECT batch_size, max_attempts FROM campaign_execution WHERE campaign_id = $1', [campaignId],
    )).rows;
    expect(execution).toEqual({ batch_size: 37, max_attempts: 9 });
  });

  it('A5: freeze is idempotent -- running validation twice on an already-validating campaign creates no second execution row', async () => {
    const campaignId = await insertQueuedCampaign({ fromEmail: 'ops@example.test' });

    const first = await runValidation(testAppDatabaseUrl(), tenantId, campaignId);
    expect(first.result).toBe('validated');
    const second = await runValidation(testAppDatabaseUrl(), tenantId, campaignId);
    expect(second).toEqual({ result: 'not_claimable' });

    const executions = await pool.query('SELECT id FROM campaign_execution WHERE campaign_id = $1', [campaignId]);
    expect(executions.rowCount).toBe(1);
  });

  it('A20: a campaign belonging to another tenant is never claimed', async () => {
    const otherTenantId = (await pool.query<{ id: string }>('INSERT INTO tenant (name) VALUES ($1) RETURNING id', [`worker-validate-other-${randomUUID()}`])).rows[0].id;
    const campaignId = await insertQueuedCampaign({ fromEmail: 'ops@example.test' });

    const outcome = await runValidation(testAppDatabaseUrl(), otherTenantId, campaignId);

    expect(outcome).toEqual({ result: 'not_claimable' });
    const row = (await pool.query<{ status: string }>('SELECT status FROM campaign WHERE id = $1', [campaignId])).rows[0];
    expect(row.status).toBe('queued');
    await purgeTenantFixtures(otherTenantId);
  });
});
