import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { createDataSource } from '../../src/database/data-source.js';
import { runInTenantContext } from '../../src/database/tenant-transaction.js';
import { TenantEntity } from '../../src/database/entities/tenant.entity.js';
import { RecipientEntity } from '../../src/database/entities/recipient.entity.js';
import { RecipientListEntity } from '../../src/database/entities/recipient-list.entity.js';
import { EmailTemplateEntity } from '../../src/database/entities/email-template.entity.js';
import { EmailTemplateVersionEntity, type TemplateVariableSchema } from '../../src/database/entities/email-template-version.entity.js';
import { CustomFieldDefinitionEntity } from '../../src/database/entities/custom-field-definition.entity.js';
import { CampaignEntity, type CampaignAudience } from '../../src/database/entities/campaign.entity.js';
import { CampaignSnapshotEntity } from '../../src/database/entities/campaign-snapshot.entity.js';
import { CampaignRecipientEntity } from '../../src/database/entities/campaign-recipient.entity.js';
import { recipientVariableContext } from '../../src/campaigns/recipient-variable-context.js';
import { renderTemplateVariables } from '../../src/templates/template-variable-renderer.js';
import { freezeCampaignSnapshot } from '../../src/campaigns/campaign-snapshot.js';
import type { CampaignActor } from '../../src/campaigns/campaigns.types.js';
import { testDatabaseUrl } from './test-database-url.js';
import { deleteTemplateVersionFixtures } from './template-version-fixtures.js';

/**
 * M4-S4 CP2 (BR-CMP-007, BR-CMP-010, BR-TPL-012). freezeCampaignSnapshot is
 * exercised directly against real PostgreSQL, the same non-HTTP integration
 * shape campaign-variable-validation.test.ts already established for M4-S3
 * -- HTTP wiring (idempotency, sendCampaign/cancelCampaign) is CP3.
 */
describe('freezeCampaignSnapshot (M4-S4 CP2)', () => {
  let dataSource: DataSource;
  let tenantA: TenantEntity;
  let tenantB: TenantEntity;
  const WEB_ORIGIN = 'https://app.example.test';
  const actor: CampaignActor = { actorId: null, traceId: 'test-trace' };

  beforeAll(async () => {
    dataSource = createDataSource(testDatabaseUrl());
    await dataSource.initialize();
    const tenants = dataSource.getRepository(TenantEntity);
    tenantA = await tenants.save({ name: `snapfreeze-a-${randomUUID()}` });
    tenantB = await tenants.save({ name: `snapfreeze-b-${randomUUID()}` });
  });

  afterAll(async () => {
    await dataSource.transaction(async (manager) => {
      await manager.query("SELECT pg_advisory_xact_lock(hashtext('eow_campaign_snapshot_freeze_test_cleanup'))");
      await manager.query('ALTER TABLE campaign_recipient DISABLE TRIGGER campaign_recipient_snapshot_immutable_trigger');
      await manager.query('ALTER TABLE campaign_snapshot DISABLE TRIGGER campaign_snapshot_immutable_trigger');
      try {
        // M5-S3 CP3: a concurrently-running campaign-send-scan can freeze
        // one of these campaigns the instant it reaches 'queued'.
        await manager.query('DELETE FROM message_attempt WHERE tenant_id = ANY($1)', [[tenantA.id, tenantB.id]]);
        await manager.query('DELETE FROM campaign_execution WHERE tenant_id = ANY($1)', [[tenantA.id, tenantB.id]]);
        await manager.query('DELETE FROM campaign_recipient WHERE tenant_id = ANY($1)', [[tenantA.id, tenantB.id]]);
        await manager.query('DELETE FROM campaign_snapshot WHERE tenant_id = ANY($1)', [[tenantA.id, tenantB.id]]);
      } finally {
        await manager.query('ALTER TABLE campaign_snapshot ENABLE TRIGGER campaign_snapshot_immutable_trigger');
        await manager.query('ALTER TABLE campaign_recipient ENABLE TRIGGER campaign_recipient_snapshot_immutable_trigger');
      }
    });
    await dataSource.query('DELETE FROM outbox_event WHERE tenant_id = ANY($1)', [[tenantA.id, tenantB.id]]);
    // audit_log is immutable by trigger (005_audit_log_immutability.sql, BR-SEC-002)
    // and freezeCampaignSnapshot writes to it, so -- like campaign-snapshot-immutability.test.ts --
    // this fixture cannot delete its tenant rows; campaign/template/recipient rows are cleaned,
    // audit_log/outbox_event/tenant are left as permanent history.
    await dataSource.query('DELETE FROM campaign WHERE tenant_id = ANY($1)', [[tenantA.id, tenantB.id]]);
    await deleteTemplateVersionFixtures(dataSource, [tenantA.id, tenantB.id]);
    await dataSource.getRepository(EmailTemplateEntity).delete({ tenantId: tenantA.id });
    await dataSource.getRepository(EmailTemplateEntity).delete({ tenantId: tenantB.id });
    await dataSource.getRepository(CustomFieldDefinitionEntity).delete({ tenantId: tenantA.id });
    await dataSource.query('DELETE FROM recipient_list_member WHERE tenant_id = ANY($1)', [[tenantA.id, tenantB.id]]);
    await dataSource.getRepository(RecipientListEntity).delete({ tenantId: tenantA.id });
    await dataSource.getRepository(RecipientEntity).delete({ tenantId: tenantA.id });
    await dataSource.getRepository(RecipientEntity).delete({ tenantId: tenantB.id });
    await dataSource.destroy();
  });

  async function recipient(tenantId: string, overrides: Partial<RecipientEntity> = {}) {
    return dataSource.getRepository(RecipientEntity).save({ tenantId, email: `snapfreeze-${randomUUID()}@example.test`, ...overrides });
  }

  async function list(tenantId: string) {
    return dataSource.getRepository(RecipientListEntity).save({ tenantId, name: `list-${randomUUID()}` });
  }

  async function addToList(tenantId: string, listId: string, recipientId: string) {
    await dataSource.query(
      'INSERT INTO recipient_list_member (tenant_id, list_id, recipient_id, joined_at, source) VALUES ($1, $2, $3, now(), $4)',
      [tenantId, listId, recipientId, 'manual'],
    );
  }

  async function templateVersion(tenantId: string, schema: TemplateVariableSchema, overrides: Partial<EmailTemplateVersionEntity> = {}) {
    const template = await dataSource.getRepository(EmailTemplateEntity).save({ tenantId, name: `template-${randomUUID()}`, status: 'published' });
    return dataSource.getRepository(EmailTemplateVersionEntity).save({
      tenantId, templateId: template.id, version: 1,
      subject: 'Hello {{first_name}}', html: '<p>{{first_name}} from {{city}}, {{unsubscribe_url}}</p>', textBody: 'Hello {{first_name}}',
      requiredVariables: schema.required, variableSchemaJson: schema, contentHash: createHash('sha256').update(randomUUID()).digest('hex'), publishedAt: new Date(),
      ...overrides,
    });
  }

  async function customField(tenantId: string, overrides: Partial<CustomFieldDefinitionEntity> = {}) {
    return dataSource.getRepository(CustomFieldDefinitionEntity).save({
      tenantId, fieldKey: `city_${randomUUID().slice(0, 8)}`, label: 'City', dataType: 'text', required: false, ...overrides,
    });
  }

  async function draftCampaign(tenantId: string, templateVersionId: string, audienceJson: CampaignAudience) {
    return dataSource.getRepository(CampaignEntity).save({
      tenantId, name: `campaign-${randomUUID()}`, subject: 'Subject', templateVersionId,
      senderJson: { fromEmail: 'ops@example.com' }, audienceJson, settingsJson: {}, status: 'draft', version: 0,
    });
  }

  async function freeze(tenantId: string, campaign: CampaignEntity, audienceLimit = 100_000) {
    return runInTenantContext(dataSource, tenantId, (manager) => freezeCampaignSnapshot(manager, tenantId, campaign, actor, WEB_ORIGIN, audienceLimit));
  }

  it('A1: freezes one campaign_snapshot row and one campaign_recipient row per actionable recipient, and moves the campaign to queued', async () => {
    const version = await templateVersion(tenantA.id, { required: [], optional: ['first_name'], defaults: {} });
    const l = await list(tenantA.id);
    const r1 = await recipient(tenantA.id, { firstName: 'Ada' });
    const r2 = await recipient(tenantA.id, { firstName: 'Bao' });
    await addToList(tenantA.id, l.id, r1.id);
    await addToList(tenantA.id, l.id, r2.id);
    const campaign = await draftCampaign(tenantA.id, version.id, { listIds: [l.id] });

    const result = await freeze(tenantA.id, campaign);

    expect(result).toMatchObject({ campaignId: campaign.id, status: 'queued', totalSnapshot: 2, sendableCount: 2, skippedCount: 0 });

    const snapshotRow = await dataSource.getRepository(CampaignSnapshotEntity).findOneOrFail({ where: { id: result.snapshotId } });
    expect(snapshotRow).toMatchObject({ campaignId: campaign.id, templateVersionId: version.id, totalSnapshot: 2, sendableCount: 2, skippedCount: 0, supersededAt: null });

    const recipientRows = await dataSource.getRepository(CampaignRecipientEntity).find({ where: { snapshotId: result.snapshotId } });
    expect(recipientRows).toHaveLength(2);
    expect(recipientRows.every((row) => row.eligibility === 'sendable')).toBe(true);
    expect(recipientRows.every((row) => row.skippedReason === null)).toBe(true);
    expect(new Set(recipientRows.map((row) => row.recipientId))).toEqual(new Set([r1.id, r2.id]));

    const updatedCampaign = await dataSource.getRepository(CampaignEntity).findOneOrFail({ where: { id: campaign.id } });
    expect(updatedCampaign.status).toBe('queued');
    expect(updatedCampaign.version).toBe(campaign.version + 1);
  });

  it('A2: the frozen merge_data_json is byte-identical to a direct recipientVariableContext() call for the same recipient', async () => {
    const field = await customField(tenantA.id);
    const version = await templateVersion(tenantA.id, { required: [], optional: ['first_name', 'city'], defaults: {} });
    const l = await list(tenantA.id);
    const r1 = await recipient(tenantA.id, { firstName: 'Ada', customData: { [field.fieldKey]: 'Hanoi' } });
    await addToList(tenantA.id, l.id, r1.id);
    const customFields = await dataSource.getRepository(CustomFieldDefinitionEntity).find({ where: { tenantId: tenantA.id } });
    const expectedContext = recipientVariableContext(r1, customFields, WEB_ORIGIN);
    const campaign = await draftCampaign(tenantA.id, version.id, { listIds: [l.id] });

    const result = await freeze(tenantA.id, campaign);

    const [row] = await dataSource.getRepository(CampaignRecipientEntity).find({ where: { snapshotId: result.snapshotId } });
    expect(row.mergeDataJson).toEqual(expectedContext);
    expect(row.emailSnapshot.subject).toBe('Hello Ada');
  });

  it('M4-GATE reproducibility: re-rendering a frozen snapshot from its own stored inputs yields byte-identical output', async () => {
    const field = await customField(tenantA.id);
    const version = await templateVersion(tenantA.id, {
      required: ['first_name', field.fieldKey], optional: [], defaults: {},
    }, { subject: 'Chào {{first_name}}', html: '<p>{{first_name}} tại {{' + field.fieldKey + '}}, {{unsubscribe_url}}</p>', textBody: 'Chào {{first_name}} tại {{' + field.fieldKey + '}}' });
    const l = await list(tenantA.id);
    const r1 = await recipient(tenantA.id, { firstName: 'Minh An', customData: { [field.fieldKey]: 'Hà Nội' } });
    const r2 = await recipient(tenantA.id, { firstName: 'Bao', customData: { [field.fieldKey]: 'Sài Gòn' } });
    await addToList(tenantA.id, l.id, r1.id);
    await addToList(tenantA.id, l.id, r2.id);
    const campaign = await draftCampaign(tenantA.id, version.id, { listIds: [l.id] });

    const result = await freeze(tenantA.id, campaign);

    const rows = await dataSource.getRepository(CampaignRecipientEntity).find({ where: { snapshotId: result.snapshotId } });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const reRendered = renderTemplateVariables(
        { subject: version.subject, html: version.html, textBody: version.textBody },
        version.variableSchemaJson,
        row.mergeDataJson,
      );
      expect('code' in reRendered).toBe(false);
      expect(reRendered).toEqual(row.emailSnapshot);
    }
  });

  it('BR-CMP-007: an audience-level skip (excluded recipient) is frozen as its own row with its reason, not dropped', async () => {
    const version = await templateVersion(tenantA.id, { required: [], optional: [], defaults: {} });
    const l = await list(tenantA.id);
    const sendable = await recipient(tenantA.id);
    const paused = await recipient(tenantA.id, { subscriptionStatus: 'paused' });
    await addToList(tenantA.id, l.id, sendable.id);
    await addToList(tenantA.id, l.id, paused.id);
    const campaign = await draftCampaign(tenantA.id, version.id, { listIds: [l.id] });

    const result = await freeze(tenantA.id, campaign);

    expect(result).toMatchObject({ totalSnapshot: 2, sendableCount: 1, skippedCount: 1 });
    const rows = await dataSource.getRepository(CampaignRecipientEntity).find({ where: { snapshotId: result.snapshotId } });
    const pausedRow = rows.find((row) => row.recipientId === paused.id)!;
    expect(pausedRow.eligibility).toBe('skipped');
    expect(pausedRow.skippedReason).toBe('status_paused');
  });

  it('A15: a required variable missing with no waiver refuses the freeze with 422, leaving the campaign in draft', async () => {
    const version = await templateVersion(tenantA.id, { required: ['city'], optional: [], defaults: {} });
    const l = await list(tenantA.id);
    const missing = await recipient(tenantA.id);
    await addToList(tenantA.id, l.id, missing.id);
    const campaign = await draftCampaign(tenantA.id, version.id, { listIds: [l.id] });

    await expect(freeze(tenantA.id, campaign)).rejects.toMatchObject({ status: 422 });

    const untouched = await dataSource.getRepository(CampaignEntity).findOneOrFail({ where: { id: campaign.id } });
    expect(untouched.status).toBe('draft');
    expect(untouched.version).toBe(campaign.version);
  });

  it('A15: a valid waiver covering the missing recipient lets the freeze proceed, recording that recipient as missing_required_variable', async () => {
    const field = await customField(tenantA.id);
    const version = await templateVersion(tenantA.id, { required: [field.fieldKey], optional: [], defaults: {} });
    const l = await list(tenantA.id);
    const complete = await recipient(tenantA.id, { customData: { [field.fieldKey]: 'Hanoi' } });
    const missing = await recipient(tenantA.id);
    await addToList(tenantA.id, l.id, complete.id);
    await addToList(tenantA.id, l.id, missing.id);
    const campaign = await draftCampaign(tenantA.id, version.id, { listIds: [l.id] });
    campaign.settingsJson = { audienceWaiver: { acceptedAt: new Date().toISOString(), acceptedBy: null, missingVariableRecipientIds: [missing.id] } };
    await dataSource.getRepository(CampaignEntity).save(campaign);

    const result = await freeze(tenantA.id, campaign);

    expect(result).toMatchObject({ totalSnapshot: 2, sendableCount: 1, skippedCount: 1 });
    const rows = await dataSource.getRepository(CampaignRecipientEntity).find({ where: { snapshotId: result.snapshotId } });
    const missingRow = rows.find((row) => row.recipientId === missing.id)!;
    expect(missingRow.eligibility).toBe('skipped');
    expect(missingRow.skippedReason).toBe('missing_required_variable');
  });

  it('A15: a stale waiver (missing set changed since acceptance) still refuses the freeze with 422', async () => {
    const version = await templateVersion(tenantA.id, { required: ['city'], optional: [], defaults: {} });
    const l = await list(tenantA.id);
    const missing = await recipient(tenantA.id);
    await addToList(tenantA.id, l.id, missing.id);
    const campaign = await draftCampaign(tenantA.id, version.id, { listIds: [l.id] });
    campaign.settingsJson = { audienceWaiver: { acceptedAt: new Date().toISOString(), acceptedBy: null, missingVariableRecipientIds: [randomUUID()] } };
    await dataSource.getRepository(CampaignEntity).save(campaign);

    await expect(freeze(tenantA.id, campaign)).rejects.toMatchObject({ status: 422 });
  });

  it('A16: a recipient belonging to another tenant is never resolved into the freeze', async () => {
    const version = await templateVersion(tenantA.id, { required: [], optional: [], defaults: {} });
    const crossTenantRecipient = await recipient(tenantB.id);
    const campaign = await draftCampaign(tenantA.id, version.id, { recipientIds: [crossTenantRecipient.id] });

    await expect(freeze(tenantA.id, campaign)).rejects.toMatchObject({ status: 422 });
  });

  it('A17: an audience larger than the configured limit refuses the freeze with 422, re-checking independently of previewAudience', async () => {
    const version = await templateVersion(tenantA.id, { required: [], optional: [], defaults: {} });
    const l = await list(tenantA.id);
    const r1 = await recipient(tenantA.id);
    const r2 = await recipient(tenantA.id);
    await addToList(tenantA.id, l.id, r1.id);
    await addToList(tenantA.id, l.id, r2.id);
    const campaign = await draftCampaign(tenantA.id, version.id, { listIds: [l.id] });

    await expect(freeze(tenantA.id, campaign, 1)).rejects.toMatchObject({ status: 422 });
  });

  it('refuses to freeze a campaign that has no template version selected, with 422', async () => {
    const campaign = await draftCampaign(tenantA.id, null as unknown as string, {});
    await dataSource.getRepository(CampaignEntity).update(campaign.id, { templateVersionId: null });
    const reloaded = await dataSource.getRepository(CampaignEntity).findOneOrFail({ where: { id: campaign.id } });

    await expect(freeze(tenantA.id, reloaded)).rejects.toMatchObject({ status: 422 });
  });

  it('refuses to freeze a campaign that is not in draft status, with 409', async () => {
    const version = await templateVersion(tenantA.id, { required: [], optional: [], defaults: {} });
    const campaign = await draftCampaign(tenantA.id, version.id, {});
    campaign.status = 'queued';
    await dataSource.getRepository(CampaignEntity).save(campaign);

    await expect(freeze(tenantA.id, campaign)).rejects.toMatchObject({ status: 409 });
  });
});
