import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HttpException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { createDataSource } from '../../src/database/data-source.js';
import { TenantEntity } from '../../src/database/entities/tenant.entity.js';
import { ImportJobEntity } from '../../src/database/entities/import-job.entity.js';
import { ImportJobRowEntity } from '../../src/database/entities/import-job-row.entity.js';
import { OutboxEventEntity } from '../../src/database/entities/outbox-event.entity.js';
import { IdempotencyService } from '../../src/common/idempotency.service.js';
import { ImportJobsService } from '../../src/jobs/import-jobs.service.js';
import { IdempotencyKeyEntity } from '../../src/database/entities/idempotency-key.entity.js';
import { RecipientEntity } from '../../src/database/entities/recipient.entity.js';
import { testDatabaseUrl } from './test-database-url.js';

describe('Import jobs (M2-S4: BR-GEN-005, BR-IMP-002/004/006/007)', () => {
  let dataSource: DataSource;
  let tenantA: TenantEntity;
  let tenantB: TenantEntity;

  beforeAll(async () => {
    dataSource = createDataSource(testDatabaseUrl());
    await dataSource.initialize();
    const tenants = dataSource.getRepository(TenantEntity);
    tenantA = await tenants.save({ name: `import-job-tenant-a-${randomUUID()}` });
    tenantB = await tenants.save({ name: `import-job-tenant-b-${randomUUID()}` });
  });

  afterAll(async () => {
    const importRows = dataSource.getRepository(ImportJobRowEntity);
    const jobs = dataSource.getRepository(ImportJobEntity);
    const outbox = dataSource.getRepository(OutboxEventEntity);
    const tenantAJobs = await jobs.find({ where: { tenantId: tenantA.id } });
    const tenantBJobs = await jobs.find({ where: { tenantId: tenantB.id } });
    const jobIds = [...tenantAJobs, ...tenantBJobs].map((job) => job.id);
    if (jobIds.length > 0) {
      await importRows.createQueryBuilder().delete().where('job_id IN (:...jobIds)', { jobIds }).execute();
      await outbox.createQueryBuilder().delete().where('aggregate_type = :type AND aggregate_id IN (:...jobIds)', { type: 'import_job', jobIds }).execute();
      await jobs.createQueryBuilder().delete().where('id IN (:...jobIds)', { jobIds }).execute();
    }
    await dataSource.getRepository(IdempotencyKeyEntity).createQueryBuilder().delete().where('tenant_id IN (:...tenantIds)', { tenantIds: [tenantA.id, tenantB.id] }).execute();
    // The real worker can process queued fixture jobs while this integration suite
    // runs, creating recipients that must be removed before their tenant teardown.
    await dataSource.getRepository(RecipientEntity).createQueryBuilder().delete().where('tenant_id IN (:...tenantIds)', { tenantIds: [tenantA.id, tenantB.id] }).execute();
    await dataSource.getRepository(TenantEntity).delete([tenantA.id, tenantB.id]);
    await dataSource.destroy();
  });

  function service(): ImportJobsService {
    return new ImportJobsService(dataSource, new IdempotencyService());
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

  const request = {
    fileName: 'recipients.csv',
    fileSizeBytes: 42,
    mode: 'upsert' as const,
    mapping: { email: 'Email', firstName: 'First name' },
    rows: [
      { rowNumber: 2, rawData: { Email: 'first@example.test', 'First name': 'First' } },
      { rowNumber: 3, rawData: { Email: 'second@example.test', 'First name': 'Second' } },
    ],
  };

  it('creates one tenant-scoped queued job, one pending checkpoint per supplied row, and a durable outbox event', async () => {
    const created = await service().create(tenantA.id, null, 'trace-import-create', 'import-create-key', request);

    expect(created).toMatchObject({ kind: 'import', status: 'queued', totalRows: 2, processedRows: 0, succeededRows: 0, failedRows: 0, skippedRows: 0, idempotencyReplayed: false });

    const rows = await dataSource.getRepository(ImportJobRowEntity).find({ where: { jobId: created.jobId }, order: { rowNumber: 'ASC' } });
    expect(rows.map((row) => ({ rowNumber: row.rowNumber, status: row.status, rawData: row.rawData }))).toEqual([
      { rowNumber: 2, status: 'pending', rawData: request.rows[0].rawData },
      { rowNumber: 3, status: 'pending', rawData: request.rows[1].rawData },
    ]);

    const persistedJob = await dataSource.getRepository(ImportJobEntity).findOneByOrFail({ id: created.jobId });
    expect((persistedJob as unknown as { mapping?: unknown }).mapping).toEqual(request.mapping);

    const outbox = await dataSource.getRepository(OutboxEventEntity).findOne({ where: { aggregateType: 'import_job', aggregateId: created.jobId, eventType: 'import.job.created' } });
    expect(outbox?.payload).toMatchObject({ jobId: created.jobId, totalRows: 2, status: 'queued' });
  });

  it('replays the original import job for the same idempotency key and payload without creating new checkpoints', async () => {
    const key = `import-replay-${randomUUID()}`;
    const first = await service().create(tenantA.id, null, 'trace-import-replay', key, request);
    const replay = await service().create(tenantA.id, null, 'trace-import-replay', key, request);

    expect(replay).toMatchObject({ jobId: first.jobId, idempotencyReplayed: true });
    expect(await dataSource.getRepository(ImportJobRowEntity).count({ where: { jobId: first.jobId } })).toBe(2);
  });

  it('rejects a reuse of an idempotency key with a different request payload', async () => {
    const key = `import-conflict-${randomUUID()}`;
    await service().create(tenantA.id, null, 'trace-import-conflict', key, request);

    await expectHttpStatus(
      service().create(tenantA.id, null, 'trace-import-conflict', key, { ...request, fileName: 'different.csv' }),
      409,
    );
  });

  it('does not allow another tenant to read an import job by id', async () => {
    const created = await service().create(tenantA.id, null, 'trace-import-tenant', `import-tenant-${randomUUID()}`, request);
    await expectHttpStatus(service().get(tenantB.id, created.jobId), 404);
  });

  it('lists only the calling tenant\'s import history', async () => {
    const own = await service().create(tenantA.id, null, 'trace-import-list-own', `import-list-own-${randomUUID()}`, {
      fileName: 'own-history.csv', fileSizeBytes: 0, mode: 'upsert', mapping: { email: 'Email' }, rows: [],
    });
    const foreign = await service().create(tenantB.id, null, 'trace-import-list-foreign', `import-list-foreign-${randomUUID()}`, {
      fileName: 'foreign-history.csv', fileSizeBytes: 0, mode: 'upsert', mapping: { email: 'Email' }, rows: [],
    });

    const history = await service().list(tenantA.id);
    expect(history.map((job) => job.jobId)).toContain(own.jobId);
    expect(history.map((job) => job.jobId)).not.toContain(foreign.jobId);
  });
});
