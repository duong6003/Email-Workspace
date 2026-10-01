import pg from 'pg';
import { resolveSenderSecret } from '@eow/sender-credentials';
import { runInTenantTransaction } from '../tenant-database.js';

export type ValidationFailureCode = 'NO_LIVE_SNAPSHOT' | 'SENDER_MISSING' | 'SENDER_NOT_FOUND' | 'SENDER_DISABLED' | 'SENDER_NOT_VERIFIED' | 'SENDER_SECRET_UNRESOLVED';
export type ValidationOutcome =
  | { result: 'validated'; executionId: string }
  | { result: 'failed'; failureCode: ValidationFailureCode }
  | { result: 'not_claimable' };

async function auditExecution(
  client: { query(sql: string, params?: unknown[]): Promise<unknown> },
  tenantId: string,
  campaignId: string,
  action: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (tenant_id, actor_id, action, entity_type, entity_id, trace_id, metadata)
     VALUES ($1, NULL, $2, 'campaign', $3, $4, $5::jsonb)`,
    [tenantId, action, campaignId, `campaign-send:${campaignId}`, JSON.stringify(metadata)],
  );
}

/**
 * BR-SEND-001's "validate" + "freeze" DAG nodes (SS3.4), merged into one
 * function and one tenant transaction: a campaign with no live snapshot has
 * nothing to freeze, so "no live snapshot" is validate's own first blocking
 * cause rather than a separate freeze-node concern. Claim
 * (queued->validating) and the freeze insert are both idempotent by their
 * own WHERE/ON CONFLICT guards (A5) -- re-running this for an
 * already-claimed campaign is a genuine no-op, proven by the caller running
 * it twice and comparing row counts, not by trusting the first result.
 */
export async function runValidation(databaseUrl: string, tenantId: string, campaignId: string): Promise<ValidationOutcome> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  try {
    return await runInTenantTransaction(pool, tenantId, (client) => runValidationInTransaction(client, tenantId, campaignId));
  } finally {
    await pool.end();
  }
}

async function runValidationInTransaction(client: pg.PoolClient, tenantId: string, campaignId: string): Promise<ValidationOutcome> {
  const claimed = (await client.query(
    `UPDATE campaign SET status = 'validating', version = version + 1, updated_at = now()
     WHERE id = $1 AND tenant_id = $2 AND status = 'queued'`,
    [campaignId, tenantId],
  )) as { rowCount: number };
  if (claimed.rowCount === 0) return { result: 'not_claimable' };

  const [snapshot] = ((await client.query(
    `SELECT id, sender_json FROM campaign_snapshot WHERE tenant_id = $1 AND campaign_id = $2 AND superseded_at IS NULL`,
    [tenantId, campaignId],
  )) as { rows: Array<{ id: string; sender_json: { senderConfigId?: string | null; fromEmail?: string | null } }> }).rows;

  if (!snapshot) {
    return failValidation(client, tenantId, campaignId, null, 'NO_LIVE_SNAPSHOT');
  }

  await client.query(
    `INSERT INTO campaign_execution (tenant_id, campaign_id, snapshot_id, correlation_id, sender_config_id, batch_size, max_attempts)
     SELECT $1, $2, $3, $4, $5, COALESCE(p.batch_size, 100), COALESCE(p.max_attempts, 5)
     FROM (SELECT 1) seed
     LEFT JOIN sending_policy p ON p.tenant_id = $1
     ON CONFLICT (campaign_id, snapshot_id) DO NOTHING`,
    [tenantId, campaignId, snapshot.id, `campaign-send:${campaignId}:${snapshot.id}`, snapshot.sender_json?.senderConfigId ?? null],
  );
  const [execution] = ((await client.query(
    `SELECT id FROM campaign_execution WHERE tenant_id = $1 AND campaign_id = $2 AND snapshot_id = $3`,
    [tenantId, campaignId, snapshot.id],
  )) as { rows: Array<{ id: string }> }).rows;

  const senderConfigId = snapshot.sender_json?.senderConfigId;
  if (senderConfigId) {
    const [sender] = ((await client.query(
      `SELECT sender.status, sender.username, sender.secret_ref, credential.ciphertext
       FROM sender_config sender
       LEFT JOIN sender_credential credential
         ON credential.tenant_id = sender.tenant_id AND credential.secret_ref = sender.secret_ref
       WHERE sender.id = $1 AND sender.tenant_id = $2 AND sender.deleted_at IS NULL`,
      [senderConfigId, tenantId],
    )) as { rows: Array<{ status: string; username: string; secret_ref: string; ciphertext: string | null }> }).rows;
    if (!sender) return failValidation(client, tenantId, campaignId, execution.id, 'SENDER_NOT_FOUND');
    if (sender.status === 'disabled') return failValidation(client, tenantId, campaignId, execution.id, 'SENDER_DISABLED');
    // BR-CFG-002/D-113 (DEC-117): `disabled` keeps its own more precise code
    // (A4 already asserts it); every other non-verified status -- `pending`,
    // `failed` -- was silently sendable. sender_config.status regresses to
    // `pending` on any secret or from-address change
    // (sender-config.service.ts:25), so this is reachable *after* a schedule
    // that legitimately passed the API's own check.
    if (sender.status !== 'verified') return failValidation(client, tenantId, campaignId, execution.id, 'SENDER_NOT_VERIFIED');
    if (sender.username) {
      try {
        if (!resolveSenderSecret({ tenantId, secretRef: sender.secret_ref, ciphertext: sender.ciphertext })) {
          return failValidation(client, tenantId, campaignId, execution.id, 'SENDER_SECRET_UNRESOLVED');
        }
      } catch {
        return failValidation(client, tenantId, campaignId, execution.id, 'SENDER_SECRET_UNRESOLVED');
      }
    }
  } else if (!snapshot.sender_json?.fromEmail?.trim()) {
    return failValidation(client, tenantId, campaignId, execution.id, 'SENDER_MISSING');
  }

  await auditExecution(client, tenantId, campaignId, 'campaign_send.validated', { executionId: execution.id });
  return { result: 'validated', executionId: execution.id };
}

async function failValidation(
  client: pg.PoolClient,
  tenantId: string,
  campaignId: string,
  executionId: string | null,
  failureCode: ValidationFailureCode,
): Promise<ValidationOutcome> {
  await client.query(
    `UPDATE campaign SET status = 'failed', version = version + 1, updated_at = now()
     WHERE id = $1 AND tenant_id = $2 AND status = 'validating'`,
    [campaignId, tenantId],
  );
  if (executionId) {
    await client.query(
      `UPDATE campaign_execution SET status = 'failed', failure_code = $3, finished_at = now()
       WHERE id = $1 AND tenant_id = $2 AND status = 'validating'`,
      [executionId, tenantId, failureCode],
    );
  }
  await auditExecution(client, tenantId, campaignId, 'campaign_send.validation_failed', { executionId, failureCode });
  return { result: 'failed', failureCode };
}
