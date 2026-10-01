import type pg from 'pg';

type TenantClient = {
  query(sql: string, params?: unknown[]): Promise<unknown>;
  release(): void;
};
type TenantPool = { connect(): Promise<TenantClient> };

/** Runs worker mutations with a transaction-local RLS tenant context. */
export async function runInTenantTransaction<T>(pool: TenantPool, tenantId: string, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    const result = await work(client as pg.PoolClient);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
