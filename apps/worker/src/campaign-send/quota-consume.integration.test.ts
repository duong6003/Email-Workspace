import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { sendClaimedBatch, type SmtpSendFn } from './send.js';
import { purgeCampaignSendFixtures } from '../test-cleanup-helpers.js';
import { testAppDatabaseUrl, testOwnerDatabaseUrl, testRedisUrl } from '../test-urls.js';

const fakeSend: SmtpSendFn = async () => ({ providerMessageId: `quota-${randomUUID()}` });

describe('BR-CFG-006: worker execution-time quota', () => {
  let owner: pg.Pool;
  let tenantId: string;
  let unlimitedTenantId: string;
  let campaignId: string;
  let executionId: string;
  let otherCampaignId: string;
  let otherExecutionId: string;

  async function createFixture(currentTenantId: string, limited: boolean): Promise<{ campaignId: string; executionId: string }> {
    const template = (await owner.query<{ id: string }>(`INSERT INTO email_template (tenant_id,name,status) VALUES ($1,$2,'published') RETURNING id`, [currentTenantId, `quota-template-${randomUUID()}`])).rows[0];
    const version = (await owner.query<{ id: string }>(`INSERT INTO email_template_version (tenant_id,template_id,version,subject,html,text_body,variable_schema_json,content_hash,published_at) VALUES ($1,$2,1,'s','<p>h</p>','t','{"required":[],"optional":[]}'::jsonb,$3,now()) RETURNING id`, [currentTenantId, template.id, randomUUID().replaceAll('-', '').padEnd(64, 'a').slice(0, 64)])).rows[0];
    const campaign = (await owner.query<{ id: string }>(`INSERT INTO campaign (tenant_id,name,status,template_version_id,sender_json) VALUES ($1,$2,'completed',$3,'{"fromEmail":"ops@example.test"}'::jsonb) RETURNING id`, [currentTenantId, `quota-campaign-${randomUUID()}`, version.id])).rows[0];
    const snapshot = (await owner.query<{ id: string }>(`INSERT INTO campaign_snapshot (tenant_id,campaign_id,template_version_id,sender_json,audience_query_json,policy_result_json) VALUES ($1,$2,$3,'{"fromEmail":"ops@example.test"}'::jsonb,'{}','{}') RETURNING id`, [currentTenantId, campaign.id, version.id])).rows[0];
    const execution = (await owner.query<{ id: string }>(`INSERT INTO campaign_execution (tenant_id,campaign_id,snapshot_id,correlation_id,status) VALUES ($1,$2,$3,$4,'sending') RETURNING id`, [currentTenantId, campaign.id, snapshot.id, `quota-${randomUUID()}`])).rows[0];
    await owner.query(`INSERT INTO sending_policy (tenant_id,send_quota_limit,send_quota_period,tenant_rate_limit_per_minute) VALUES ($1,$2,'month',600)`, [currentTenantId, limited ? 3 : null]);
    if (limited) await owner.query(`INSERT INTO quota_reservation (tenant_id,campaign_id,snapshot_id,period_key,amount,state) VALUES ($1,$2,$3,$4,5,'held')`, [currentTenantId, campaign.id, snapshot.id, new Date().toISOString().slice(0, 7)]);
    for (let index = 0; index < 5; index += 1) {
      const email = `quota-worker-${index}-${randomUUID()}@example.test`;
      const recipient = (await owner.query<{ id: string }>(`INSERT INTO recipient (tenant_id,email) VALUES ($1,$2) RETURNING id`, [currentTenantId, email])).rows[0];
      await owner.query(`INSERT INTO campaign_recipient (tenant_id,campaign_id,snapshot_id,recipient_id,merge_data_json,email_snapshot,eligibility,status,execution_id,batch_no) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,'sendable','queued',$7,1)`, [currentTenantId, campaign.id, snapshot.id, recipient.id, JSON.stringify({ email }), JSON.stringify({ subject: 'Quota', html: '<p>Quota</p>', textBody: 'Quota' }), execution.id]);
    }
    return { campaignId: campaign.id, executionId: execution.id };
  }

  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: testOwnerDatabaseUrl() });
    tenantId = (await owner.query<{ id: string }>(`INSERT INTO tenant (name) VALUES ($1) RETURNING id`, [`quota-worker-${randomUUID()}`])).rows[0].id;
    unlimitedTenantId = (await owner.query<{ id: string }>(`INSERT INTO tenant (name) VALUES ($1) RETURNING id`, [`quota-worker-unlimited-${randomUUID()}`])).rows[0].id;
    ({ campaignId, executionId } = await createFixture(tenantId, true));
    ({ campaignId: otherCampaignId, executionId: otherExecutionId } = await createFixture(unlimitedTenantId, false));
  }, 60_000);

  afterAll(async () => {
    if (owner) {
      for (const currentTenantId of [tenantId, unlimitedTenantId]) {
        await owner.query(`DELETE FROM quota_reservation WHERE tenant_id=$1`, [currentTenantId]);
        await owner.query(`DELETE FROM sending_policy WHERE tenant_id=$1`, [currentTenantId]);
        await purgeCampaignSendFixtures(owner, currentTenantId, `quota_consume_cleanup_${currentTenantId}`);
        await owner.query(`DELETE FROM recipient WHERE tenant_id=$1`, [currentTenantId]);
        await owner.query(`DELETE FROM email_template WHERE tenant_id=$1`, [currentTenantId]);
        await owner.query(`DELETE FROM tenant WHERE id=$1`, [currentTenantId]);
      }
    }
    await owner?.end();
  }, 60_000);

  it('stops submitting once quota is exhausted and defers the rest', async () => {
    const outcome = await sendClaimedBatch(testAppDatabaseUrl(), testRedisUrl(), tenantId, campaignId, executionId, 10, fakeSend);
    expect(outcome).toEqual({ submitted: 3, retrying: 2, failed: 0 });
    const app = new pg.Pool({ connectionString: testAppDatabaseUrl() });
    const client = await app.connect();
    try {
      await client.query('BEGIN'); await client.query(`SELECT set_config('app.tenant_id',$1,true)`, [tenantId]);
      const deferred = await client.query(`SELECT status,next_retry_at,claimed_at FROM campaign_recipient WHERE execution_id=$1 AND status='queued'`, [executionId]);
      expect(deferred.rows).toHaveLength(2);
      for (const row of deferred.rows) { expect(row.next_retry_at).not.toBeNull(); expect(row.claimed_at).toBeNull(); }
      await client.query('COMMIT');
    } finally { client.release(); await app.end(); }
  }, 30_000);

  it('reservation consumed count matches submitted count', async () => {
    const [row] = (await owner.query(`SELECT amount,consumed FROM quota_reservation WHERE tenant_id=$1 AND campaign_id=$2 AND state='held'`, [tenantId, campaignId])).rows;
    expect(Number(row.consumed)).toBe(3);
  });

  it('tenant with no configured quota is unaffected', async () => {
    expect(await sendClaimedBatch(testAppDatabaseUrl(), testRedisUrl(), unlimitedTenantId, otherCampaignId, otherExecutionId, 10, fakeSend)).toEqual({ submitted: 5, retrying: 0, failed: 0 });
  }, 30_000);
});
