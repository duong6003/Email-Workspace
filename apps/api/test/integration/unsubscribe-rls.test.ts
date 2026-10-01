import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { createDataSource } from '../../src/database/data-source.js';
import { RecipientEntity } from '../../src/database/entities/recipient.entity.js';
import { TenantEntity } from '../../src/database/entities/tenant.entity.js';
import { AuditLogEntity } from '../../src/database/entities/audit-log.entity.js';
import { testAppDatabaseUrl, testDatabaseUrl } from './test-database-url.js';

/**
 * ADR-049: migration 079 exercised through the REAL runtime role.
 *
 * The reason this file exists rather than an HTTP test: the owner role bypasses
 * RLS entirely, so the integration suite that boots an app-under-test cannot
 * see the failure mode this migration exists to avoid. That is not
 * hypothetical -- it is precisely how every asset URL ADR-043 minted came to
 * 404 in production, documented at length in 077_asset_serve_bypass.sql and
 * `asset-rls.test.ts`.
 *
 * Measured here against `eow_app` directly, the same way.
 */
describe('unsubscribe redemption under RLS (079_unsubscribe_redeem.sql)', () => {
  let owner: DataSource;
  let app: DataSource;
  let tenant: TenantEntity;
  let recipientId: string;

  const email = () => `unsub-rls-${randomUUID()}@example.test`;

  beforeAll(async () => {
    owner = createDataSource(testDatabaseUrl());
    app = createDataSource(testAppDatabaseUrl());
    await owner.initialize();
    await app.initialize();
    tenant = await owner.getRepository(TenantEntity).save({ name: `unsub-rls-${randomUUID()}` });
    const address = email();
    const saved = await owner.getRepository(RecipientEntity).save({
      tenantId: tenant.id,
      email: address,
      normalizedEmail: address.toLowerCase(),
      firstName: null,
      lastName: null,
      subscriptionStatus: 'active',
    } as Partial<RecipientEntity>);
    recipientId = saved.id;
  }, 30_000);

  /**
   * The recipient goes; the tenant stays.
   *
   * Not an oversight and not laziness -- it is not possible. `redeem_unsubscribe`
   * writes an `audit_log` row, BR-SEC-002 makes those rows immutable (a trigger
   * rejects DELETE outright), and `audit_log_tenant_id_fkey` then pins the
   * tenant row in place forever. Measured here the hard way: the first version
   * of this teardown tried both and failed with
   * "update or delete on table \"tenant\" violates foreign key constraint".
   *
   * `asset-rls.test.ts` can delete its tenants because assets write no audit
   * rows. Any future test whose subject DOES will inherit this, so it is
   * written down rather than worked around silently.
   */
  afterAll(async () => {
    if (owner?.isInitialized) {
      await owner.getRepository(RecipientEntity).delete({ tenantId: tenant.id });
    }
    await app?.destroy();
    await owner?.destroy();
  }, 30_000);

  /**
   * The condition the whole migration exists for. `recipient_tenant_isolation`
   * is `USING (tenant_id = current_tenant_id())`, and that function returns
   * NULL when `app.tenant_id` was never set -- which is every request on a
   * `@Public()` route, because there is no tenant to set.
   */
  it('a plain tenant-blind query as eow_app sees nothing, which is why the function has to exist', async () => {
    const rows = await app.query('SELECT id FROM recipient WHERE id = $1', [recipientId]);
    expect(rows).toEqual([]);
  });

  it('find_unsubscribe_target reaches the row with no tenant context, and reports the current state', async () => {
    const rows = await app.query<Array<{ email: string; already_unsubscribed: boolean }>>(
      'SELECT * FROM find_unsubscribe_target($1)', [recipientId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.already_unsubscribed).toBe(false);
  });

  it('returns nothing for an id that does not exist, rather than erroring', async () => {
    expect(await app.query('SELECT * FROM find_unsubscribe_target($1)', [randomUUID()])).toEqual([]);
  });

  /**
   * The SQL half of ADR-049 decision 2. Mail security scanners GET every link
   * in a message, so the function behind the GET must be incapable of writing
   * -- if it could, a scanned mail would unsubscribe its own recipient.
   */
  it('find_unsubscribe_target changes nothing, however many times it is called', async () => {
    await app.query('SELECT * FROM find_unsubscribe_target($1)', [recipientId]);
    await app.query('SELECT * FROM find_unsubscribe_target($1)', [recipientId]);
    const after = await owner.getRepository(RecipientEntity).findOneByOrFail({ id: recipientId });
    expect(after.subscriptionStatus).toBe('active');
    expect(after.unsubscribedAt).toBeNull();
    expect(await owner.getRepository(AuditLogEntity).findBy({ entityId: recipientId })).toEqual([]);
  });

  it('redeem_unsubscribe writes the status, stamps the time, and records one audit row', async () => {
    const rows = await app.query<Array<{ already_unsubscribed: boolean }>>(
      'SELECT * FROM redeem_unsubscribe($1, $2)', [recipientId, 'trace-unsub-rls'],
    );
    expect(rows[0]?.already_unsubscribed).toBe(false);

    const after = await owner.getRepository(RecipientEntity).findOneByOrFail({ id: recipientId });
    expect(after.subscriptionStatus).toBe('unsubscribed');
    expect(after.unsubscribedAt).not.toBeNull();

    const audit = await owner.getRepository(AuditLogEntity).findBy({ entityId: recipientId });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'recipient.unsubscribed', entityType: 'recipient', actorId: null });
  });

  /** A second click must read as success, not as an error page saying their unsubscribe failed. */
  it('is idempotent, and does not write a second audit row', async () => {
    const rows = await app.query<Array<{ already_unsubscribed: boolean }>>(
      'SELECT * FROM redeem_unsubscribe($1, $2)', [recipientId, 'trace-unsub-rls-2'],
    );
    expect(rows[0]?.already_unsubscribed).toBe(true);
    expect(await owner.getRepository(AuditLogEntity).findBy({ entityId: recipientId })).toHaveLength(1);
  });

  /**
   * The security property that makes bypassing RLS acceptable here: the
   * function can only ever perform ONE transition. There is no parameter for
   * the target status, so reactivation -- which BR-REC-004 reserves for an
   * Admin confirming re-consent -- is not reachable through this route even
   * though the function runs as the owner.
   */
  it('cannot be used to reactivate anyone, because the target status is not a parameter', async () => {
    await expect(app.query('SELECT * FROM redeem_unsubscribe($1, $2, $3)', [recipientId, 't', 'active']))
      .rejects.toThrow();
    const after = await owner.getRepository(RecipientEntity).findOneByOrFail({ id: recipientId });
    expect(after.subscriptionStatus).toBe('unsubscribed');
  });

  it('leaves eow_app with no direct UPDATE path to the row it just changed through the function', async () => {
    // TypeORM returns `[rows, affectedCount]` for an UPDATE, so both halves are
    // checked: no row came back AND none was touched. RLS hides the row from
    // the UPDATE's own WHERE rather than raising, which is what makes this
    // failure mode silent without a test at this role.
    const [rows, affected] = await app.query(
      "UPDATE recipient SET subscription_status = 'active' WHERE id = $1 RETURNING id", [recipientId],
    ) as [unknown[], number];
    expect(rows).toEqual([]);
    expect(affected).toBe(0);
    const after = await owner.getRepository(RecipientEntity).findOneByOrFail({ id: recipientId });
    expect(after.subscriptionStatus).toBe('unsubscribed');
  });
});
