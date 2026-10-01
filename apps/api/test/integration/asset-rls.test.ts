import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { createDataSource } from '../../src/database/data-source.js';
import { AssetEntity } from '../../src/database/entities/asset.entity.js';
import { findServableAsset } from '../../src/assets/assets.repository.js';
import { TenantEntity } from '../../src/database/entities/tenant.entity.js';
import { testAppDatabaseUrl, testDatabaseUrl } from './test-database-url.js';

/**
 * S6 Task 34: migration 076 exercised through the REAL runtime role.
 *
 * The owner role bypasses RLS and ignores GRANT, so an owner-connected test
 * would pass against a table with no policy and no grants at all -- the exact
 * mistake `notification-preference-rls.test.ts` was written after. The asset
 * routes do not exist until Task 36, so this is the only thing standing between
 * migration 076 and a cross-tenant leak until they do.
 *
 * It also pins two decisions that are easy to undo by accident: there is no
 * DELETE grant (ADR-043 §5 has no hard delete), and the content_type CHECK is
 * the last line under the upload validator.
 */
describe('asset RLS + eow_app grants (076_asset_storage.sql)', () => {
  let owner: DataSource;
  let app: DataSource;
  let tenantA: TenantEntity;
  let tenantB: TenantEntity;

  const row = (tenantId: string) => ({
    tenantId,
    originalFilename: 'logo.png',
    contentType: 'image/png' as const,
    byteSize: 1024,
    width: 320,
    height: 96,
    createdBy: null,
    archivedAt: null,
  });

  beforeAll(async () => {
    owner = createDataSource(testDatabaseUrl());
    app = createDataSource(testAppDatabaseUrl());
    await owner.initialize();
    await app.initialize();
    const tenants = owner.getRepository(TenantEntity);
    tenantA = await tenants.save({ name: `asset-rls-a-${randomUUID()}` });
    tenantB = await tenants.save({ name: `asset-rls-b-${randomUUID()}` });
  }, 30_000);

  afterAll(async () => {
    if (owner?.isInitialized) {
      await owner.getRepository(AssetEntity).delete({ tenantId: tenantA.id });
      await owner.getRepository(AssetEntity).delete({ tenantId: tenantB.id });
      await owner.getRepository(TenantEntity).delete([tenantA.id, tenantB.id]);
    }
    await app?.destroy();
    await owner?.destroy();
  }, 30_000);

  it('eow_app can insert and read its own tenant rows -- proving the GRANT is real, not just present in the migration file', async () => {
    await app.transaction(async (manager) => {
      await manager.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA.id]);
      await manager.getRepository(AssetEntity).save(row(tenantA.id));
    });
    const rows = await owner.getRepository(AssetEntity).findBy({ tenantId: tenantA.id });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ contentType: 'image/png', byteSize: 1024, archivedAt: null });
  });

  it('refuses a cross-tenant insert through WITH CHECK', async () => {
    await expect(
      app.transaction(async (manager) => {
        await manager.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA.id]);
        await manager.getRepository(AssetEntity).save(row(tenantB.id));
      }),
    ).rejects.toThrow(/row-level security policy/i);
  });

  it('hides another tenant\'s rows from a SELECT rather than erroring, which is what makes a leak silent without this test', async () => {
    await app.transaction(async (manager) => {
      await manager.query("SELECT set_config('app.tenant_id', $1, true)", [tenantB.id]);
      expect(await manager.getRepository(AssetEntity).find()).toEqual([]);
    });
  });

  it('fails closed when no tenant context is set', async () => {
    await expect(app.getRepository(AssetEntity).find()).resolves.toEqual([]);
  });

  /**
   * The one deliberate exception to the rule just above. `find_servable_asset`
   * (077_asset_serve_bypass.sql) is what `AssetsService.serve()` -- the
   * `@Public()` route a mail client fetches -- actually calls, and it has to
   * find the row with NO tenant context, which is exactly the condition the
   * previous test proves a plain query fails under. Written after measuring
   * the bug directly against this same role: `psql -U eow_app` with no
   * `app.tenant_id` set returned `(0 rows)` for a real, existing id, every
   * time -- every asset URL ADR-043 ever minted 404'd until this function
   * existed. `assets-http.test.ts` could not have caught it: it boots its
   * app-under-test as the OWNER role, which bypasses row-level security
   * entirely, so its own "serves the bytes" test never actually exercised RLS.
   */
  it('findServableAsset (the TS function AssetsService.serve() actually calls) finds the row through eow_app with NO tenant context set', async () => {
    const created = await app.transaction(async (manager) => {
      await manager.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA.id]);
      return manager.getRepository(AssetEntity).save(row(tenantA.id));
    });

    // A fresh transaction on the SAME app (eow_app) DataSource, deliberately
    // with no set_config call -- exactly what the @Public() route does, and
    // exactly the condition the previous test proves a plain query fails
    // under. Calling the real function under test, not the SQL directly, so a
    // regression in the TS wrapper (not just the migration) fails this test.
    const found = await app.transaction((manager) => findServableAsset(manager, created.id));
    expect(found).toMatchObject({ id: created.id, tenantId: tenantA.id, contentType: 'image/png' });
  });

  it('findServableAsset still returns null for an id that genuinely does not exist -- the bypass is scoped to one id, not to the whole table', async () => {
    const found = await app.transaction((manager) => findServableAsset(manager, randomUUID()));
    expect(found).toBeNull();
  });

  it('has no DELETE grant -- ADR-043 §5 keeps every object, and archiving is the only removal', async () => {
    await expect(
      app.transaction(async (manager) => {
        await manager.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA.id]);
        await manager.query('DELETE FROM asset WHERE tenant_id = $1', [tenantA.id]);
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it('archives by UPDATE, which eow_app is granted', async () => {
    await app.transaction(async (manager) => {
      await manager.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA.id]);
      await manager.query('UPDATE asset SET archived_at = now() WHERE tenant_id = $1', [tenantA.id]);
    });
    const rows = await owner.getRepository(AssetEntity).findBy({ tenantId: tenantA.id });
    expect(rows[0]?.archivedAt).toBeInstanceOf(Date);
  });

  /**
   * ADR-044 Task SV-4 (migration 078). The `kind` column is reached by a new
   * verb (PATCH /assets/:id), so it needs the same two proofs migration 076's
   * columns have: the runtime role can write it inside its own tenant, and
   * cannot reach another tenant's row through it. `assets-http.test.ts` cannot
   * show the second one -- it boots its app under the OWNER role, which
   * bypasses RLS entirely, the exact blind spot that let 077's bug ship.
   */
  it('defaults kind to image for a row written before 078 existed, rather than failing NOT NULL', async () => {
    await app.transaction(async (manager) => {
      await manager.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA.id]);
      // The INSERT a code path written before this column would emit: no `kind`.
      await manager.query(
        'INSERT INTO asset (tenant_id, original_filename, content_type, byte_size) VALUES ($1, $2, $3, $4)',
        [tenantA.id, 'legacy.png', 'image/png', 512],
      );
    });
    const legacy = await owner.getRepository(AssetEntity).findOneBy({ tenantId: tenantA.id, originalFilename: 'legacy.png' });
    expect(legacy?.kind).toBe('image');
  });

  it('lets eow_app reclassify a row in its own tenant -- the UPDATE grant covers the new column', async () => {
    const created = await owner.getRepository(AssetEntity).save({ ...row(tenantA.id), originalFilename: 'reclass.png', kind: 'image' as const });
    await app.transaction(async (manager) => {
      await manager.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA.id]);
      await manager.getRepository(AssetEntity).update({ id: created.id }, { kind: 'logo' });
    });
    const after = await owner.getRepository(AssetEntity).findOneBy({ id: created.id });
    expect(after?.kind).toBe('logo');
  });

  it(`cannot reclassify another tenant's asset -- the UPDATE matches nothing rather than erroring, which is what makes a leak silent`, async () => {
    const foreign = await owner.getRepository(AssetEntity).save({ ...row(tenantB.id), originalFilename: 'theirs.png', kind: 'image' as const });
    await app.transaction(async (manager) => {
      await manager.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA.id]);
      const result = await manager.getRepository(AssetEntity).update({ id: foreign.id }, { kind: 'logo' });
      // Zero rows affected, not an error: this is why the service checks the
      // affected count and answers 404 instead of reporting a success.
      expect(result.affected ?? 0).toBe(0);
    });
    const after = await owner.getRepository(AssetEntity).findOneBy({ id: foreign.id });
    expect(after?.kind).toBe('image');
  });

  it('refuses a kind outside the two 078 allows -- the last line under parseAssetKind', async () => {
    await expect(
      app.transaction(async (manager) => {
        await manager.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA.id]);
        await manager.query(
          'INSERT INTO asset (tenant_id, original_filename, content_type, byte_size, kind) VALUES ($1, $2, $3, $4, $5)',
          [tenantA.id, 'banner.png', 'image/png', 512, 'banner'],
        );
      }),
    ).rejects.toThrow(/check constraint/i);
  });

  it('refuses a content type outside the four ADR-043 §4 allows -- the last line under the upload validator', async () => {
    await expect(
      app.transaction(async (manager) => {
        await manager.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA.id]);
        await manager.query(
          'INSERT INTO asset (tenant_id, original_filename, content_type, byte_size) VALUES ($1, $2, $3, $4)',
          [tenantA.id, 'evil.svg', 'image/svg+xml', 512],
        );
      }),
    ).rejects.toThrow(/content_type/i);
  });

  it('refuses a zero-byte or oversized file, so a failed upload cannot sit in the library looking real', async () => {
    for (const size of [0, 5 * 1024 * 1024 + 1]) {
      await expect(
        app.transaction(async (manager) => {
          await manager.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA.id]);
          await manager.query(
            'INSERT INTO asset (tenant_id, original_filename, content_type, byte_size) VALUES ($1, $2, $3, $4)',
            [tenantA.id, 'broken.png', 'image/png', size],
          );
        }),
      ).rejects.toThrow(/byte_size/i);
    }
  });
});
