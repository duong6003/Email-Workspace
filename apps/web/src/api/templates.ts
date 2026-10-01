import { parseErrorResponse } from './problem.js';
import type { CustomFieldType } from './customFields.js';

const base = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api/v1';

export type TemplateStatus = 'draft' | 'published' | 'archived';
export type TemplateValidation = { warnings: string[]; errors: string[]; changes: string[] };
export type EmailTemplate = {
  id: string;
  name: string;
  status: TemplateStatus;
  origin: 'imported' | 'builder';
  draftRevision: number;
  subject: string;
  html: string;
  textBody: string;
  projectData: Record<string, unknown> | null;
  validation: TemplateValidation;
  createdAt: string;
  updatedAt: string;
  latestVersionId: string | null;
};

/** Library-list shape. The server no longer sends content in the listing -- see TemplateSummary in the contract. */
export type EmailTemplateSummary = Omit<EmailTemplate, 'html' | 'textBody'>;
export type TemplateVersion = {
  id: string;
  templateId: string;
  version: number;
  subject: string;
  html: string;
  textBody: string;
  variableSchema: {
    required: string[];
    optional: string[];
    defaults?: Record<string, unknown>;
    configured?: Record<string, { label: string; scope: 'global' | 'template'; allowCampaignOverride: boolean }>;
  };
  contentHash: string;
  publishedAt: string;
};
export type TemplateQuery = { search?: string; status?: 'draft' | 'published'; limit?: number };
export type TemplatePatch = Partial<Pick<EmailTemplate, 'name' | 'subject' | 'html' | 'textBody' | 'projectData'>>;
export type TemplateAnalysis = {
  sanitizedHtml: string;
  validation: TemplateValidation;
  variables: Array<{ field: 'subject' | 'html' | 'textBody'; key: string; start: number; end: number; classification: 'system' | 'custom' | 'unknown'; source: 'system' | 'recipient' | 'global' | 'template' | 'unknown'; label: string | null }>;
  unknownVariables: Array<{ field: 'subject' | 'html' | 'textBody'; key: string; start: number; end: number; classification: 'unknown'; source: 'unknown'; label: null; suggestedActions: string[] }>;
  catalogue: TemplateVariableCatalogueItem[];
  // ADR-051 added HTML_SIZE_GMAIL_CLIP and HEADING_ORDER_INVALID -- keep in sync with `LINT_CODES` in apps/api/src/templates/template-content-lint.ts and contracts/openapi.yaml's `lint.items.properties.code` enum.
  lint: Array<{ code: 'HTML_SIZE_LARGE'|'HTML_SIZE_GMAIL_CLIP'|'TEXT_BODY_EMPTY'|'IMAGE_ALT_MISSING'|'LINK_TARGET_MISSING'|'LINK_PLACEHOLDER'|'LINK_INVALID'|'HEADING_ORDER_INVALID'; severity: 'warning'; count: number; field: 'html'|'textBody' }>;
};

export type TemplateVariableCatalogueItem = {
  key: string;
  label: string;
  classification: 'system' | 'custom';
  source: 'system' | 'recipient' | 'global' | 'template';
  required: boolean;
  /**
   * ADR-036. `{{ngay_het_han}}` says nothing about how it renders -- that is
   * the price of leaving the token grammar alone -- so the catalogue carries
   * the effective pattern, zone and a worked `example` the server produced
   * through the very function the send uses.
   */
  dataType: CustomFieldType;
  format: string | null;
  timezone: string | null;
  example: string | null;
};

function csrfHeaders(): Record<string, string> {
  const token = document.cookie.split('; ').find((row) => row.startsWith('eow_csrf='))?.split('=')[1];
  return { 'content-type': 'application/json', ...(token ? { 'x-csrf-token': token } : {}) };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${base}${path}`, { credentials: 'include', ...init });
  if (!response.ok) await parseErrorResponse(response);
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

export function templateQueryString(query: TemplateQuery): string {
  const params = new URLSearchParams();
  if (query.search) params.set('search', query.search);
  if (query.status) params.set('status', query.status);
  if (query.limit) params.set('limit', String(query.limit));
  return params.toString();
}

export function listTemplates(query: TemplateQuery = {}): Promise<{ items: EmailTemplateSummary[] }> {
  const suffix = templateQueryString(query);
  return request(`/templates${suffix ? `?${suffix}` : ''}`);
}

export function getTemplate(id: string): Promise<EmailTemplate> {
  return request(`/templates/${id}`);
}

export function getTemplateVersion(versionId: string): Promise<TemplateVersion> {
  return request(`/template-versions/${versionId}`);
}

export function createTemplate(body: { name: string; subject?: string; html?: string; textBody?: string; origin?: 'imported' | 'builder' }): Promise<EmailTemplate> {
  return request('/templates', { method: 'POST', headers: csrfHeaders(), body: JSON.stringify(body) });
}

export function analyzeTemplate(body: { templateId?: string; subject?: string; html?: string; textBody?: string }): Promise<TemplateAnalysis> {
  return request('/templates/analyze', { method: 'POST', headers: csrfHeaders(), body: JSON.stringify(body) });
}

/** `draftRevision` comes from the authoritative response body; reading ETag is unnecessary in-browser. */
export function updateTemplate(id: string, draftRevision: number, body: TemplatePatch): Promise<EmailTemplate> {
  return request(`/templates/${id}`, { method: 'PATCH', headers: { ...csrfHeaders(), 'if-match': String(draftRevision) }, body: JSON.stringify(body) });
}

export function archiveTemplate(id: string): Promise<void> {
  return request(`/templates/${id}`, { method: 'DELETE', headers: csrfHeaders() });
}

export function publishTemplate(id: string): Promise<TemplateVersion> {
  return request(`/templates/${id}/publish`, { method: 'POST', headers: csrfHeaders() });
}

/** History-list entry: metadata only. Fetch the version itself to read its content. */
export type TemplateVersionSummary = {
  id: string;
  version: number;
  subject: string;
  contentHash: string;
  publishedAt: string;
  publishedBy: string | null;
};

export function listTemplateVersions(templateId: string): Promise<{ items: TemplateVersionSummary[] }> {
  return request(`/templates/${templateId}/versions`);
}

/** Replaces the draft's content with this version's. The version is untouched. */
export function restoreTemplateVersion(templateId: string, versionId: string, draftRevision: number): Promise<EmailTemplate> {
  return request(`/templates/${templateId}/versions/${versionId}/restore`, { method: 'POST', headers: { ...csrfHeaders(), 'if-match': String(draftRevision) } });
}

export type TemplatePreview = { subject: string; html: string; textBody: string; missingKeys: string[] };
export type TemplateTestSendResult = { id: string; recipient: string; idempotencyReplayed: boolean };

export function previewTemplateVersion(versionId: string, mergeData: Record<string, unknown>): Promise<TemplatePreview> {
  return request(`/template-versions/${versionId}/preview`, { method: 'POST', headers: csrfHeaders(), body: JSON.stringify({ mergeData }) });
}

export function previewTemplateDraft(templateId: string, mergeData: Record<string, unknown>): Promise<TemplatePreview> {
  return request(`/templates/${templateId}/preview`, { method: 'POST', headers: csrfHeaders(), body: JSON.stringify({ mergeData }) });
}

export function sendTemplateVersionTest(versionId: string, mergeData: Record<string, unknown>, idempotencyKey: string): Promise<TemplateTestSendResult> {
  return request(`/template-versions/${versionId}/test-send`, {
    method: 'POST',
    headers: { ...csrfHeaders(), 'idempotency-key': idempotencyKey },
    body: JSON.stringify({ mergeData }),
  });
}
