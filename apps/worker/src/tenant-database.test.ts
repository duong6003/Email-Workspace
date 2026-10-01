import { describe, expect, it, vi } from 'vitest';
import { runInTenantTransaction } from './tenant-database.js';

describe('worker tenant database boundary', () => {
  it('sets transaction-local tenant context before running work and commits it', async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [], rowCount: 0 }));
    const release = vi.fn();
    const pool = { connect: vi.fn(async () => ({ query, release })) };

    await runInTenantTransaction(pool, '9bbdbdc2-91cb-475b-995a-e8189d8e10b2', async () => 'done');

    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      `SELECT set_config('app.tenant_id', $1, true)`,
      'COMMIT',
    ]);
    expect(query.mock.calls[1]?.[1]).toEqual(['9bbdbdc2-91cb-475b-995a-e8189d8e10b2']);
    expect(release).toHaveBeenCalledOnce();
  });

  it('rolls back and releases the connection when tenant work fails', async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [], rowCount: 0 }));
    const release = vi.fn();
    const pool = { connect: vi.fn(async () => ({ query, release })) };

    await expect(runInTenantTransaction(pool, 'tenant-a', async () => { throw new Error('failed'); })).rejects.toThrow('failed');

    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      `SELECT set_config('app.tenant_id', $1, true)`,
      'ROLLBACK',
    ]);
    expect(release).toHaveBeenCalledOnce();
  });
});
