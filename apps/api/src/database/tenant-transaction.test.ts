import { describe, expect, it, vi } from 'vitest';
import type { DataSource, EntityManager } from 'typeorm';
import { runInTenantContext, setTenantContext } from './tenant-transaction.js';

describe('runInTenantContext', () => {
  it('sets the transaction-local tenant before invoking work with that transaction manager', async () => {
    const events: string[] = [];
    const manager = {
      query: vi.fn(async (sql: string, params: unknown[]) => {
        events.push('set-context');
        expect(sql).toBe("SELECT set_config('app.tenant_id', $1, true)");
        expect(params).toEqual(['tenant-a']);
      }),
    } as unknown as EntityManager;
    const dataSource = {
      transaction: vi.fn(async (work: (transactionManager: EntityManager) => Promise<string>) => {
        events.push('begin');
        const result = await work(manager);
        events.push('commit');
        return result;
      }),
    } as unknown as DataSource;

    const result = await runInTenantContext(dataSource, 'tenant-a', async (transactionManager) => {
      events.push('work');
      expect(transactionManager).toBe(manager);
      return 'done';
    });

    expect(result).toBe('done');
    expect(events).toEqual(['begin', 'set-context', 'work', 'commit']);
  });

  it('lets the transaction roll back when work fails without using a pooled manager', async () => {
    const failure = new Error('write failed');
    const manager = { query: vi.fn().mockResolvedValue(undefined) } as unknown as EntityManager;
    const dataSource = {
      manager: { query: vi.fn() },
      transaction: vi.fn(async (work: (transactionManager: EntityManager) => Promise<never>) => work(manager)),
    } as unknown as DataSource;

    await expect(runInTenantContext(dataSource, 'tenant-a', async () => {
      throw failure;
    })).rejects.toBe(failure);

    expect(manager.query).toHaveBeenCalledWith("SELECT set_config('app.tenant_id', $1, true)", ['tenant-a']);
    expect(dataSource.manager.query).not.toHaveBeenCalled();
  });
});

describe('setTenantContext', () => {
  it('sets the tenant on an existing bootstrap transaction before tenant-owned audit or permission work', async () => {
    const manager = { query: vi.fn().mockResolvedValue(undefined) } as unknown as EntityManager;

    await setTenantContext(manager, 'tenant-after-bootstrap');

    expect(manager.query).toHaveBeenCalledWith("SELECT set_config('app.tenant_id', $1, true)", ['tenant-after-bootstrap']);
  });
});
