import type { DataSource, EntityManager } from 'typeorm';

export function setTenantContext(manager: EntityManager, tenantId: string): Promise<unknown> {
  return manager.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
}

/**
 * Runs one tenant-owned unit of work on a single transaction connection.
 * PostgreSQL's transaction-local setting cannot leak when the pooled
 * connection is returned, and every repository built from the supplied
 * EntityManager participates in the same RLS context.
 */
export function runInTenantContext<T>(
  dataSource: DataSource,
  tenantId: string,
  work: (manager: EntityManager) => Promise<T>,
): Promise<T> {
  return dataSource.transaction(async (manager) => {
    await setTenantContext(manager, tenantId);
    return work(manager);
  });
}
