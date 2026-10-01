import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import pg from 'pg';
import { IMPORT_JOB_NAME, IMPORT_QUEUE } from './import-processor.js';
import { importQueueJobId, relayUnpublishedImportEvents } from './outbox-relay.js';
import { testAppDatabaseUrl, testOwnerDatabaseUrl, testRedisUrl } from './test-urls.js';

describe('import outbox relay (real PostgreSQL and Redis)', () => {
  const pool = new pg.Pool({ connectionString: testOwnerDatabaseUrl() });
  const redis = new Redis(testRedisUrl(), { maxRetriesPerRequest: null });
  const queue = new Queue(IMPORT_QUEUE, { connection: redis });
  let tenantId: string;
  let jobId: string;
  let eventId: string;

  beforeAll(async () => {
    tenantId = (await pool.query<{ id: string }>('INSERT INTO tenant (name) VALUES ($1) RETURNING id', [`relay-tenant-${randomUUID()}`])).rows[0].id;
    jobId = (await pool.query<{ id: string }>(`INSERT INTO import_job (tenant_id, file_name, mapping_json) VALUES ($1, 'relay.csv', '{}'::jsonb) RETURNING id`, [tenantId])).rows[0].id;
    eventId = (await pool.query<{ id: string }>(
      `INSERT INTO outbox_event (tenant_id, event_type, aggregate_type, aggregate_id, aggregate_version, payload)
       VALUES ($1, 'import.job.created', 'import_job', $2, 0, $3::jsonb) RETURNING id`,
      [tenantId, jobId, JSON.stringify({ jobId })],
    )).rows[0].id;
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await queue.close();
    await redis.quit();
    await pool.query('DELETE FROM outbox_event WHERE id = $1', [eventId]);
    await pool.query('DELETE FROM import_job WHERE id = $1', [jobId]);
    await pool.query('DELETE FROM tenant WHERE id = $1', [tenantId]);
    await pool.end();
  });

  it('publishes a committed import event once and marks it published so a retry does not add another queue job', async () => {
    // The local shared database can retain an unpublished event if a prior
    // interrupted test run was killed before its cleanup hook. This test's
    // invariant is that *our* committed event is relayed and no further
    // pending import event remains after the pass, not that the shared
    // database started with zero unrelated pending events.
    expect(await relayUnpublishedImportEvents(testAppDatabaseUrl(), queue)).toBeGreaterThanOrEqual(1);
    const queued = await queue.getJob(importQueueJobId(jobId));
    expect(queued?.name).toBe(IMPORT_JOB_NAME);
    expect(queued?.data).toEqual({ jobId, tenantId });
    expect((await pool.query<{ published_at: Date | null }>('SELECT published_at FROM outbox_event WHERE id = $1', [eventId])).rows[0].published_at).not.toBeNull();
    expect(await relayUnpublishedImportEvents(testAppDatabaseUrl(), queue)).toBe(0);
  });
});
