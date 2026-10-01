import { parseErrorResponse } from './problem.js';

export type CustomFieldType = 'text' | 'number' | 'date' | 'boolean' | 'enum';

export type CustomField = {
  id: string;
  key: string;
  label: string;
  type: CustomFieldType;
  required: boolean;
  defaultValue: unknown;
  enumOptions: string[] | null;
  sensitive: boolean;
  /** ADR-036: null means the product default pattern / the tenant default zone. */
  format: string | null;
  timezone: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CustomFieldListResponse = { items: CustomField[] };

export type CustomFieldCreateRequest = {
  key: string;
  label: string;
  type: CustomFieldType;
  required?: boolean;
  defaultValue?: unknown;
  enumOptions?: string[];
  sensitive?: boolean;
  format?: string | null;
  timezone?: string | null;
};

export type CustomFieldUpdateRequest = {
  label?: string;
  required?: boolean;
  defaultValue?: unknown;
  enumOptions?: string[];
  sensitive?: boolean;
  format?: string | null;
  timezone?: string | null;
};

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

/** GET /custom-fields — the admin-defined typed field schema, consumed by the recipient form and M3-S2 compose variable catalogue. */
export async function listCustomFields(): Promise<CustomFieldListResponse> {
  const response = await fetch(`${base}/custom-fields`, { credentials: 'include' });
  if (!response.ok) await parseErrorResponse(response);
  return response.json();
}

/** POST /custom-fields — BR-CF-003: a reserved system key 422s with `reservedKeys` in the Problem body. */
export async function createCustomField(request: CustomFieldCreateRequest): Promise<CustomField> {
  const response = await fetch(`${base}/custom-fields`, {
    method: 'POST',
    credentials: 'include',
    headers: mutationHeaders(),
    body: JSON.stringify(request),
  });
  if (!response.ok) await parseErrorResponse(response);
  return response.json();
}

/** PATCH /custom-fields/:id — BR-CF-001: key is immutable, never sent. */
export async function updateCustomField(id: string, request: CustomFieldUpdateRequest): Promise<CustomField> {
  const response = await fetch(`${base}/custom-fields/${id}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: mutationHeaders(),
    body: JSON.stringify(request),
  });
  if (!response.ok) await parseErrorResponse(response);
  return response.json();
}

export async function deleteCustomField(id: string): Promise<void> {
  const response = await fetch(`${base}/custom-fields/${id}`, {
    method: 'DELETE',
    credentials: 'include',
    headers: mutationHeaders(),
  });
  if (!response.ok) await parseErrorResponse(response);
}
