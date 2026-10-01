import { parseErrorResponse } from './problem.js';

export type RecipientStatus = 'active' | 'paused' | 'unsubscribed' | 'bounced';

export type Recipient = {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  department: string | null;
  title: string | null;
  location: string | null;
  subscriptionStatus: RecipientStatus;
  customData: Record<string, unknown>;
  unsubscribedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RecipientListResponse = {
  items: Recipient[];
  nextCursor: string | null;
  total: number;
};

export type RecipientCreateRequest = {
  email: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  department?: string;
  title?: string;
  location?: string;
  subscriptionStatus?: RecipientStatus;
  /** M2-S3: admin-defined typed custom-field values (BR-CF-002), validated/coerced server-side against the tenant's current schema. */
  customData?: Record<string, unknown>;
};

export type RecipientUpdateRequest = Partial<RecipientCreateRequest> & { confirmReconsent?: boolean };

const base = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api/v1';

function readCsrfCookie(): string | undefined {
  return document.cookie
    .split('; ')
    .find((row) => row.startsWith('eow_csrf='))
    ?.split('=')[1];
}

function mutationHeaders(): Record<string, string> {
  const csrfToken = readCsrfCookie();
  return { 'content-type': 'application/json', ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}) };
}

export type RecipientListQuery = { search?: string; status?: RecipientStatus[]; listIds?: string[]; tagIds?: string[]; cursor?: string; limit?: number };

/** GET /recipients — BR-REC-007/008: search + status filter, server-side cursor pagination. */
export async function listRecipients(query: RecipientListQuery = {}): Promise<RecipientListResponse> {
  const params = new URLSearchParams();
  if (query.search) params.set('search', query.search);
  if (query.status) for (const s of query.status) params.append('status', s);
  if (query.listIds) for (const id of query.listIds) params.append('listIds', id);
  if (query.tagIds) for (const id of query.tagIds) params.append('tagIds', id);
  if (query.cursor) params.set('cursor', query.cursor);
  if (query.limit) params.set('limit', String(query.limit));

  const response = await fetch(`${base}/recipients?${params.toString()}`, { credentials: 'include' });
  if (!response.ok) await parseErrorResponse(response);
  return response.json();
}

/** POST /recipients — BR-REC-001: 409 with the existing recipient's id on a duplicate email. */
export async function createRecipient(request: RecipientCreateRequest): Promise<Recipient> {
  const response = await fetch(`${base}/recipients`, {
    method: 'POST',
    credentials: 'include',
    headers: mutationHeaders(),
    body: JSON.stringify(request),
  });
  if (!response.ok) await parseErrorResponse(response);
  return response.json();
}

export async function updateRecipient(id: string, request: RecipientUpdateRequest): Promise<Recipient> {
  const response = await fetch(`${base}/recipients/${id}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: mutationHeaders(),
    body: JSON.stringify(request),
  });
  if (!response.ok) await parseErrorResponse(response);
  return response.json();
}

/** DELETE /recipients/:id — soft delete (BR-GEN-006), never a hard delete. */
export async function deleteRecipient(id: string): Promise<void> {
  const response = await fetch(`${base}/recipients/${id}`, {
    method: 'DELETE',
    credentials: 'include',
    headers: mutationHeaders(),
  });
  if (!response.ok) await parseErrorResponse(response);
}

/** GET /recipients/:id — recipient:read, same floor every CAMPAIGN_MANAGE role already holds. */
export async function getRecipient(id: string): Promise<Recipient> {
  const response = await fetch(`${base}/recipients/${id}`, { credentials: 'include' });
  if (!response.ok) await parseErrorResponse(response);
  return response.json();
}
