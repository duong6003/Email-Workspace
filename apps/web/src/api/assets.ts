import type { components } from '@eow/contracts';
import { parseErrorResponse } from './problem.js';

const base = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api/v1';

/**
 * MC-UI-005 (ADR-043). The asset library is tenant-owned, like the reusable
 * block library: everyone with `content:read` sees the same list, and nothing
 * here keys off `createdBy` -- it exists so the panel can show who uploaded a
 * file, never to decide what the current user may do with it.
 *
 * The row type comes from the generated contract rather than being restated
 * here. That is the point of the contract: a field that changes shape in
 * `contracts/openapi.yaml` breaks `pnpm typecheck` at this call site instead of
 * at runtime in the panel.
 */
export type Asset = components['schemas']['Asset'];
/** ADR-044 Task SV-4: what a person says the file is, which magic bytes cannot decide (`logo` vs `image`). Drives the library filter bar and the brand kit section. */
export type AssetKind = Asset['kind'];

function csrfHeaders(): Record<string, string> {
  const token = document.cookie.split('; ').find((row) => row.startsWith('eow_csrf='))?.split('=')[1];
  return token ? { 'x-csrf-token': token } : {};
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${base}${path}`, { credentials: 'include', ...init });
  if (!response.ok) await parseErrorResponse(response);
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

/**
 * Multipart, and deliberately without a `content-type` header.
 *
 * `fetch` derives `multipart/form-data; boundary=...` from the FormData body.
 * Setting the header by hand -- the reflex from every JSON call in this
 * directory -- omits the boundary, so the API parses no file and answers 400
 * on a request that looks perfectly well formed.
 */
function upload(path: string, file: File, kind?: AssetKind): Promise<Asset> {
  const body = new FormData();
  // `FileInterceptor('file', ...)` on the API reads exactly this field name.
  body.append('file', file);
  // Omitted rather than sent empty when the caller says nothing: on upload the
  // API reads an absent field as "image", and on replace as "same as before" --
  // two different right answers that both depend on the field not being there.
  if (kind) body.append('kind', kind);
  return request(path, { method: 'POST', headers: csrfHeaders(), body });
}

/** Live assets only. Archived ones are gone from here and still served -- archiving hides an image, it does not withdraw it from email already sent (ADR-043 §5). */
export function listAssets(): Promise<{ items: Asset[] }> {
  return request('/assets');
}

export function uploadAsset(file: File, kind?: AssetKind): Promise<Asset> {
  return upload('/assets', file, kind);
}

/**
 * Returns a *new* asset with a new id and a new URL, and archives the old one.
 * The old URL keeps working: it is frozen inside published versions that cannot
 * be edited, so overwriting its bytes would change the image inside email that
 * has already been approved (ADR-043 §7). Callers must rebind to the returned
 * asset -- nothing repoints an existing node for them.
 */
export function replaceAsset(assetId: string, file: File, kind?: AssetKind): Promise<Asset> {
  return upload(`/assets/${assetId}/replace`, file, kind);
}

/**
 * ADR-044 Task SV-4. The one mutable field on an asset: no bytes move, no new
 * id is minted, and nothing already published is affected -- so unlike
 * `replaceAsset`, callers keep the same asset and the same URL.
 */
export function updateAssetKind(assetId: string, kind: AssetKind): Promise<Asset> {
  return request(`/assets/${assetId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...csrfHeaders() },
    body: JSON.stringify({ kind }),
  });
}

/** "Xoá" in the UI, archive in the database. Nothing here is ever hard-deleted (ADR-043 §5). */
export function archiveAsset(assetId: string): Promise<void> {
  return request(`/assets/${assetId}`, { method: 'DELETE', headers: csrfHeaders() });
}
