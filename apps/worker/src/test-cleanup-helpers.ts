import pg from 'pg';

/**
 * M5-S3 CP4 fix: ALTER TABLE ... DISABLE/ENABLE TRIGGER is global DDL, not
 * connection- or transaction-scoped by itself. The pre-existing pattern
 * (campaign-dispatcher.integration.test.ts) issued each statement via
 * pool.query(), which can round-robin a *different* physical connection per
 * call -- so pg_advisory_xact_lock's own "xact" scoping did nothing useful
 * across the sequence, and a second test file's ENABLE could land while a
 * first file's DELETE was still in flight ("Published template versions are
 * immutable"). Adding three more worker test files with the same pattern in
 * this same checkpoint made that race hit in practice. Fixed by running the
 * whole disable -> delete -> enable sequence on one checked-out client
 * inside one real transaction, so the advisory lock actually serializes
 * concurrent callers and the trigger is never visible as re-enabled to a
 * peer transaction mid-delete.
 */
export async function purgeCampaignSendFixtures(pool: pg.Pool, tenantId: string, lockKey: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey]);
    await client.query('ALTER TABLE campaign_recipient DISABLE TRIGGER campaign_recipient_snapshot_immutable_trigger');
    await client.query('ALTER TABLE campaign_snapshot DISABLE TRIGGER campaign_snapshot_immutable_trigger');
    await client.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_immutable');
    await client.query('ALTER TABLE email_template_version DISABLE TRIGGER email_template_version_immutable_trigger');
    // M5-S4 CP1 (R7): delivery_event.campaign_recipient_id is NOT NULL
    // REFERENCES campaign_recipient(id), so it must be deleted before that
    // table -- the same FK-ordering class D-93 already produced once for
    // campaign_snapshot, fixed here before the first violation rather than
    // after (AGENTS.md SS2's own lesson).
    await client.query('DELETE FROM delivery_event WHERE tenant_id = $1', [tenantId]);
    await client.query('DELETE FROM message_attempt WHERE tenant_id = $1', [tenantId]);
    await client.query('DELETE FROM campaign_execution WHERE tenant_id = $1', [tenantId]);
    await client.query('DELETE FROM campaign_recipient WHERE tenant_id = $1', [tenantId]);
    await client.query('DELETE FROM campaign_snapshot WHERE tenant_id = $1', [tenantId]);
    await client.query('DELETE FROM audit_log WHERE tenant_id = $1', [tenantId]);
    await client.query('DELETE FROM outbox_event WHERE tenant_id = $1', [tenantId]);
    await client.query('DELETE FROM campaign WHERE tenant_id = $1', [tenantId]);
    await client.query('DELETE FROM email_template_version WHERE tenant_id = $1', [tenantId]);
    await client.query('ALTER TABLE email_template_version ENABLE TRIGGER email_template_version_immutable_trigger');
    await client.query('ALTER TABLE campaign_snapshot ENABLE TRIGGER campaign_snapshot_immutable_trigger');
    await client.query('ALTER TABLE campaign_recipient ENABLE TRIGGER campaign_recipient_snapshot_immutable_trigger');
    await client.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_immutable');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
