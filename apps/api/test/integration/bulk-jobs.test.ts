import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HttpException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { createDataSource } from '../../src/database/data-source.js';
import { TenantEntity } from '../../src/database/entities/tenant.entity.js';
import { RecipientEntity } from '../../src/database/entities/recipient.entity.js';
import { BulkJobEntity } from '../../src/database/entities/bulk-job.entity.js';
import { BulkJobRowEntity } from '../../src/database/entities/bulk-job-row.entity.js';
import { OutboxEventEntity } from '../../src/database/entities/outbox-event.entity.js';
import { IdempotencyKeyEntity } from '../../src/database/entities/idempotency-key.entity.js';
import { IdempotencyService } from '../../src/common/idempotency.service.js';
import { CustomFieldsService } from '../../src/custom-fields/custom-fields.service.js';
import { CustomFieldDefinitionEntity } from '../../src/database/entities/custom-field-definition.entity.js';
import { BulkJobsService } from '../../src/jobs/bulk-jobs.service.js';
import { testDatabaseUrl } from './test-database-url.js';

describe('Bulk jobs (M2-S4: BR-GEN-005, BR-CF-004/005/007)', () => {
  let dataSource: DataSource;
  let tenantA: TenantEntity;
  let tenantB: TenantEntity;

  beforeAll(async () => {
    dataSource = createDataSource(testDatabaseUrl());
    await dataSource.initialize();
    const tenants = dataSource.getRepository(TenantEntity);
    tenantA = await tenants.save({ name: `bulk-job-tenant-a-${randomUUID()}` });
    tenantB = await tenants.save({ name: `bulk-job-tenant-b-${randomUUID()}` });
    await dataSource.getRepository(CustomFieldDefinitionEntity).save([
      { tenantId: tenantA.id, fieldKey: 'tier', label: 'Tier', dataType: 'text', required: false, sensitive: false },
      { tenantId: tenantB.id, fieldKey: 'tier', label: 'Tier', dataType: 'text', required: false, sensitive: false },
    ] as never);
  });

  afterAll(async () => {
    const jobs = dataSource.getRepository(BulkJobEntity);
    const tenantAJobs = await jobs.find({ where: { tenantId: tenantA.id } });
    const tenantBJobs = await jobs.find({ where: { tenantId: tenantB.id } });
    const jobIds = [...tenantAJobs, ...tenantBJobs].map((job) => job.id);
    if (jobIds.length > 0) {
      await dataSource.getRepository(BulkJobRowEntity).createQueryBuilder().delete().where('job_id IN (:...jobIds)', { jobIds }).execute();
      await dataSource.getRepository(OutboxEventEntity).createQueryBuilder().delete().where('aggregate_type = :type AND aggregate_id IN (:...jobIds)', { type: 'bulk_job', jobIds }).execute();
      await jobs.createQueryBuilder().delete().where('id IN (:...jobIds)', { jobIds }).execute();
    }
    await dataSource.getRepository(RecipientEntity).delete({ tenantId: tenantA.id });
    await dataSource.getRepository(RecipientEntity).delete({ tenantId: tenantB.id });
    await dataSource.getRepository(CustomFieldDefinitionEntity).delete({ tenantId: tenantA.id });
    await dataSource.getRepository(CustomFieldDefinitionEntity).delete({ tenantId: tenantB.id });
    await dataSource.getRepository(IdempotencyKeyEntity).createQueryBuilder().delete().where('tenant_id IN (:...tenantIds)', { tenantIds: [tenantA.id, tenantB.id] }).execute();
    await dataSource.getRepository(TenantEntity).delete([tenantA.id, tenantB.id]);
    await dataSource.destroy();
  });

  function service(): BulkJobsService {
    return new BulkJobsService(dataSource, new IdempotencyService(), new CustomFieldsService(dataSource));
  }

  async function expectHttpStatus(promise: Promise<unknown>, status: number): Promise<HttpException> {
    try {
      await promise;
    } catch (error) {
      expect((error as HttpException).getStatus()).toBe(status);
      return error as HttpException;
    }
    throw new Error(`Expected a rejection with status ${status}, but the promise resolved.`);
  }

  it('resolves selected recipients once, freezes the snapshot, and creates one pending checkpoint per active in-tenant recipient', async () => {
    const recipients = await dataSource.getRepository(RecipientEntity).save([
      { tenantId: tenantA.id, email: `bulk-a-${randomUUID()}@test.dev`, subscriptionStatus: 'active', customData: {} },
      { tenantId: tenantA.id, email: `bulk-b-${randomUUID()}@test.dev`, subscriptionStatus: 'active', customData: {} },
      { tenantId: tenantB.id, email: `bulk-other-${randomUUID()}@test.dev`, subscriptionStatus: 'active', customData: {} },
    ] as never);
    const [recipientA, recipientB] = recipients;
    const created = await service().create(tenantA.id, null, 'trace-bulk-create', `bulk-create-${randomUUID()}`, {
      action: 'set_custom_data',
      actionPayload: { key: 'tier', value: 'gold' },
      recipientIds: [recipientB.id, recipientA.id, recipients[2].id, recipientA.id],
    });

    expect(created).toMatchObject({ kind: 'bulk_update', resolvedCount: 2, status: 'queued', idempotencyReplayed: false });
    expect(created.selectionSnapshot).toEqual([recipientA.id, recipientB.id].sort());
    expect(await dataSource.getRepository(BulkJobRowEntity).count({ where: { jobId: created.jobId } })).toBe(2);
  });

  it('dry-runs the authoritative selected-recipient scope and validates the custom-data value before confirmation', async () => {
    const recipients = await dataSource.getRepository(RecipientEntity).save([
      { tenantId: tenantA.id, email: `bulk-preview-a-${randomUUID()}@test.dev`, subscriptionStatus: 'active', customData: {} },
      { tenantId: tenantB.id, email: `bulk-preview-other-${randomUUID()}@test.dev`, subscriptionStatus: 'active', customData: {} },
    ] as never);

    const jobsBefore = await dataSource.getRepository(BulkJobEntity).count({ where: { tenantId: tenantA.id } });
    await expect(service().preview(tenantA.id, {
      action: 'set_custom_data', actionPayload: { key: 'tier', value: 'gold' }, recipientIds: [recipients[0].id, recipients[1].id, recipients[0].id],
    })).resolves.toEqual({
      scope: 'selected_recipients', estimatedCount: 1, action: 'set_custom_data', actionPayload: { key: 'tier', value: 'gold' },
    });
    expect(await dataSource.getRepository(BulkJobEntity).count({ where: { tenantId: tenantA.id } })).toBe(jobsBefore);
  });

  it('replays the same bulk job without creating duplicate checkpoints for the same idempotency key', async () => {
    const recipients = await dataSource.getRepository(RecipientEntity).save([
      { tenantId: tenantA.id, email: `bulk-replay-a-${randomUUID()}@test.dev`, subscriptionStatus: 'active', customData: {} },
      { tenantId: tenantA.id, email: `bulk-replay-b-${randomUUID()}@test.dev`, subscriptionStatus: 'active', customData: {} },
    ] as never);
    const idempotencyKey = `bulk-replay-${randomUUID()}`;
    const input = {
      action: 'set_custom_data' as const,
      actionPayload: { key: 'tier', value: 'gold' },
      recipientIds: [recipients[1].id, recipients[0].id],
    };

    const created = await service().create(tenantA.id, null, 'trace-bulk-replay', idempotencyKey, input);
    const replayed = await service().create(tenantA.id, null, 'trace-bulk-replay', idempotencyKey, {
      ...input,
      recipientIds: [...input.recipientIds].reverse(),
    });

    expect(created.idempotencyReplayed).toBe(false);
    expect(replayed).toMatchObject({ jobId: created.jobId, idempotencyReplayed: true });
    expect(await dataSource.getRepository(BulkJobEntity).count({ where: { tenantId: tenantA.id, idempotencyKey } })).toBe(1);
    expect(await dataSource.getRepository(BulkJobRowEntity).count({ where: { jobId: created.jobId } })).toBe(2);
  });

  it('rejects a different bulk payload that reuses an idempotency key', async () => {
    const recipient = await dataSource.getRepository(RecipientEntity).save({ tenantId: tenantA.id, email: `bulk-conflict-${randomUUID()}@test.dev`, subscriptionStatus: 'active', customData: {} } as never);
    const idempotencyKey = `bulk-conflict-${randomUUID()}`;
    const input = {
      action: 'set_custom_data' as const,
      actionPayload: { key: 'tier', value: 'gold' },
      recipientIds: [recipient.id],
    };

    const created = await service().create(tenantA.id, null, 'trace-bulk-conflict', idempotencyKey, input);
    await expectHttpStatus(service().create(tenantA.id, null, 'trace-bulk-conflict', idempotencyKey, {
      ...input,
      actionPayload: { key: 'tier', value: 'silver' },
    }), 409);

    expect(await dataSource.getRepository(BulkJobEntity).count({ where: { tenantId: tenantA.id, idempotencyKey } })).toBe(1);
    expect(await dataSource.getRepository(BulkJobRowEntity).count({ where: { jobId: created.jobId } })).toBe(1);
  });

  it('does not let a second tenant read the bulk job', async () => {
    const recipient = await dataSource.getRepository(RecipientEntity).save({ tenantId: tenantA.id, email: `bulk-read-${randomUUID()}@test.dev`, subscriptionStatus: 'active', customData: {} } as never);
    const created = await service().create(tenantA.id, null, 'trace-bulk-tenant', `bulk-tenant-${randomUUID()}`, {
      action: 'set_custom_data',
      actionPayload: { key: 'tier', value: 'silver' },
      recipientIds: [recipient.id],
    });
    await expectHttpStatus(service().get(tenantB.id, created.jobId), 404);
  });

  it('lists only the current tenant bulk history and renders a failed-row artifact', async () => {
    const [ownRecipient, foreignRecipient] = await dataSource.getRepository(RecipientEntity).save([
      { tenantId: tenantA.id, email: `bulk-history-own-${randomUUID()}@test.dev`, subscriptionStatus: 'active', customData: {} },
      { tenantId: tenantB.id, email: `bulk-history-foreign-${randomUUID()}@test.dev`, subscriptionStatus: 'active', customData: {} },
    ] as never);
    const ownJob = await service().create(tenantA.id, null, 'trace-bulk-history', `bulk-history-own-${randomUUID()}`, {
      action: 'set_custom_data', actionPayload: { key: 'tier', value: 'gold' }, recipientIds: [ownRecipient.id],
    });
    const foreignJob = await service().create(tenantB.id, null, 'trace-bulk-history', `bulk-history-foreign-${randomUUID()}`, {
      action: 'set_custom_data', actionPayload: { key: 'tier', value: 'gold' }, recipientIds: [foreignRecipient.id],
    });
    await dataSource.getRepository(BulkJobRowEntity).update({ jobId: ownJob.jobId, recipientId: ownRecipient.id }, { status: 'failed', error: 'ROW_PROCESSING_FAILED' });

    const history = await service().list(tenantA.id);
    expect(history).toContainEqual(expect.objectContaining({ jobId: ownJob.jobId, resolvedCount: 1 }));
    expect(history).not.toContainEqual(expect.objectContaining({ jobId: foreignJob.jobId }));
    await expect(service().errorFile(tenantA.id, ownJob.jobId)).resolves.toEqual({
      fileName: `bulk-update-${ownJob.jobId}-errors.csv`,
      contents: `recipient_id,error\r\n${ownRecipient.id},ROW_PROCESSING_FAILED\r\n`,
    });
    await expectHttpStatus(service().errorFile(tenantB.id, ownJob.jobId), 404);
  });

  it('rejects a tag action whose target belongs to another tenant before a job is created', async () => {
    const foreignTag = (await dataSource.query(`INSERT INTO tag (tenant_id, name, color) VALUES ($1, $2, '#ef6c45') RETURNING id`, [tenantB.id, `foreign-${randomUUID()}`]))[0];
    const recipient = await dataSource.getRepository(RecipientEntity).save({ tenantId: tenantA.id, email: `bulk-tag-${randomUUID()}@test.dev`, subscriptionStatus: 'active', customData: {} } as never);

    await expectHttpStatus(service().create(tenantA.id, null, 'trace-bulk-target', `bulk-target-${randomUUID()}`, {
      action: 'add_tag',
      actionPayload: { tagId: foreignTag.id },
      recipientIds: [recipient.id],
    }), 404);
    await dataSource.query('DELETE FROM tag WHERE id = $1', [foreignTag.id]);
  });

  it('rejects a soft-deleted list or tag target before a frozen job is created', async () => {
    const [tag] = await dataSource.query(`INSERT INTO tag (tenant_id, name, color, deleted_at) VALUES ($1, $2, '#ef6c45', now()) RETURNING id`, [tenantA.id, `deleted-tag-${randomUUID()}`]);
    const [list] = await dataSource.query(`INSERT INTO recipient_list (tenant_id, name, deleted_at) VALUES ($1, $2, now()) RETURNING id`, [tenantA.id, `deleted-list-${randomUUID()}`]);
    const recipient = await dataSource.getRepository(RecipientEntity).save({ tenantId: tenantA.id, email: `bulk-deleted-target-${randomUUID()}@test.dev`, subscriptionStatus: 'active', customData: {} } as never);

    await expectHttpStatus(service().create(tenantA.id, null, 'trace-bulk-deleted-tag', `bulk-deleted-tag-${randomUUID()}`, {
      action: 'add_tag', actionPayload: { tagId: tag.id }, recipientIds: [recipient.id],
    }), 404);
    await expectHttpStatus(service().create(tenantA.id, null, 'trace-bulk-deleted-list', `bulk-deleted-list-${randomUUID()}`, {
      action: 'add_list', actionPayload: { listId: list.id }, recipientIds: [recipient.id],
    }), 404);
    await dataSource.query('DELETE FROM tag WHERE id = $1', [tag.id]);
    await dataSource.query('DELETE FROM recipient_list WHERE id = $1', [list.id]);
  });

  it('creates idempotent frozen export and delete jobs, and exposes a compact export result artifact', async () => {
    const recipients = await dataSource.getRepository(RecipientEntity).save([
      { tenantId: tenantA.id, email: `bulk-export-a-${randomUUID()}@test.dev`, subscriptionStatus: 'active', customData: {} },
      { tenantId: tenantB.id, email: `bulk-export-foreign-${randomUUID()}@test.dev`, subscriptionStatus: 'active', customData: {} },
    ] as never);
    const idempotencyKey = `bulk-export-${randomUUID()}`;
    const created = await service().create(tenantA.id, null, 'trace-bulk-export', idempotencyKey, {
      action: 'export', actionPayload: {}, recipientIds: [recipients[1].id, recipients[0].id],
    });
    const replayed = await service().create(tenantA.id, null, 'trace-bulk-export', idempotencyKey, {
      action: 'export', actionPayload: {}, recipientIds: [recipients[0].id, recipients[1].id],
    });

    expect(created).toMatchObject({ action: 'export', resolvedCount: 1, selectionSnapshot: [recipients[0].id], idempotencyReplayed: false });
    expect(replayed).toMatchObject({ jobId: created.jobId, idempotencyReplayed: true });
    await dataSource.getRepository(BulkJobRowEntity).update({ jobId: created.jobId, recipientId: recipients[0].id }, { status: 'succeeded' });
    await expect(service().resultFile(tenantA.id, created.jobId)).resolves.toEqual({
      fileName: `bulk-export-${created.jobId}.csv`,
      contents: `recipient_id\r\n${recipients[0].id}\r\n`,
    });

    const deletion = await service().create(tenantA.id, null, 'trace-bulk-delete', `bulk-delete-${randomUUID()}`, {
      action: 'delete', actionPayload: {}, recipientIds: [recipients[0].id, recipients[1].id],
    });
    expect(deletion).toMatchObject({ resolvedCount: 1, selectionSnapshot: [recipients[0].id] });
  });
});
