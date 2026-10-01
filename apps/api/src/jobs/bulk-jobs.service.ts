import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import { IdempotencyService } from '../common/idempotency.service.js';
import { appendOutboxEvent } from '../outbox/outbox-writer.js';
import { BulkJobEntity, type BulkJobAction } from '../database/entities/bulk-job.entity.js';
import { BulkJobRowEntity } from '../database/entities/bulk-job-row.entity.js';
import { RecipientEntity } from '../database/entities/recipient.entity.js';
import { CustomFieldsService } from '../custom-fields/custom-fields.service.js';
import { coerceCustomFieldValue } from '../custom-fields/custom-field-values.js';
import { runInTenantContext } from '../database/tenant-transaction.js';
import { renderBulkErrorCsv, renderBulkExportCsv } from './job-artifacts.js';
import { JobsRepository } from './jobs.repository.js';

export function validateBulkAction(action: BulkJobAction, actionPayload: Record<string, unknown>): void {
  if (action === 'set_custom_data' && (typeof actionPayload.key !== 'string' || actionPayload.key.trim() === '' || !('value' in actionPayload))) {
    throw new BadRequestException('set_custom_data requires key and value.');
  }
  if ((action === 'add_tag' || action === 'remove_tag') && typeof actionPayload.tagId !== 'string') {
    throw new BadRequestException(`${action} requires tagId.`);
  }
  if ((action === 'add_list' || action === 'remove_list') && typeof actionPayload.listId !== 'string') {
    throw new BadRequestException(`${action} requires listId.`);
  }
}

async function assertTenantActionTarget(
  manager: EntityManager,
  tenantId: string,
  action: BulkJobAction,
  actionPayload: Record<string, unknown>,
): Promise<void> {
  if (action === 'set_custom_data' || action === 'export' || action === 'delete') return;
  const targetId = action === 'add_tag' || action === 'remove_tag' ? actionPayload.tagId : actionPayload.listId;
  const table = action === 'add_tag' || action === 'remove_tag' ? 'tag' : 'recipient_list';
  const found = await manager.query(`SELECT 1 FROM ${table} WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, [targetId, tenantId]);
  if (found.length === 0) throw new NotFoundException(`${table === 'tag' ? 'Tag' : 'Recipient list'} not found.`);
}

export type BulkJobCreateInput = {
  action: BulkJobAction;
  actionPayload: Record<string, unknown>;
  recipientIds: string[];
};

export type BulkJobResponse = {
  id: string;
  jobId: string;
  kind: 'bulk_update';
  action: BulkJobAction;
  status: BulkJobEntity['status'];
  selectionSnapshot: string[];
  resolvedCount: number;
  processedRows: number;
  succeededRows: number;
  failedRows: number;
  skippedRows: number;
  idempotencyReplayed: boolean;
  createdAt: string;
};

export type BulkJobPreviewResponse = {
  scope: 'selected_recipients';
  estimatedCount: number;
  action: BulkJobAction;
  actionPayload: Record<string, unknown>;
};

function toResponse(job: BulkJobEntity, idempotencyReplayed: boolean): BulkJobResponse {
  return {
    id: job.id,
    jobId: job.id,
    kind: 'bulk_update',
    action: job.action,
    status: job.status,
    selectionSnapshot: [...job.selectionSnapshot].sort(),
    resolvedCount: job.resolvedCount,
    processedRows: job.processedRows,
    succeededRows: job.succeededRows,
    failedRows: job.failedRows,
    skippedRows: job.skippedRows,
    idempotencyReplayed,
    createdAt: job.createdAt.toISOString(),
  };
}

/**
 * Resolves a selection to tenant-owned active recipients once, writes the
 * frozen snapshot and row checkpoints inside one transaction, and queues
 * dispatch via an outbox event. M2-S4 workers only ever consume these rows;
 * they must not re-evaluate the caller's selection.
 */
@Injectable()
export class BulkJobsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly idempotency: IdempotencyService,
    private readonly customFields: CustomFieldsService,
  ) {}

  async create(
    tenantId: string,
    actorId: string | null,
    traceId: string,
    idempotencyKey: string | undefined,
    input: BulkJobCreateInput,
  ): Promise<BulkJobResponse> {
    const canonicalInput = await this.canonicalizeInput(tenantId, input);
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      await assertTenantActionTarget(manager, tenantId, canonicalInput.action, canonicalInput.actionPayload);
      const result = await this.idempotency.run(
        manager,
        tenantId,
        idempotencyKey,
        'bulk_job',
        canonicalInput,
        async () => this.persistNewJob(manager, tenantId, actorId, traceId, idempotencyKey, canonicalInput),
      );
      return { ...result.value, idempotencyReplayed: result.replayed };
    });
  }

  async get(tenantId: string, id: string): Promise<BulkJobResponse> {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const job = await new JobsRepository(manager).findBulkJob(tenantId, id);
      if (!job) throw new NotFoundException('Bulk job not found.');
      return toResponse(job, false);
    });
  }

  /** BR-CF-004: authoritative dry-run validation and resolved scope before confirmation. */
  async preview(tenantId: string, input: BulkJobCreateInput): Promise<BulkJobPreviewResponse> {
    const canonicalInput = await this.canonicalizeInput(tenantId, input);
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      await assertTenantActionTarget(manager, tenantId, canonicalInput.action, canonicalInput.actionPayload);
      const estimatedCount = (await new JobsRepository(manager).findActiveRecipientIds(tenantId, canonicalInput.recipientIds)).length;
      return {
        scope: 'selected_recipients',
        estimatedCount,
        action: canonicalInput.action,
        actionPayload: canonicalInput.actionPayload,
      };
    });
  }

  async list(tenantId: string): Promise<BulkJobResponse[]> {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const jobs = await new JobsRepository(manager).findBulkJobs(tenantId);
      return jobs.map((job) => toResponse(job, false));
    });
  }

  async errorFile(tenantId: string, id: string): Promise<{ fileName: string; contents: string }> {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const repository = new JobsRepository(manager);
      const job = await repository.findBulkJob(tenantId, id);
      if (!job) throw new NotFoundException('Bulk job not found.');
      const rows = await repository.findFailedBulkRows(id);
      return {
        fileName: `bulk-update-${job.id}-errors.csv`,
        contents: renderBulkErrorCsv(rows.map((row) => ({ recipientId: row.recipientId, error: row.error }))),
      };
    });
  }

  /**
   * Export's durable result is the successfully processed frozen snapshot.
   * It is intentionally compact because `bulk_job_row` stores recipient
   * identifiers/checkpoints, not an arbitrary duplicate of recipient data.
   */
  async resultFile(tenantId: string, id: string): Promise<{ fileName: string; contents: string }> {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const repository = new JobsRepository(manager);
      const job = await repository.findBulkJob(tenantId, id);
      if (!job || job.action !== 'export') throw new NotFoundException('Bulk export job not found.');
      const recipientIds = await repository.findSucceededBulkRecipientIds(id);
      return {
        fileName: `bulk-export-${job.id}.csv`,
        contents: renderBulkExportCsv(recipientIds),
      };
    });
  }

  private async canonicalizeInput(tenantId: string, input: BulkJobCreateInput): Promise<BulkJobCreateInput> {
    validateBulkAction(input.action, input.actionPayload);
    const canonicalInput: BulkJobCreateInput = {
      ...input,
      actionPayload: { ...input.actionPayload },
      recipientIds: [...new Set(input.recipientIds)].sort(),
    };
    if (canonicalInput.action === 'set_custom_data') {
      const key = canonicalInput.actionPayload.key as string;
      const field = await runInTenantContext(this.dataSource, tenantId, async (manager) =>
        (await this.customFields.listWithManager(manager, tenantId)).find((candidate) => candidate.fieldKey === key),
      );
      if (!field) throw new NotFoundException('Custom field not found.');
      canonicalInput.actionPayload.value = coerceCustomFieldValue(field, canonicalInput.actionPayload.value);
    }
    return canonicalInput;
  }

  private async persistNewJob(
    manager: EntityManager,
    tenantId: string,
    actorId: string | null,
    traceId: string,
    idempotencyKey: string | undefined,
    input: BulkJobCreateInput,
  ): Promise<BulkJobResponse> {
    const repository = new JobsRepository(manager);
    const selectionSnapshot = await repository.findActiveRecipientIds(tenantId, input.recipientIds);
    const job = await repository.saveBulkJob({
      tenantId,
      action: input.action,
      actionPayload: input.actionPayload,
      selectionSnapshot,
      resolvedCount: selectionSnapshot.length,
      idempotencyKey: idempotencyKey ?? null,
      createdBy: actorId,
    } as Partial<BulkJobEntity>);

    if (selectionSnapshot.length > 0) {
      await repository.insertBulkRows(selectionSnapshot.map((recipientId) => ({ jobId: job.id, recipientId })));
    }

    await appendOutboxEvent(manager, {
      tenantId,
      eventType: 'bulk-update.job.created',
      aggregateType: 'bulk_job',
      aggregateId: job.id,
      aggregateVersion: 0n,
      payload: { jobId: job.id, status: job.status, resolvedCount: job.resolvedCount, traceId },
    });
    return toResponse(job, false);
  }
}
