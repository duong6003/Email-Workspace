import type { EntityManager } from 'typeorm';
import { BulkJobEntity } from '../database/entities/bulk-job.entity.js';
import { BulkJobRowEntity } from '../database/entities/bulk-job-row.entity.js';
import { ImportJobEntity } from '../database/entities/import-job.entity.js';
import { ImportJobRowEntity } from '../database/entities/import-job-row.entity.js';
import { RecipientEntity } from '../database/entities/recipient.entity.js';

export class JobsRepository {
  constructor(private readonly manager: EntityManager) {}

  findImportJob(tenantId: string, id: string): Promise<ImportJobEntity | null> {
    return this.manager.getRepository(ImportJobEntity).findOne({ where: { id, tenantId } });
  }

  findImportJobs(tenantId: string): Promise<ImportJobEntity[]> {
    return this.manager.getRepository(ImportJobEntity).find({
      where: { tenantId },
      order: { createdAt: 'DESC' },
      take: 100,
    });
  }

  findFailedImportRows(jobId: string): Promise<ImportJobRowEntity[]> {
    return this.manager.getRepository(ImportJobRowEntity).find({
      where: { jobId, status: 'failed' },
      order: { rowNumber: 'ASC' },
    });
  }

  saveImportJob(values: Partial<ImportJobEntity>): Promise<ImportJobEntity> {
    return this.manager.getRepository(ImportJobEntity).save(values);
  }

  async insertImportRows(rows: Array<Pick<ImportJobRowEntity, 'jobId' | 'rowNumber' | 'rawData'>>): Promise<void> {
    await this.manager.getRepository(ImportJobRowEntity).insert(rows as never);
  }

  findBulkJob(tenantId: string, id: string): Promise<BulkJobEntity | null> {
    return this.manager.getRepository(BulkJobEntity).findOne({ where: { id, tenantId } });
  }

  findBulkJobs(tenantId: string): Promise<BulkJobEntity[]> {
    return this.manager.getRepository(BulkJobEntity).find({
      where: { tenantId },
      order: { createdAt: 'DESC' },
      take: 100,
    });
  }

  findFailedBulkRows(jobId: string): Promise<BulkJobRowEntity[]> {
    return this.manager.getRepository(BulkJobRowEntity).find({
      where: { jobId, status: 'failed' },
      order: { recipientId: 'ASC' },
    });
  }

  async findSucceededBulkRecipientIds(jobId: string): Promise<string[]> {
    const rows = await this.manager.getRepository(BulkJobRowEntity).find({
      where: { jobId, status: 'succeeded' },
      order: { recipientId: 'ASC' },
    });
    return rows.map((row) => row.recipientId);
  }

  async findActiveRecipientIds(tenantId: string, recipientIds: string[]): Promise<string[]> {
    if (recipientIds.length === 0) return [];
    const selected = await this.manager.getRepository(RecipientEntity).createQueryBuilder('recipient')
      .where('recipient.tenant_id = :tenantId', { tenantId })
      .andWhere('recipient.deleted_at IS NULL')
      .andWhere('recipient.id IN (:...recipientIds)', { recipientIds })
      .select('recipient.id', 'id')
      .orderBy('recipient.id', 'ASC')
      .getRawMany<{ id: string }>();
    return selected.map((row) => row.id);
  }

  saveBulkJob(values: Partial<BulkJobEntity>): Promise<BulkJobEntity> {
    return this.manager.getRepository(BulkJobEntity).save(values);
  }

  async insertBulkRows(rows: Array<Pick<BulkJobRowEntity, 'jobId' | 'recipientId'>>): Promise<void> {
    await this.manager.getRepository(BulkJobRowEntity).insert(rows as never);
  }
}
