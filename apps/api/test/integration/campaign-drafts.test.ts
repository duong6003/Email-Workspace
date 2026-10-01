import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { DataSource } from 'typeorm';
import type { ValidatedEnv } from '../../src/config/env.js';
import { createDataSource } from '../../src/database/data-source.js';
import { CampaignsService } from '../../src/campaigns/campaigns.service.js';
import { TenantEntity } from '../../src/database/entities/tenant.entity.js';
import { AppUserEntity } from '../../src/database/entities/app-user.entity.js';
import { SenderConfigEntity } from '../../src/database/entities/sender-config.entity.js';
import { testDatabaseUrl } from './test-database-url.js';

/** M5-S2: asDraft() now reads SCHEDULE_LOCK_WINDOW_SECONDS; this suite never exercises scheduling itself, so a fixed stand-in for the real default (env.ts) is enough. */
function fakeConfigService(): ConfigService<ValidatedEnv, true> {
  return { get: () => 120 } as unknown as ConfigService<ValidatedEnv, true>;
}

describe('Campaign draft persistence (M4-S1: BR-CMP-001/011/012)', () => {
  let dataSource: DataSource;
  let service: CampaignsService;
  let tenantA: TenantEntity;
  let tenantB: TenantEntity;
  const actor = { actorId: null, traceId: `campaign-draft-${randomUUID()}` };

  beforeAll(async () => {
    dataSource = createDataSource(testDatabaseUrl());
    await dataSource.initialize();
    const tenants = dataSource.getRepository(TenantEntity);
    tenantA = await tenants.save({ name: `campaign-drafts-a-${randomUUID()}` });
    tenantB = await tenants.save({ name: `campaign-drafts-b-${randomUUID()}` });
    service = new CampaignsService(dataSource, fakeConfigService(), undefined as never, undefined as never);
  });

  afterAll(async () => {
    if (!dataSource?.isInitialized) return;
    await dataSource.transaction(async (manager) => {
      await manager.query("SELECT pg_advisory_xact_lock(hashtext('eow_campaign_draft_test_cleanup'))");
      await manager.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_immutable');
      try {
        await manager.query('DELETE FROM audit_log WHERE tenant_id = ANY($1)', [[tenantA.id, tenantB.id]]);
      } finally {
        await manager.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_immutable');
      }
    });
    await dataSource.query('DELETE FROM sending_policy WHERE tenant_id = ANY($1)', [[tenantA.id, tenantB.id]]);
    await dataSource.query('DELETE FROM campaign WHERE tenant_id = ANY($1)', [[tenantA.id, tenantB.id]]);
    await dataSource.query('DELETE FROM sender_config WHERE tenant_id = ANY($1)', [[tenantA.id, tenantB.id]]);
    await dataSource.query('DELETE FROM app_user WHERE tenant_id = ANY($1)', [[tenantA.id, tenantB.id]]);
    await dataSource.getRepository(TenantEntity).delete([tenantA.id, tenantB.id]);
    await dataSource.destroy();
  });

  it('persists a draft and serializes the server-owned completeness score', async () => {
    const draft = await service.createDraft(tenantA.id, {
      name: '  August renewal  ',
      subject: '  Renew today  ',
      sender: { fromEmail: 'ops@example.com' },
      audience: { recipientIds: [randomUUID()] },
    }, actor);

    expect(draft).toMatchObject({
      name: 'August renewal',
      subject: 'Renew today',
      status: 'draft',
      version: 0,
      completeness: 80,
    });
    await expect(service.getDraft(tenantA.id, draft.id)).resolves.toMatchObject({ id: draft.id, name: 'August renewal' });
  });

  it('copies the verified tenant default sender into a new draft once', async () => {
    const user = await dataSource.getRepository(AppUserEntity).save({ tenantId: tenantA.id, email: `owner-${randomUUID()}@test.dev`, displayName: 'Owner', role: 'operator', passwordHash: null, status: 'active' });
    const sender = await dataSource.getRepository(SenderConfigEntity).save({ tenantId: tenantA.id, name: 'Default sender', fromName: 'Operations', fromEmail: 'ops@example.test', replyTo: null, provider: 'smtp', host: 'mailpit', port: 1025, username: '', secretRef: 'TEST_SECRET', status: 'verified', verifiedAt: new Date(), lastTestedAt: new Date(), createdBy: user.id, updatedBy: user.id, deletedAt: null });
    await dataSource.query('INSERT INTO sending_policy (tenant_id, default_sender_config_id, reply_to, updated_by) VALUES ($1, $2, $3, $4)', [tenantA.id, sender.id, 'reply@example.test', user.id]);

    const draft = await service.createDraft(tenantA.id, { name: 'Uses default' }, { actorId: user.id, traceId: actor.traceId });
    expect(draft.sender).toEqual({ senderConfigId: sender.id, fromName: 'Operations', fromEmail: 'ops@example.test', replyTo: 'reply@example.test' });
    expect(draft.ownerId).toBe(user.id);
  });

  it('serializes writes, rejects stale versions, and never mutates the stale write', async () => {
    const draft = await service.createDraft(tenantA.id, { name: `Autosave ${randomUUID()}` }, actor);
    const first = await service.updateDraft(tenantA.id, draft.id, draft.version, { subject: 'First write' }, actor);
    const second = await service.updateDraft(tenantA.id, draft.id, first.version, { subject: 'Last write' }, actor);

    await expect(service.updateDraft(tenantA.id, draft.id, draft.version, { subject: 'Stale write' }, actor))
      .rejects.toMatchObject({ getStatus: expect.any(Function), status: 412 });
    await expect(service.getDraft(tenantA.id, draft.id)).resolves.toMatchObject({ subject: 'Last write', version: second.version });
  });

  it('hides another tenant draft and copies no delivery progress when duplicating', async () => {
    const original = await service.createDraft(tenantA.id, { name: `Duplicate ${randomUUID()}`, subject: 'Copy me' }, actor);
    const duplicate = await service.duplicateDraft(tenantA.id, original.id, actor);

    expect(duplicate).toMatchObject({ name: original.name, subject: 'Copy me', status: 'draft', version: 0 });
    expect(duplicate.id).not.toBe(original.id);
    await expect(service.getDraft(tenantB.id, original.id)).rejects.toMatchObject({ status: 404 });
    const [progress] = await dataSource.query('SELECT count(*)::int AS count FROM campaign_recipient WHERE campaign_id = $1', [duplicate.id]);
    expect(progress.count).toBe(0);
  });

  /**
   * ADR-034, cross-tenant negative test for 'POST /campaigns/bulk'.
   *
   * Bulk takes a client-supplied id list, which is exactly the shape that
   * invites a cross-tenant read: tenant B can name tenant A's campaign id and
   * the server must not act on it. The tenant context makes the row invisible
   * rather than forbidden, so the row comes back as a failure with
   * CAMPAIGN_NOT_FOUND -- and, critically, tenant A's draft must survive.
   */
  it('does not act on another tenant campaign named in a bulk request', async () => {
    const draft = await service.createDraft(tenantA.id, { name: `Bulk isolation ${randomUUID()}` }, actor);
    const bulkActor = { ...actor, permissions: ['content:manage', 'campaign:manage'] };

    const result = await service.bulkAction(tenantB.id, { action: 'delete', campaignIds: [draft.id] }, bulkActor);

    expect(result).toMatchObject({ succeeded: 0, failed: 1, skipped: 0 });
    expect(result.results[0]).toMatchObject({ campaignId: draft.id, outcome: 'failed', code: 'CAMPAIGN_NOT_FOUND' });
    await expect(service.getDraft(tenantA.id, draft.id)).resolves.toMatchObject({ id: draft.id });
  });

  it('reports a per-campaign outcome for every id and never aborts on one failure', async () => {
    const deletable = await service.createDraft(tenantA.id, { name: `Bulk deletable ${randomUUID()}` }, actor);
    const sending = await service.createDraft(tenantA.id, { name: `Bulk sending ${randomUUID()}` }, actor);
    await dataSource.query("UPDATE campaign SET status = 'sending' WHERE id = $1", [sending.id]);
    const bulkActor = { ...actor, permissions: ['content:manage', 'campaign:manage'] };

    const result = await service.bulkAction(
      tenantA.id,
      { action: 'delete', campaignIds: [deletable.id, sending.id, randomUUID()] },
      bulkActor,
    );

    expect(result).toMatchObject({ succeeded: 1, failed: 1, skipped: 1 });
    expect(result.results.map((row) => row.code)).toEqual(['OK', 'CAMPAIGN_NOT_DRAFT', 'CAMPAIGN_NOT_FOUND']);
    await expect(service.getDraft(tenantA.id, deletable.id)).rejects.toMatchObject({ status: 404 });
  });

  it('refuses a bulk action the actor lacks the permission for', async () => {
    const draft = await service.createDraft(tenantA.id, { name: `Bulk perm ${randomUUID()}` }, actor);
    const readOnly = { ...actor, permissions: ['campaign:read'] };

    await expect(service.bulkAction(tenantA.id, { action: 'delete', campaignIds: [draft.id] }, readOnly))
      .rejects.toMatchObject({ status: 403 });
  });

  it('rejects edit-after-send at the service and database layers', async () => {
    const draft = await service.createDraft(tenantA.id, { name: `Locked ${randomUUID()}` }, actor);
    await dataSource.query("UPDATE campaign SET status = 'sending' WHERE id = $1", [draft.id]);

    await expect(service.updateDraft(tenantA.id, draft.id, draft.version, { subject: 'Blocked' }, actor)).rejects.toMatchObject({ status: 409 });
    await expect(dataSource.query("UPDATE campaign SET subject = 'Blocked by SQL' WHERE id = $1", [draft.id])).rejects.toMatchObject({ code: '55000' });
  });

  it('allows an unnamed draft in PostgreSQL and audits each named draft mutation', async () => {
    await expect(dataSource.query("INSERT INTO campaign (tenant_id, name) VALUES ($1, '')", [tenantA.id])).resolves.toBeDefined();
    const draft = await service.createDraft(tenantA.id, { name: `Audit ${randomUUID()}` }, actor);
    await service.updateDraft(tenantA.id, draft.id, draft.version, { subject: 'Audited' }, actor);
    await service.duplicateDraft(tenantA.id, draft.id, actor);
    await service.deleteDraft(tenantA.id, draft.id, 1, actor);

    const rows = await dataSource.query(
      "SELECT action, metadata->>'name' AS name FROM audit_log WHERE entity_type = 'campaign' AND entity_id = $1 ORDER BY occurred_at",
      [draft.id],
    ) as Array<{ action: string; name: string }>;
    expect(rows.map((row) => row.action)).toEqual(['campaign.draft_created', 'campaign.draft_updated', 'campaign.draft_deleted']);
    expect(rows.every((row) => row.name === draft.name)).toBe(true);
  });

  it('accepts every BR-SEND-001 execution state plus draft/scheduled, and rejects an unknown status', async () => {
    // BR-CMP-001 (draft), BR-SCH-* (scheduled) and BR-SEND-001's literal state
    // machine ("queued, validating, sending, paused, completed,
    // partial_failed, failed hoặc cancelled") together define every status
    // this column may ever hold. Migration 017's own CHECK only listed 6 of
    // these 10 -- found because a real M2-S1 test (recipients.test.ts,
    // BR-REC-010) inserted a campaign row with status 'sent' and hit
    // campaign_status_known on the widened table for the first time.
    const knownStatuses = ['draft', 'scheduled', 'queued', 'validating', 'sending', 'paused', 'completed', 'partial_failed', 'failed', 'cancelled'];
    for (const status of knownStatuses) {
      await expect(
        dataSource.query('INSERT INTO campaign (tenant_id, name, status) VALUES ($1, $2, $3)', [tenantA.id, `status-${status}-${randomUUID()}`, status]),
      ).resolves.toBeDefined();
    }
    await expect(
      dataSource.query("INSERT INTO campaign (tenant_id, name, status) VALUES ($1, $2, 'not_a_real_status')", [tenantA.id, `status-invalid-${randomUUID()}`]),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
