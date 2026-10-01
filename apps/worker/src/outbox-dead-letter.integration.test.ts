import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Queue } from 'bullmq';
import pg from 'pg';
import { relayUnpublishedImportEvents } from './outbox-relay.js';
import { OUTBOX_MAX_ATTEMPTS, recordOutboxFailure } from './outbox-dead-letter.js';
import { testAppDatabaseUrl, testOwnerDatabaseUrl } from './test-urls.js';

describe('M7-S2 outbox dead-letter transition (real PostgreSQL)', () => {
  const owner = new pg.Pool({ connectionString: testOwnerDatabaseUrl() });
  const app = new pg.Pool({ connectionString: testAppDatabaseUrl() });
  let tenantId: string;
  let poisonJobId: string;
  let healthyJobId: string;
  let poisonEventId: string;
  let healthyEventId: string;

  const queue = {
    add: async (_name: string, data: { jobId: string }) => {
      if (data.jobId === poisonJobId) throw new Error('poison queue payload');
      return { id: data.jobId };
    },
  } as unknown as Queue;

  beforeAll(async () => {
    tenantId = (await owner.query<{ id: string }>(
      'INSERT INTO tenant (name) VALUES ($1) RETURNING id',
      [`dlq-red-${randomUUID()}`],
    )).rows[0]!.id;
    poisonJobId = (await owner.query<{ id: string }>(
      `INSERT INTO import_job (tenant_id, file_name, mapping_json)
       VALUES ($1, $2, '{}'::jsonb) RETURNING id`,
      [tenantId, `poison-${randomUUID()}.csv`],
    )).rows[0]!.id;
    healthyJobId = (await owner.query<{ id: string }>(
      `INSERT INTO import_job (tenant_id, file_name, mapping_json)
       VALUES ($1, $2, '{}'::jsonb) RETURNING id`,
      [tenantId, `healthy-${randomUUID()}.csv`],
    )).rows[0]!.id;
    poisonEventId = (await owner.query<{ id: string }>(
      `INSERT INTO outbox_event
       (tenant_id, event_type, aggregate_type, aggregate_id, aggregate_version, payload, occurred_at)
       VALUES ($1, 'import.job.created', 'import_job', $2, 0, $3::jsonb, '0001-01-01') RETURNING id`,
      [tenantId, poisonJobId, JSON.stringify({ jobId: poisonJobId })],
    )).rows[0]!.id;
    healthyEventId = (await owner.query<{ id: string }>(
      `INSERT INTO outbox_event
       (tenant_id, event_type, aggregate_type, aggregate_id, aggregate_version, payload, occurred_at)
       VALUES ($1, 'import.job.created', 'import_job', $2, 0, $3::jsonb, '0001-01-02') RETURNING id`,
      [tenantId, healthyJobId, JSON.stringify({ jobId: healthyJobId })],
    )).rows[0]!.id;
  });

  afterAll(async () => {
    await owner.query('DELETE FROM dead_letter_event WHERE tenant_id = $1', [tenantId]);
    await owner.query('DELETE FROM outbox_event WHERE id = ANY($1::uuid[])', [[poisonEventId, healthyEventId]]);
    await owner.query('DELETE FROM import_job WHERE id = ANY($1::uuid[])', [[poisonJobId, healthyJobId]]);
    await owner.query('DELETE FROM tenant WHERE id = $1', [tenantId]);
    await app.end();
    await owner.end();
  });

  it('D-146 (fixed): a poison event no longer blocks the healthy event behind it', async () => {
    expect(await relayUnpublishedImportEvents(testAppDatabaseUrl(), queue, 2)).toBe(1);
    const healthy = await owner.query<{ published_at: Date | null }>(
      'SELECT published_at FROM outbox_event WHERE id = $1',
      [healthyEventId],
    );
    expect(healthy.rows[0]!.published_at).not.toBeNull();
  }, 30_000);

  it('moves a poison event to dead_letter_event once at the attempts ceiling', async () => {
    const state = await owner.query<{ attempts: number }>('SELECT attempts FROM outbox_event WHERE id = $1', [poisonEventId]);
    for (let attempt = Number(state.rows[0]!.attempts); attempt < OUTBOX_MAX_ATTEMPTS; attempt += 1) {
      await recordOutboxFailure(app, poisonEventId, new Error('poison queue payload'), tenantId);
    }
    const dead = await owner.query<{ event_id: string; attempts: number; last_error: string }>(
      `SELECT event_id, attempts, last_error FROM dead_letter_event
       WHERE tenant_id = $1 AND event_id = $2`,
      [tenantId, poisonEventId],
    );
    expect(dead.rows).toHaveLength(1);
    expect(Number(dead.rows[0]!.attempts)).toBe(OUTBOX_MAX_ATTEMPTS);
    expect(dead.rows[0]!.last_error).toContain('poison queue payload');

    const pending = await owner.query(
      `SELECT id FROM outbox_event
       WHERE id = $1 AND published_at IS NULL AND dead_lettered_at IS NULL`,
      [poisonEventId],
    );
    expect(pending.rows).toHaveLength(0);

    await recordOutboxFailure(app, poisonEventId, new Error('must not increment again'), tenantId);
    const finalState = await owner.query<{ attempts: number }>('SELECT attempts FROM outbox_event WHERE id = $1', [poisonEventId]);
    expect(Number(finalState.rows[0]!.attempts)).toBe(OUTBOX_MAX_ATTEMPTS);
    expect((await owner.query('SELECT 1 FROM dead_letter_event WHERE event_id = $1', [poisonEventId])).rows).toHaveLength(1);
  }, 30_000);
});
