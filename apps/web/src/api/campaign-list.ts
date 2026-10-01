import { parseErrorResponse } from './problem.js';

const base = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api/v1';

/** M6-S3 (BR-HIS-001/004). A row with no live execution (a merely-scheduled campaign) has progress: null -- "no progress before start" is a data-model fact, not a UI special case. */
export type CampaignHistoryProgress = {
  executionStatus: string;
  totalSnapshot: number;
  percent: number;
  sent: number;
  delivered: number;
  failed: number;
  pending: number;
};

export type CampaignHistoryRow = {
  id: string;
  name: string;
  subject: string;
  status: string;
  scheduledAtUtc: string | null;
  scheduledTimezone: string | null;
  createdAt: string;
  createdBy: string | null;
  executionId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  senderConfigId: string | null;
  progress: CampaignHistoryProgress | null;
  cursor: string;
};

/** BR-HIS-004: server time, never the client clock -- every countdown is computed as an offset against this field. */
export type CampaignHistoryPage = {
  serverTime: string;
  items: CampaignHistoryRow[];
  nextCursor: string | null;
};

export type CampaignHistoryQuery = {
  status?: string;
  dateFrom?: string;
  dateTo?: string;
  senderConfigId?: string;
  createdBy?: string;
  search?: string;
  limit?: number;
  cursor?: string;
  /** ADR-034: ask for draft rows too. The server still gates them on content:manage and draft ownership. */
  includeDrafts?: boolean;
  scope?: 'mine' | 'all';
};

export type CampaignExport = {
  id: string;
  campaignId: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  kind: string;
  rowCount: number;
  expiresAt: string | null;
  createdAt: string;
};

export type CampaignResendResult = {
  campaignId: string;
  executionId: string;
  snapshotId: string;
  parentExecutionId: string;
  resendGeneration: number;
  recipientCount: number;
  idempotencyReplayed: boolean;
};

export type CampaignPauseResumeResult = {
  campaignId: string;
  executionId: string | null;
  status: string;
  idempotencyReplayed: boolean;
};

export type CampaignRecipientHistory = {
  id: string;
  recipientId: string;
  email: string;
  displayName: string | null;
  status: 'pending' | 'queued' | 'submitted' | 'delivered' | 'bounced' | 'failed' | 'skipped' | 'cancelled';
  skippedReason: string | null;
  attemptCount: number;
  providerMessageId: string | null;
  lastErrorCode: string | null;
  lastErrorClass: string | null;
  failureReason: string | null;
  lastAttemptAt: string | null;
  submittedAt: string | null;
  deliveredAt: string | null;
  nextRetryAt: string | null;
  updatedAt: string;
};

export type CampaignRecipientHistoryPage = { items: CampaignRecipientHistory[]; nextCursor: string | null };
export type CampaignRecipientHistoryQuery = { status?: CampaignRecipientHistory['status']; search?: string; limit?: number; cursor?: string };

function csrfHeaders(): Record<string, string> {
  const token = document.cookie.split('; ').find((row) => row.startsWith('eow_csrf='))?.split('=')[1];
  return { 'content-type': 'application/json', ...(token ? { 'x-csrf-token': token } : {}) };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${base}${path}`, { credentials: 'include', ...init });
  if (!response.ok) await parseErrorResponse(response);
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

export function fetchCampaignHistory(query: CampaignHistoryQuery = {}): Promise<CampaignHistoryPage> {
  const params = new URLSearchParams();
  if (query.status) params.set('status', query.status);
  if (query.dateFrom) params.set('dateFrom', query.dateFrom);
  if (query.dateTo) params.set('dateTo', query.dateTo);
  if (query.senderConfigId) params.set('senderConfigId', query.senderConfigId);
  if (query.createdBy) params.set('createdBy', query.createdBy);
  if (query.search) params.set('search', query.search);
  if (query.limit) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  if (query.includeDrafts) params.set('includeDrafts', 'true');
  if (query.scope) params.set('scope', query.scope);
  const suffix = params.toString();
  return request(`/campaigns/history${suffix ? `?${suffix}` : ''}`);
}

export function fetchCampaignRecipients(campaignId: string, query: CampaignRecipientHistoryQuery = {}): Promise<CampaignRecipientHistoryPage> {
  const params = new URLSearchParams();
  if (query.status) params.set('status', query.status);
  if (query.search) params.set('search', query.search);
  if (query.limit) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  const suffix = params.toString();
  return request(`/campaigns/${campaignId}/recipients${suffix ? `?${suffix}` : ''}`);
}

export function resendCampaign(campaignId: string, idempotencyKey: string): Promise<CampaignResendResult> {
  return request(`/campaigns/${campaignId}/resend`, { method: 'POST', headers: { ...csrfHeaders(), 'idempotency-key': idempotencyKey } });
}

export function pauseCampaign(campaignId: string, idempotencyKey: string): Promise<CampaignPauseResumeResult> {
  return request(`/campaigns/${campaignId}/pause`, { method: 'POST', headers: { ...csrfHeaders(), 'idempotency-key': idempotencyKey } });
}

export function resumeCampaign(campaignId: string, idempotencyKey: string): Promise<CampaignPauseResumeResult> {
  return request(`/campaigns/${campaignId}/resume`, { method: 'POST', headers: { ...csrfHeaders(), 'idempotency-key': idempotencyKey } });
}

export function createCampaignExport(campaignId: string, idempotencyKey: string, body: { kind?: 'campaign_recipients' | 'campaign_failures'; statusFilter?: string[] } = {}): Promise<CampaignExport> {
  return request(`/campaigns/${campaignId}/exports`, { method: 'POST', headers: { ...csrfHeaders(), 'idempotency-key': idempotencyKey }, body: JSON.stringify(body) });
}

export function getCampaignExport(campaignId: string, exportId: string): Promise<CampaignExport> {
  return request(`/campaigns/${campaignId}/exports/${exportId}`);
}

/** The download route streams a file; the caller navigates/opens this URL directly rather than fetching it as JSON. */
export function campaignExportDownloadUrl(campaignId: string, exportId: string): string {
  return `${base}/campaigns/${campaignId}/exports/${exportId}/file`;
}

export type CampaignBulkAction = 'delete' | 'duplicate' | 'cancel';
export type CampaignBulkResult = { campaignId: string; outcome: 'succeeded' | 'failed' | 'skipped'; code: string; message: string };
export type CampaignBulkResponse = { results: CampaignBulkResult[]; succeeded: number; failed: number; skipped: number };

/**
 * Synchronous: the selection is bounded by what the list has loaded, so the
 * caller gets per-campaign outcomes back in the response rather than polling
 * a job. Carries no If-Match (N versions cannot travel in one request) and no
 * idempotency key -- the caller disables the control while it is in flight.
 */
export function bulkCampaignAction(action: CampaignBulkAction, campaignIds: string[]): Promise<CampaignBulkResponse> {
  return request('/campaigns/bulk', { method: 'POST', headers: csrfHeaders(), body: JSON.stringify({ action, campaignIds }) });
}
