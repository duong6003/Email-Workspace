import { In, type EntityManager } from 'typeorm';
import { AppUserEntity } from '../database/entities/app-user.entity.js';
import { AssetEntity } from '../database/entities/asset.entity.js';
import { TenantScopedRepository } from '../database/tenant-scoped.repository.js';
import type { AssetKind } from './dto/asset.dto.js';

export class AssetsRepository extends TenantScopedRepository<AssetEntity> {
  constructor(manager: EntityManager, tenantId: string) {
    super(manager.getRepository(AssetEntity), tenantId);
    this.manager = manager;
  }

  private readonly manager: EntityManager;

  /** Includes archived rows: the serving path must still find them (ADR-043 §5), and only the library listing filters them out. */
  findById(id: string): Promise<AssetEntity | null> {
    return this.repository.findOne({ where: { id, tenantId: this.tenantId } });
  }

  /** The library: live assets only, newest first -- matching `idx_asset_tenant_live`. */
  listLive(): Promise<AssetEntity[]> {
    return this.repository.createQueryBuilder('asset')
      .where('asset.tenant_id = :tenantId AND asset.archived_at IS NULL', { tenantId: this.tenantId })
      .orderBy('asset.created_at', 'DESC')
      .addOrderBy('asset.id', 'DESC')
      .getMany();
  }

  /**
    * ADR-044 Task SV-4. The only mutable field on an asset. Everything else
    * about it is frozen because a published version points at the URL and
    * cannot be edited (ADR-043 §7) -- but a classification is a label on the
    * row, not the bytes, so changing it breaks nothing that was already sent.
    */
  async updateKind(id: string, kind: AssetKind): Promise<boolean> {
    const result = await this.repository.update({ id, tenantId: this.tenantId }, { kind });
    return (result.affected ?? 0) > 0;
  }

  async archive(id: string): Promise<boolean> {
    const result = await this.repository.update({ id, tenantId: this.tenantId }, { archivedAt: new Date() });
    return (result.affected ?? 0) > 0;
  }

  /** Display names for the uploader column. Attribution only -- nothing here decides what anyone may do. */
  async uploaderNames(ids: ReadonlyArray<string>): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const users = await this.manager.getRepository(AppUserEntity).find({
      where: { id: In(unique), tenantId: this.tenantId },
      select: { id: true, displayName: true },
    });
    return new Map(users.map((user) => [user.id, user.displayName]));
  }
}

/**
 * The serving route is `@Public()` and therefore has no tenant context, so it
 * cannot go through `TenantScopedRepository`. It looks an asset up by its
 * primary key alone and reads `tenant_id` off the row it finds -- the id IS the
 * capability (ADR-043 §2), and the tenant is a result of the lookup, never an
 * input to it. A caller can supply an id; it can never supply a path or a
 * tenant, so there is nothing here to traverse.
 *
 * Goes through `find_servable_asset` (076_asset_serve_bypass.sql), a
 * SECURITY DEFINER function, rather than a plain repository query. `eow_app`
 * has no other way to see this row without a tenant context: `asset`'s RLS
 * policy is `tenant_id = current_tenant_id()`, and that function returns NULL
 * when unset, so a plain `findOne({ where: { id } })` compares `tenant_id` to
 * NULL and silently matches nothing -- proved directly with `psql -U eow_app`
 * against a known id: `(0 rows)`, every time, not a flake. It reached
 * production before it was caught because the one test that exercises this
 * route (`assets-http.test.ts`) boots its app under the OWNER role, which
 * bypasses row-level security entirely; only `asset-rls.test.ts` connects as
 * `eow_app`, and until this fix it only had a test for the general rule
 * (`fails closed when no tenant context is set`), not this route's one
 * intentional exception to it.
 *
 * The function returns exactly the four columns `AssetsService.serve()` uses,
 * matching `013_outbox_relay_api.sql`'s narrow style for the same problem: a
 * SECURITY DEFINER surface that returns whole rows is a second, wider way to
 * read tenant data, which defeats the point of writing one at all.
 *
 * Kept in this file rather than the service so `ARCH-TENANT`'s repository
 * exemption covers it in one place with the reasoning attached.
 */
export type ServableAsset = { id: string; tenantId: string; contentType: AssetEntity['contentType']; originalFilename: string };

export async function findServableAsset(manager: EntityManager, id: string): Promise<ServableAsset | null> {
  const rows = await manager.query<Array<{ id: string; tenant_id: string; content_type: ServableAsset['contentType']; original_filename: string }>>(
    'SELECT * FROM find_servable_asset($1)', [id],
  );
  const row = rows[0];
  if (!row) return null;
  return { id: row.id, tenantId: row.tenant_id, contentType: row.content_type, originalFilename: row.original_filename };
}
