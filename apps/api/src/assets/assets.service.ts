import { BadRequestException, Injectable, NotFoundException, PayloadTooLargeException, UnsupportedMediaTypeException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import type { Readable } from 'node:stream';
import type { ValidatedEnv } from '../config/env.js';
import type { AssetEntity } from '../database/entities/asset.entity.js';
import { runInTenantContext } from '../database/tenant-transaction.js';
import { S3AssetStorage, assetObjectKey, assetPublicUrl, type AssetStorage } from './asset-storage.js';
import { validateAssetUpload } from './asset-validation.js';
import { DEFAULT_ASSET_KIND, type AssetKind } from './dto/asset.dto.js';
import { AssetsRepository, findServableAsset } from './assets.repository.js';

export type AssetResponse = {
  id: string;
  url: string;
  filename: string;
  contentType: string;
  kind: AssetKind;
  byteSize: number;
  width: number | null;
  height: number | null;
  createdBy: string | null;
  createdByName: string | null;
  archivedAt: string | null;
  createdAt: string;
};

@Injectable()
export class AssetsService {
  private storageInstance: AssetStorage | null = null;
  private readonly publicOrigin: string;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: ConfigService<ValidatedEnv, true>,
  ) {
    this.publicOrigin = config.get('ASSET_PUBLIC_ORIGIN', { infer: true });
  }

  /**
   * Built on first use, not in the constructor.
   *
   * The first version validated the credential in the constructor, reasoning
   * that this is "the point of use". For a Nest provider it is not -- the
   * constructor runs at application boot, so an unset credential took down every
   * test and every deployment that never touches an asset. 38 integration files
   * failed on it. Deferring to first use keeps the benefit that mattered
   * (an error that names the variable, instead of an opaque
   * SignatureDoesNotMatch from the store) and drops the cost that did not
   * belong -- the same reasoning that left the env schema's default as ''.
   */
  private get storage(): AssetStorage {
    if (this.storageInstance) return this.storageInstance;
    const secretAccessKey = this.config.get('ASSET_STORAGE_SECRET_KEY', { infer: true });
    if (!secretAccessKey) {
      throw new Error('ASSET_STORAGE_SECRET_KEY is not set. The asset store cannot be reached without it.');
    }
    this.storageInstance = new S3AssetStorage({
      endpoint: this.config.get('ASSET_STORAGE_ENDPOINT', { infer: true }),
      region: this.config.get('ASSET_STORAGE_REGION', { infer: true }),
      bucket: this.config.get('ASSET_STORAGE_BUCKET', { infer: true }),
      accessKeyId: this.config.get('ASSET_STORAGE_ACCESS_KEY', { infer: true }),
      secretAccessKey,
      forcePathStyle: this.config.get('ASSET_STORAGE_FORCE_PATH_STYLE', { infer: true }),
    });
    return this.storageInstance;
  }

  private response(asset: AssetEntity, uploaderName: string | null): AssetResponse {
    return {
      id: asset.id,
      // Absolute https, built from the configured origin. Task 32 measured that
      // a root-relative src is stripped by the sanitizer, so a relative URL here
      // would silently produce images that vanish from every published email.
      url: assetPublicUrl(this.publicOrigin, asset.id, asset.originalFilename),
      filename: asset.originalFilename,
      contentType: asset.contentType,
      kind: asset.kind,
      byteSize: asset.byteSize,
      width: asset.width,
      height: asset.height,
      createdBy: asset.createdBy,
      createdByName: uploaderName,
      archivedAt: asset.archivedAt?.toISOString() ?? null,
      createdAt: asset.createdAt.toISOString(),
    };
  }

  list(tenantId: string): Promise<AssetResponse[]> {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const repository = new AssetsRepository(manager, tenantId);
      const assets = await repository.listLive();
      const names = await repository.uploaderNames(assets.map((asset) => asset.createdBy).filter((id): id is string => id !== null));
      return assets.map((asset) => this.response(asset, asset.createdBy ? names.get(asset.createdBy) ?? null : null));
    });
  }

  /**
   * The row is written first and the object second, deliberately. The reverse
   * order can leave an object no row points at, which nothing will ever clean
   * up because ADR-043 §5 has no delete. This order can leave a row with no
   * object, which the serving route already answers as 404 and which is visible
   * and fixable. Neither is good; this one fails in the direction that can be
   * seen.
   */
  upload(tenantId: string, actorId: string | null, filename: string, bytes: Buffer, kind: AssetKind = DEFAULT_ASSET_KIND): Promise<AssetResponse> {
    const validation = validateAssetUpload(bytes);
    if (!validation.ok) {
      if (validation.reason === 'FILE_TOO_LARGE') throw new PayloadTooLargeException(validation.message);
      if (validation.reason === 'EMPTY_FILE') throw new BadRequestException(validation.message);
      throw new UnsupportedMediaTypeException({ code: validation.reason, message: validation.message });
    }
    const safeName = sanitizeFilename(filename);

    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const repository = new AssetsRepository(manager, tenantId);
      const saved = await repository.save({
        originalFilename: safeName,
        contentType: validation.contentType,
        kind,
        byteSize: bytes.length,
        createdBy: actorId,
        archivedAt: null,
      });
      await this.storage.put(assetObjectKey(tenantId, saved.id), bytes, validation.contentType);
      const names = await repository.uploaderNames(actorId ? [actorId] : []);
      return this.response(saved, actorId ? names.get(actorId) ?? null : null);
    });
  }

  /**
   * ADR-043 §7: replacing never overwrites bytes, because that would change the
   * image inside every already-published email pointing at the old URL. It
   * uploads a new asset and archives the old one -- archived assets keep being
   * served, so nothing that already referenced it breaks.
   */
  async replace(tenantId: string, actorId: string | null, assetId: string, filename: string, bytes: Buffer, kind?: AssetKind): Promise<AssetResponse> {
    const existing = await runInTenantContext(this.dataSource, tenantId, (manager) => new AssetsRepository(manager, tenantId).findById(assetId));
    if (!existing) throw new NotFoundException('Asset not found.');
    // Replacing a logo leaves a logo. The caller may override, but silence
    // means "same thing, new file" -- defaulting to `image` here would quietly
    // empty the brand kit every time somebody swapped a logo for a better crop.
    const created = await this.upload(tenantId, actorId, filename, bytes, kind ?? existing.kind);
    await runInTenantContext(this.dataSource, tenantId, (manager) => new AssetsRepository(manager, tenantId).archive(assetId));
    return created;
  }

  /**
   * ADR-044 Task SV-4: reclassify an existing asset. Deliberately not
   * `replace`: no bytes change, no new id is minted, and nothing that already
   * points at this URL is affected -- so the archive-and-recreate rule ADR-043
   * §7 imposes on content does not apply to a label.
   */
  setKind(tenantId: string, assetId: string, kind: AssetKind): Promise<AssetResponse> {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const repository = new AssetsRepository(manager, tenantId);
      const updated = await repository.updateKind(assetId, kind);
      if (!updated) throw new NotFoundException('Asset not found.');
      const asset = await repository.findById(assetId);
      if (!asset) throw new NotFoundException('Asset not found.');
      const names = await repository.uploaderNames(asset.createdBy ? [asset.createdBy] : []);
      return this.response(asset, asset.createdBy ? names.get(asset.createdBy) ?? null : null);
    });
  }

  /** "Delete" in the UI. Hides the asset from the library; the object and the serving route are untouched (ADR-043 §5). */
  archive(tenantId: string, assetId: string): Promise<void> {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const archived = await new AssetsRepository(manager, tenantId).archive(assetId);
      if (!archived) throw new NotFoundException('Asset not found.');
    });
  }

  /**
   * The public serving path. It takes only an id -- never a path, never a
   * tenant, never a key -- so there is nothing a caller can traverse. The tenant
   * comes off the row that the id resolves to, and the object key is derived
   * from both.
   *
   * Archived assets are served on purpose: a published version still points
   * here and cannot be edited (ADR-043 §5).
   */
  async serve(assetId: string): Promise<{ body: Readable; contentType: string; byteSize: number; filename: string } | null> {
    const asset = await this.dataSource.transaction((manager) => findServableAsset(manager, assetId));
    if (!asset) return null;
    const stored = await this.storage.get(assetObjectKey(asset.tenantId, asset.id));
    if (!stored) return null;
    return { ...stored, contentType: asset.contentType, filename: asset.originalFilename };
  }
}

/**
 * The filename travels into a URL path segment and a `Content-Disposition`
 * header, so it is reduced to a leaf name with no separators. It is never used
 * to build a storage key -- that is derived from ids -- so this is about not
 * emitting nonsense, not about path traversal, which the key derivation already
 * makes impossible.
 */
export function sanitizeFilename(filename: string): string {
  const leaf = filename.split(/[\\/]/).pop() ?? '';
  const cleaned = leaf.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return cleaned.length > 0 ? cleaned.slice(0, 200) : 'anh-tai-len';
}
