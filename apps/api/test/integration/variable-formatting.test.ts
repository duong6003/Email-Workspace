import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { HttpExceptionFilter } from '../../src/common/http-exception.filter.js';
import { CampaignEntity } from '../../src/database/entities/campaign.entity.js';
import { CampaignRecipientEntity } from '../../src/database/entities/campaign-recipient.entity.js';
import { ConfiguredVariableEntity } from '../../src/database/entities/configured-variable.entity.js';
import { CustomFieldDefinitionEntity } from '../../src/database/entities/custom-field-definition.entity.js';
import { EmailTemplateEntity } from '../../src/database/entities/email-template.entity.js';
import { EmailTemplateVersionEntity } from '../../src/database/entities/email-template-version.entity.js';
import { OutboxEventEntity } from '../../src/database/entities/outbox-event.entity.js';
import { RecipientEntity } from '../../src/database/entities/recipient.entity.js';
import { RecipientListEntity } from '../../src/database/entities/recipient-list.entity.js';
import { SendingPolicyEntity } from '../../src/database/entities/sending-policy.entity.js';
import { TenantEntity } from '../../src/database/entities/tenant.entity.js';
import { runInTenantContext } from '../../src/database/tenant-transaction.js';
import { freezeCampaignSnapshot } from '../../src/campaigns/campaign-snapshot.js';
import type { CampaignActor } from '../../src/campaigns/campaigns.types.js';
import { TemplatesService } from '../../src/templates/templates.service.js';
import { deleteTemplateVersionFixtures } from './template-version-fixtures.js';
import { testDatabaseUrl } from './test-database-url.js';
import { testRedisUrl } from './test-redis-url.js';

/**
 * ADR-036 acceptance, against real PostgreSQL.
 *
 * The whole reason formatting is applied server-side, inside
 * renderTemplateVariables, is that preview (POST /template-versions/:id/preview)
 * and the real send (the campaign snapshot freeze) then agree by construction.
 * These tests drive both paths for one variable and compare the output -- a
 * client-side implementation could not pass them.
 */
describe('typed variable formatting end to end (ADR-036)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let templates: TemplatesService;
  let tenant: TenantEntity;
  const WEB_ORIGIN = 'https://app.example.test';
  const actor: CampaignActor = { actorId: null, traceId: 'variable-formatting-test' };
  /** 2026-09-01T00:00+07:00 is stored by custom-field-values.ts as this instant. */
  const STORED_INSTANT = new Date('2026-09-01T00:00+07:00').toISOString();

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl();
    process.env.REDIS_URL = testRedisUrl();
    process.env.SESSION_SECRET = 'a'.repeat(64);
    process.env.WEB_ORIGIN = WEB_ORIGIN;
    const { AppModule } = await import('../../src/app.module.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
    dataSource = moduleRef.get(getDataSourceToken());
    templates = moduleRef.get(TemplatesService);
    tenant = await dataSource.getRepository(TenantEntity).save({ name: `variable-format-${randomUUID()}` });
    // ADR-036 scope item 3: the tenant default timezone lives on sending_policy.
    await dataSource.getRepository(SendingPolicyEntity).save({ tenantId: tenant.id, defaultTimezone: 'Asia/Bangkok' });
  }, 60_000);

  afterAll(async () => {
    if (!dataSource) { await app?.close(); return; }
    await dataSource.transaction(async (manager) => {
      await manager.query("SELECT pg_advisory_xact_lock(hashtext('eow_variable_formatting_test_cleanup'))");
      await manager.query('ALTER TABLE campaign_recipient DISABLE TRIGGER campaign_recipient_snapshot_immutable_trigger');
      await manager.query('ALTER TABLE campaign_snapshot DISABLE TRIGGER campaign_snapshot_immutable_trigger');
      try {
        await manager.query('DELETE FROM message_attempt WHERE tenant_id = $1', [tenant.id]);
        await manager.query('DELETE FROM campaign_execution WHERE tenant_id = $1', [tenant.id]);
        await manager.query('DELETE FROM campaign_recipient WHERE tenant_id = $1', [tenant.id]);
        await manager.query('DELETE FROM campaign_snapshot WHERE tenant_id = $1', [tenant.id]);
      } finally {
        await manager.query('ALTER TABLE campaign_snapshot ENABLE TRIGGER campaign_snapshot_immutable_trigger');
        await manager.query('ALTER TABLE campaign_recipient ENABLE TRIGGER campaign_recipient_snapshot_immutable_trigger');
      }
    });
    await dataSource.getRepository(OutboxEventEntity).delete({ tenantId: tenant.id });
    await dataSource.query('DELETE FROM campaign WHERE tenant_id = $1', [tenant.id]);
    await deleteTemplateVersionFixtures(dataSource, [tenant.id]);
    await dataSource.getRepository(ConfiguredVariableEntity).delete({ tenantId: tenant.id });
    await dataSource.query('DELETE FROM email_template WHERE tenant_id = $1', [tenant.id]);
    await dataSource.getRepository(CustomFieldDefinitionEntity).delete({ tenantId: tenant.id });
    await dataSource.query('DELETE FROM recipient_list_member WHERE tenant_id = $1', [tenant.id]);
    await dataSource.getRepository(RecipientListEntity).delete({ tenantId: tenant.id });
    await dataSource.getRepository(RecipientEntity).delete({ tenantId: tenant.id });
    await dataSource.getRepository(SendingPolicyEntity).delete({ tenantId: tenant.id });
    // audit_log rows are immutable by trigger, so the tenant row stays as history.
    await app.close();
  }, 60_000);

  async function dateField(overrides: Partial<CustomFieldDefinitionEntity> = {}) {
    return dataSource.getRepository(CustomFieldDefinitionEntity).save({
      tenantId: tenant.id, fieldKey: `ngay_het_han_${randomUUID().slice(0, 8)}`, label: 'Hạn dùng',
      dataType: 'date', required: false, format: null, timezone: null, ...overrides,
    });
  }

  async function publishedVersion(fieldKey: string) {
    const template = await dataSource.getRepository(EmailTemplateEntity).save({ tenantId: tenant.id, name: `template-${randomUUID()}`, status: 'published' });
    return dataSource.getRepository(EmailTemplateVersionEntity).save({
      tenantId: tenant.id, templateId: template.id, version: 1,
      subject: `Hạn dùng {{${fieldKey}}}`,
      html: `<p>Hạn dùng {{${fieldKey}}} - {{unsubscribe_url}}</p>`,
      textBody: `Hạn dùng {{${fieldKey}}}`,
      requiredVariables: [], variableSchemaJson: { required: [], optional: [fieldKey, 'unsubscribe_url'] },
      contentHash: createHash('sha256').update(randomUUID()).digest('hex'), publishedAt: new Date(),
    });
  }

  async function audienceOf(fieldKey: string, value: unknown) {
    const list = await dataSource.getRepository(RecipientListEntity).save({ tenantId: tenant.id, name: `list-${randomUUID()}` });
    const recipient = await dataSource.getRepository(RecipientEntity).save({
      tenantId: tenant.id, email: `format-${randomUUID()}@example.test`, customData: { [fieldKey]: value },
    });
    await dataSource.query(
      'INSERT INTO recipient_list_member (tenant_id, list_id, recipient_id, joined_at, source) VALUES ($1, $2, $3, now(), $4)',
      [tenant.id, list.id, recipient.id, 'manual'],
    );
    return { listId: list.id, recipient };
  }

  async function freeze(versionId: string, listId: string) {
    const campaign = await dataSource.getRepository(CampaignEntity).save({
      tenantId: tenant.id, name: `campaign-${randomUUID()}`, subject: 'Subject', templateVersionId: versionId,
      senderJson: { fromEmail: 'ops@example.test' }, audienceJson: { listIds: [listId] }, settingsJson: {}, status: 'draft', version: 0,
    });
    const result = await runInTenantContext(dataSource, tenant.id, (manager) =>
      freezeCampaignSnapshot(manager, tenant.id, campaign, actor, WEB_ORIGIN, 100_000));
    const [row] = await dataSource.getRepository(CampaignRecipientEntity).find({ where: { snapshotId: result.snapshotId } });
    return row;
  }

  it('renders a date custom field as a human-readable local date in a real send, never as an ISO instant', async () => {
    const field = await dateField();
    const version = await publishedVersion(field.fieldKey);
    const { listId } = await audienceOf(field.fieldKey, STORED_INSTANT);

    const row = await freeze(version.id, listId);

    // Asia/Bangkok is +07:00, so the instant belongs to 1 September there --
    // the off-by-one-day case that motivated ADR-036.
    expect(row.emailSnapshot.subject).toBe('Hạn dùng 01/09/2026');
    expect(row.emailSnapshot.subject).not.toMatch(/T\d{2}:|Z$/);
    expect(row.emailSnapshot.textBody).toBe('Hạn dùng 01/09/2026');
    expect(row.emailSnapshot.html).toContain('Hạn dùng 01/09/2026');
  });

  it('produces preview output identical to the frozen send output for the same variable', async () => {
    const field = await dateField({ format: 'yyyy-MM-dd' });
    const version = await publishedVersion(field.fieldKey);
    const { listId } = await audienceOf(field.fieldKey, STORED_INSTANT);

    const row = await freeze(version.id, listId);
    const preview = await templates.preview(tenant.id, version.id, { mergeData: row.mergeDataJson });

    expect(preview.subject).toBe('Hạn dùng 2026-09-01');
    expect({ subject: preview.subject, html: preview.html, textBody: preview.textBody }).toEqual(row.emailSnapshot);
  });

  it('lets the variable own timezone override the tenant default in both paths', async () => {
    const field = await dateField({ timezone: 'Etc/UTC' });
    const version = await publishedVersion(field.fieldKey);
    const { listId } = await audienceOf(field.fieldKey, STORED_INSTANT);

    const row = await freeze(version.id, listId);
    const preview = await templates.preview(tenant.id, version.id, { mergeData: row.mergeDataJson });

    expect(row.emailSnapshot.subject).toBe('Hạn dùng 31/08/2026');
    expect(preview.subject).toBe(row.emailSnapshot.subject);
  });

  it('formats a typed configured variable, which had no data type at all before ADR-036', async () => {
    const template = await dataSource.getRepository(EmailTemplateEntity).save({ tenantId: tenant.id, name: `template-${randomUUID()}`, status: 'published' });
    const variableKey = `ngay_khai_truong_${randomUUID().slice(0, 8).replaceAll('-', '_')}`;
    await dataSource.getRepository(ConfiguredVariableEntity).save({
      tenantId: tenant.id, scope: 'template', templateId: template.id, variableKey, label: 'Ngày khai trương',
      dataType: 'date', format: 'dd/MM/yyyy', defaultValue: STORED_INSTANT, required: false, allowCampaignOverride: false,
    });
    const version = await dataSource.getRepository(EmailTemplateVersionEntity).save({
      tenantId: tenant.id, templateId: template.id, version: 1,
      subject: `Khai trương {{${variableKey}}}`, html: `<p>{{${variableKey}}}</p>`, textBody: `Khai trương {{${variableKey}}}`,
      requiredVariables: [],
      variableSchemaJson: {
        required: [], optional: [variableKey], defaults: { [variableKey]: STORED_INSTANT },
        configured: { [variableKey]: { label: 'Ngày khai trương', scope: 'template', allowCampaignOverride: false } },
      },
      contentHash: createHash('sha256').update(randomUUID()).digest('hex'), publishedAt: new Date(),
    });

    const preview = await templates.preview(tenant.id, version.id, { mergeData: {} });

    expect(preview.subject).toBe('Khai trương 01/09/2026');
  });

  it('leaves the published version content hash untouched when a format changes (ADR-036)', async () => {
    const field = await dateField();
    const version = await publishedVersion(field.fieldKey);
    const { listId } = await audienceOf(field.fieldKey, STORED_INSTANT);
    const before = await freeze(version.id, listId);

    await dataSource.getRepository(CustomFieldDefinitionEntity).update({ id: field.id }, { format: 'yyyy-MM-dd' });
    const { listId: secondList } = await audienceOf(field.fieldKey, STORED_INSTANT);
    const after = await freeze(version.id, secondList);

    expect(before.emailSnapshot.subject).toBe('Hạn dùng 01/09/2026');
    expect(after.emailSnapshot.subject).toBe('Hạn dùng 2026-09-01');
    const stored = await dataSource.getRepository(EmailTemplateVersionEntity).findOneOrFail({ where: { id: version.id } });
    expect(stored.contentHash).toBe(version.contentHash);
  });
});
