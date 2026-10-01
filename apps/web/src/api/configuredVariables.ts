import { parseErrorResponse } from './problem.js';
import type { CustomFieldType } from './customFields.js';

const base = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api/v1';

export type ConfiguredVariable = {
  id: string;
  scope: 'global' | 'template';
  templateId: string | null;
  key: string;
  label: string;
  /** ADR-036: configured variables were untyped; anything created before it reads back as 'text'. */
  dataType: CustomFieldType;
  enumOptions: string[] | null;
  format: string | null;
  timezone: string | null;
  defaultValue: unknown;
  required: boolean;
  allowCampaignOverride: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ConfiguredVariableInput = {
  key: string;
  label: string;
  dataType?: CustomFieldType;
  enumOptions?: string[];
  format?: string | null;
  timezone?: string | null;
  defaultValue?: unknown;
  required?: boolean;
  allowCampaignOverride?: boolean;
};

/** dataType is immutable after creation, exactly as a custom field's type is. */
export type ConfiguredVariableUpdate = Partial<Omit<ConfiguredVariableInput, 'key' | 'dataType'>>;

function mutationHeaders(): Record<string, string> {
  const token = document.cookie.split('; ').find((row) => row.startsWith('eow_csrf='))?.split('=')[1];
  return { 'content-type': 'application/json', ...(token ? { 'x-csrf-token': token } : {}) };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${base}${path}`, { credentials: 'include', ...init });
  if (!response.ok) await parseErrorResponse(response);
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

export function listGlobalVariables(): Promise<{ items: ConfiguredVariable[] }> {
  return request('/global-variables');
}

export function createGlobalVariable(body: ConfiguredVariableInput): Promise<ConfiguredVariable> {
  return request('/global-variables', { method: 'POST', headers: mutationHeaders(), body: JSON.stringify(body) });
}

export function updateGlobalVariable(id: string, body: Omit<ConfiguredVariableUpdate, 'required'>): Promise<ConfiguredVariable> {
  return request(`/global-variables/${id}`, { method: 'PATCH', headers: mutationHeaders(), body: JSON.stringify(body) });
}

export function deleteGlobalVariable(id: string): Promise<void> {
  return request(`/global-variables/${id}`, { method: 'DELETE', headers: mutationHeaders() });
}

export function listTemplateVariables(templateId: string): Promise<{ items: ConfiguredVariable[] }> {
  return request(`/templates/${templateId}/variables`);
}

export function createTemplateVariable(templateId: string, body: ConfiguredVariableInput): Promise<ConfiguredVariable> {
  return request(`/templates/${templateId}/variables`, { method: 'POST', headers: mutationHeaders(), body: JSON.stringify(body) });
}

export function updateTemplateVariable(id: string, body: ConfiguredVariableUpdate): Promise<ConfiguredVariable> {
  return request(`/template-variables/${id}`, { method: 'PATCH', headers: mutationHeaders(), body: JSON.stringify(body) });
}

export function deleteTemplateVariable(id: string): Promise<void> {
  return request(`/template-variables/${id}`, { method: 'DELETE', headers: mutationHeaders() });
}
