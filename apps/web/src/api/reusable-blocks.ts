import { parseErrorResponse } from './problem.js';

const base = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api/v1';

/**
 * MC-UI-004. Blocks belong to the tenant, not to whoever saved them (plan §S5
 * Task 26), so there is no "mine" filter here and nothing in this client keys
 * off `createdBy` -- it exists so the panel can show who saved a block, never
 * to decide what the current user may do with it.
 *
 * The listing carries no `node`: a list of block trees is the payload of every
 * template in the tenant, so the tree is fetched by `getReusableBlock` at the
 * moment one is inserted (the projection ADR-035 set for the template library).
 */
export type ReusableBlockSummary = {
  id: string;
  name: string;
  /** ADR-044 Task SV-4: the row preview's bar count (1..4) and the leaf count beside it, both derived server-side from the stored tree. */
  columns: number;
  elements: number;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
};

/** The saved subtree is a `Node` from the builder's document model. Typed loosely on purpose: the API never parses it, and neither does this client -- `tree-ops.ts` is what puts it back on the canvas. */
export type ReusableBlock = ReusableBlockSummary & { node: Record<string, unknown> };

function csrfHeaders(): Record<string, string> {
  const token = document.cookie.split('; ').find((row) => row.startsWith('eow_csrf='))?.split('=')[1];
  return { 'content-type': 'application/json', ...(token ? { 'x-csrf-token': token } : {}) };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${base}${path}`, { credentials: 'include', ...init });
  if (!response.ok) await parseErrorResponse(response);
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

export function listReusableBlocks(): Promise<{ items: ReusableBlockSummary[] }> {
  return request('/reusable-blocks');
}

export function getReusableBlock(id: string): Promise<ReusableBlock> {
  return request(`/reusable-blocks/${id}`);
}

export function createReusableBlock(body: { name: string; node: Record<string, unknown> }): Promise<ReusableBlock> {
  return request('/reusable-blocks', { method: 'POST', headers: csrfHeaders(), body: JSON.stringify(body) });
}

export function renameReusableBlock(id: string, name: string): Promise<ReusableBlock> {
  return request(`/reusable-blocks/${id}`, { method: 'PATCH', headers: csrfHeaders(), body: JSON.stringify({ name }) });
}

export function deleteReusableBlock(id: string): Promise<void> {
  return request(`/reusable-blocks/${id}`, { method: 'DELETE', headers: csrfHeaders() });
}
