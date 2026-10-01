import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import { IdempotencyService } from '../common/idempotency.service.js';
import { appendOutboxEvent } from '../outbox/outbox-writer.js';
import { ImportJobEntity } from '../database/entities/import-job.entity.js';
import { ImportJobRowEntity } from '../database/entities/import-job-row.entity.js';
import { validateImportFileSize, validateImportMapping, validateImportRowNumbers, validateImportRows } from './job-creation.service.js';
import { renderImportErrorCsv } from './job-artifacts.js';
import { runInTenantContext } from '../database/tenant-transaction.js';
import { JobsRepository } from './jobs.repository.js';
import { CustomFieldsService } from '../custom-fields/custom-fields.service.js';
import { coerceCustomFieldValue } from '../custom-fields/custom-field-values.js';

export type ImportJobCreateInput = {
  fileName: string;
  fileSizeBytes: number;
  fileFingerprint?: string;
  mode: 'create_only' | 'update_existing' | 'upsert';
  mapping: Record<string, string>;
  rows: Array<{ rowNumber: number; rawData: Record<string, unknown> }>;
};

export type ImportJobResponse = {
  id: string;
  jobId: string;
  kind: 'import';
  fileName: string;
  status: ImportJobEntity['status'];
  totalRows: number;
  processedRows: number;
  succeededRows: number;
  failedRows: number;
  skippedRows: number;
  idempotencyReplayed: boolean;
  createdAt: string;
};

export type ImportPreviewResponse = {
  rows: Array<{ rowNumber: number; rawData: Record<string, unknown> }>;
  errors: Array<{ rowNumber: number; column: string; reason: string }>;
};

function toResponse(job: ImportJobEntity, idempotencyReplayed: boolean): ImportJobResponse {
  return {
    id: job.id,
    jobId: job.id,
    kind: 'import',
    fileName: job.fileName,
    status: job.status,
    totalRows: job.totalRows,
    processedRows: job.processedRows,
    succeededRows: job.succeededRows,
    failedRows: job.failedRows,
    skippedRows: job.skippedRows,
    idempotencyReplayed,
    createdAt: job.createdAt.toISOString(),
  };
}

/**
 * M2-S4's durable import intake. The actual row processor belongs to the
 * worker checkpoint/reclaim step; this service's job is to atomically create
 * the canonical job + every row checkpoint + an outbox event for dispatch.
 */
@Injectable()
export class ImportJobsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly idempotency: IdempotencyService,
  ) {}

  async preview(tenantId: string, input: ImportJobCreateInput): Promise<ImportPreviewResponse> {
    validateImportFileSize(input.fileSizeBytes);
    validateImportMapping(input.mapping);
    validateImportRows(input.rows);
    validateImportRowNumbers(input.rows);

    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const fields = await new CustomFieldsService(this.dataSource).listWithManager(manager, tenantId);
      const fieldByKey = new Map(fields.map((field) => [field.fieldKey, field]));
      const rows = input.rows.slice(0, 20);
      const errors = rows.flatMap((row) => {
        const issues: ImportPreviewResponse['errors'] = [];
        const emailColumn = input.mapping.email;
        const email = typeof row.rawData[emailColumn] === 'string' ? row.rawData[emailColumn].trim() : '';
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          issues.push({ rowNumber: row.rowNumber, column: emailColumn, reason: 'Email không hợp lệ.' });
        }
        for (const [target, column] of Object.entries(input.mapping)) {
          if (!target.startsWith('custom_')) continue;
          const value = row.rawData[column];
          if (value === undefined || value === '') continue;
          const field = fieldByKey.get(target.slice('custom_'.length));
          if (!field) {
            issues.push({ rowNumber: row.rowNumber, column, reason: `Trường tùy chỉnh "${target.slice('custom_'.length)}" không tồn tại.` });
            continue;
          }
          try {
            coerceCustomFieldValue(field, value);
          } catch (cause) {
            issues.push({ rowNumber: row.rowNumber, column, reason: cause instanceof Error ? cause.message : 'Giá trị trường tùy chỉnh không hợp lệ.' });
          }
        }
        return issues;
      });
      return { rows, errors };
    });
  }

  async create(
    tenantId: string,
    actorId: string | null,
    traceId: string,
    idempotencyKey: string | undefined,
    input: ImportJobCreateInput,
  ): Promise<ImportJobResponse> {
    validateImportFileSize(input.fileSizeBytes);
    validateImportMapping(input.mapping);
    validateImportRows(input.rows);
    validateImportRowNumbers(input.rows);

    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const result = await this.idempotency.run(
        manager,
        tenantId,
        idempotencyKey,
        'import_job',
        input,
        async () => this.persistNewJob(manager, tenantId, actorId, traceId, idempotencyKey, input),
      );
      return { ...result.value, idempotencyReplayed: result.replayed };
    });
  }

  async get(tenantId: string, id: string): Promise<ImportJobResponse> {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const job = await new JobsRepository(manager).findImportJob(tenantId, id);
      if (!job) throw new NotFoundException('Import job not found.');
      return toResponse(job, false);
    });
  }

  async list(tenantId: string): Promise<ImportJobResponse[]> {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const jobs = await new JobsRepository(manager).findImportJobs(tenantId);
      return jobs.map((job) => toResponse(job, false));
    });
  }

  async errorFile(tenantId: string, id: string): Promise<{ fileName: string; contents: string }> {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const repository = new JobsRepository(manager);
      const job = await repository.findImportJob(tenantId, id);
      if (!job) throw new NotFoundException('Import job not found.');
      const rows = await repository.findFailedImportRows(id);
      return {
        fileName: `${job.fileName.replace(/\.(csv|xlsx)$/i, '')}-errors.csv`,
        contents: renderImportErrorCsv(rows),
      };
    });
  }

  private async persistNewJob(
    manager: EntityManager,
    tenantId: string,
    actorId: string | null,
    traceId: string,
    idempotencyKey: string | undefined,
    input: ImportJobCreateInput,
  ): Promise<ImportJobResponse> {
    const repository = new JobsRepository(manager);
    const job = await repository.saveImportJob({
      tenantId,
      fileName: input.fileName,
      mode: input.mode,
      mapping: input.mapping,
      sourceFileRef: input.fileFingerprint ? `sha256:${input.fileFingerprint}` : null,
      totalRows: input.rows.length,
      idempotencyKey: idempotencyKey ?? null,
      createdBy: actorId,
    } as Partial<ImportJobEntity>);

    if (input.rows.length > 0) {
      await repository.insertImportRows(input.rows.map((row) => ({ jobId: job.id, rowNumber: row.rowNumber, rawData: row.rawData })));
    }

    await appendOutboxEvent(manager, {
      tenantId,
      eventType: 'import.job.created',
      aggregateType: 'import_job',
      aggregateId: job.id,
      aggregateVersion: 0n,
      payload: { jobId: job.id, status: job.status, totalRows: job.totalRows, traceId },
    });

    return toResponse(job, false);
  }
}
