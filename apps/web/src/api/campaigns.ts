import { parseErrorResponse } from './problem.js';

const base = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api/v1';

export type CampaignSender = { senderConfigId?: string | null; fromName?: string; fromEmail?: string };
export type CampaignAudience = {
  listIds?: string[]; tagIds?: string[]; recipientIds?: string[];
  excludeListIds?: string[]; excludeTagIds?: string[]; excludeRecipientIds?: string[];
};
export type CampaignSettings = { cc?: string[]; bcc?: string[]; variableOverrides?: Record<string, unknown> };

/** M4-S2: BR-SEG-008/009, BR-CMP-002/003, BR-REC-003. */
export type AudienceSkipReason =
  | 'deleted' | 'status_paused' | 'status_unsubscribed' | 'status_bounced'
  | 'excluded_by_list' | 'excluded_by_tag' | 'excluded_by_recipient';
export type AudienceResolution = {
  totalMatched: number;
  totalUnique: number;
  deduplicated: number;
  actionable: number;
  skipped: number;
  skippedByReason: { reason: AudienceSkipReason; count: number }[];
  sample: { recipientId: string; normalizedEmail: string; displayName: string; subscriptionStatus: string; skipReason: AudienceSkipReason | null }[];
};
export type CampaignDraft = {
  id: string; name: string; subject: string; templateId: string | null; templateVersionId: string | null;
  sender: CampaignSender; audience: CampaignAudience; settings: CampaignSettings;
  status: 'draft' | 'scheduled' | 'blocked' | 'missed' | 'queued' | 'validating' | 'sending' | 'paused' | 'completed' | 'partial_failed' | 'failed' | 'cancelled';
  /** M5-S2: set only while status is scheduled/blocked; null otherwise (BR-SCH-002). */
  scheduledAtUtc: string | null;
  scheduledTimezone: string | null;
  /** M5-S2: SCHEDULE_LOCK_WINDOW_SECONDS -- reschedule/cancel refuse with 409 once scheduledAtUtc is this close (BR-SCH-005). */
  scheduleLockWindowSeconds: number;
  version: number; completeness: number; ownerId: string | null; createdAt: string; updatedAt: string;
};
export type CampaignPatch = Partial<Pick<CampaignDraft, 'name' | 'subject' | 'templateId' | 'templateVersionId' | 'sender' | 'audience' | 'settings'>>;
export type CampaignListQuery = { status?: CampaignDraft['status']; limit?: number; scope?: 'mine' | 'all' };

function csrfHeaders(): Record<string, string> {
  const token = document.cookie.split('; ').find((row) => row.startsWith('eow_csrf='))?.split('=')[1];
  return { 'content-type': 'application/json', ...(token ? { 'x-csrf-token': token } : {}) };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${base}${path}`, { credentials: 'include', ...init });
  if (!response.ok) await parseErrorResponse(response);
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

export function campaignQueryString(query: CampaignListQuery): string {
  const params = new URLSearchParams();
  if (query.status) params.set('status', query.status);
  if (query.limit) params.set('limit', String(query.limit));
  if (query.scope) params.set('scope', query.scope);
  return params.toString();
}

export function listCampaignDrafts(query: CampaignListQuery = {}): Promise<{ items: CampaignDraft[] }> {
  const suffix = campaignQueryString(query);
  return request(`/campaigns${suffix ? `?${suffix}` : ''}`);
}

export function createCampaignDraft(body: Pick<CampaignDraft, 'name'> & CampaignPatch): Promise<CampaignDraft> {
  return request('/campaigns', { method: 'POST', headers: csrfHeaders(), body: JSON.stringify(body) });
}

export function getCampaignDraft(id: string): Promise<CampaignDraft> { return request(`/campaigns/${id}`); }

/** `version` comes from the authoritative response body; reading ETag is unnecessary in-browser. */
export function updateCampaignDraft(id: string, version: number, body: CampaignPatch): Promise<CampaignDraft> {
  return request(`/campaigns/${id}`, { method: 'PATCH', headers: { ...csrfHeaders(), 'if-match': String(version) }, body: JSON.stringify(body) });
}

export function deleteCampaignDraft(id: string, version: number): Promise<void> {
  return request(`/campaigns/${id}`, { method: 'DELETE', headers: { ...csrfHeaders(), 'if-match': String(version) } });
}

export function duplicateCampaignDraft(id: string): Promise<CampaignDraft> {
  return request(`/campaigns/${id}/duplicate`, { method: 'POST', headers: csrfHeaders() });
}

/** Read-only despite the POST verb: the audience may not yet be saved to the draft (the picker previews before committing). */
export function previewCampaignAudience(campaignId: string, audience: CampaignAudience): Promise<AudienceResolution> {
  return request(`/campaigns/${campaignId}/audience/preview`, { method: 'POST', headers: csrfHeaders(), body: JSON.stringify({ audience }) });
}

/** M4-S3: BR-CMP-004/005/006/008, BR-TPL-008. */
export type MissingVariableBreakdown = { key: string; label: string; count: number };
export type VariableValidationSample = { recipientId: string; email: string; missingKeys: string[] };
export type AudienceWaiverStatus = 'none' | 'valid' | 'stale';
export type ValidateCampaignAudienceResult = {
  totalActionable: number;
  completeCount: number;
  missingCount: number;
  missingByVariable: MissingVariableBreakdown[];
  sample: VariableValidationSample[];
  waiverStatus: AudienceWaiverStatus;
  waiverAcceptedAt: string | null;
};

/** Read-only: reads the draft's own saved template/audience, nothing to preview. */
export function validateCampaignAudience(campaignId: string): Promise<ValidateCampaignAudienceResult> {
  return request(`/campaigns/${campaignId}/validate-audience`, { method: 'POST', headers: csrfHeaders() });
}

/** The missing-recipient set is always server-computed fresh; there is no request body. */
export function acceptCampaignAudienceWaiver(campaignId: string, version: number): Promise<CampaignDraft> {
  return request(`/campaigns/${campaignId}/audience-waiver`, { method: 'POST', headers: { ...csrfHeaders(), 'if-match': String(version) } });
}

/** M4-S4: BR-CMP-007/010, BR-TPL-001/012, BR-CF-008. */
export type CampaignSnapshotAccepted = {
  campaignId: string;
  snapshotId: string;
  status: 'queued' | 'draft';
  totalSnapshot: number;
  sendableCount: number;
  skippedCount: number;
  frozenAt: string;
  idempotencyReplayed: boolean;
};
export type CampaignRecipientSkipReason = AudienceSkipReason | 'missing_required_variable';
export type CampaignAudienceWaiver = { acceptedAt: string; acceptedBy: string | null; missingVariableRecipientIds: string[] };
export type CampaignSnapshotPolicyResult = {
  totalActionable: number;
  completeCount: number;
  missingCount: number;
  missingByVariable: MissingVariableBreakdown[];
  waiver: CampaignAudienceWaiver | null;
  webOrigin: string;
};
export type CampaignSnapshot = {
  id: string;
  campaignId: string;
  templateVersionId: string;
  sender: CampaignSender;
  audienceQuery: CampaignAudience;
  policyResult: CampaignSnapshotPolicyResult;
  totalSnapshot: number;
  sendableCount: number;
  skippedCount: number;
  frozenAt: string;
  supersededAt: string | null;
  skippedByReason: { reason: CampaignRecipientSkipReason; count: number }[];
};

/**
 * BR-CMP-010/BR-GEN-005: `idempotencyKey` must be the same key across a
 * retry of the same click (the caller owns generating it once, not this
 * function) -- the same key with the same underlying campaign state
 * replays the prior snapshot rather than creating a second one.
 */
export function sendCampaign(campaignId: string, idempotencyKey: string): Promise<CampaignSnapshotAccepted> {
  return request(`/campaigns/${campaignId}/send`, { method: 'POST', headers: { ...csrfHeaders(), 'idempotency-key': idempotencyKey } });
}

/** The only refresh path: supersedes the live snapshot and returns the campaign to draft. */
export function cancelCampaign(campaignId: string): Promise<CampaignSnapshotAccepted> {
  return request(`/campaigns/${campaignId}/cancel`, { method: 'POST', headers: csrfHeaders() });
}

export function getCampaignSnapshot(campaignId: string): Promise<CampaignSnapshot> {
  return request(`/campaigns/${campaignId}/snapshot`);
}

/** M5-S2: BR-SCH-001..005, BR-GEN-003. `localDateTime` is zone-less by design (DEC-093). */
export type CampaignScheduleRequest = { localDateTime: string; timeZone: string; offsetMinutes?: number };
export type CampaignScheduleAccepted = {
  campaignId: string;
  snapshotId: string;
  status: 'scheduled';
  scheduledAtUtc: string;
  timeZone: string;
  offsetMinutes: number;
  lockedAt: string;
  totalSnapshot: number;
  sendableCount: number;
  skippedCount: number;
  idempotencyReplayed: boolean;
};
export type CampaignScheduleCancelAccepted = { campaignId: string; status: 'cancelled' };
export type CampaignScheduleValidationReport = {
  blocking: boolean;
  name: { valid: boolean; reason?: string };
  subject: { valid: boolean; reason?: string };
  sender: { valid: boolean; reason?: string };
  template: { valid: boolean; reason?: string };
  audience: { valid: boolean; totalUnique: number; reason?: string };
  variables: { valid: boolean; missingCount: number; waiverStatus: AudienceWaiverStatus };
  quota: { valid: boolean; limit: number|null; used: number; requested: number; reason?: string };
  content: { valid: true; warnings: Array<{ code: string; severity: 'warning'; count: number; field: string }> };
  domain: { valid: true; warnings: Array<'DOMAIN_READINESS_UNVERIFIED'> };
};
export function getCampaignPreflight(campaignId: string): Promise<CampaignScheduleValidationReport> { return request(`/campaigns/${campaignId}/preflight`); }

/** Same Idempotency-Key discipline as sendCampaign: one key per overlay mount, held by the caller. */
export function scheduleCampaign(campaignId: string, idempotencyKey: string, body: CampaignScheduleRequest): Promise<CampaignScheduleAccepted> {
  return request(`/campaigns/${campaignId}/schedule`, { method: 'POST', headers: { ...csrfHeaders(), 'idempotency-key': idempotencyKey }, body: JSON.stringify(body) });
}

/** BR-SCH-008: a separate terminal route from cancelCampaign -- lands in 'cancelled', not 'draft' (DEC-091). */
export function cancelCampaignSchedule(campaignId: string): Promise<CampaignScheduleCancelAccepted> {
  return request(`/campaigns/${campaignId}/schedule/cancel`, { method: 'POST', headers: csrfHeaders() });
}

/** M5-S3 CP6/CP8: BR-SEND-002. Real per-status counts (D-92); eta is always null (BR-SEND-005 is M6-S1's). */
/** M6-S1: 'estimating' below the minimum sample size; null once nothing remains (BR-SEND-005: "biến mất khi complete"). */
export type CampaignEtaEstimate = { state: 'estimating' } | { state: 'estimated'; secondsRemaining: number } | null;

export type CampaignProgress = {
  campaignId: string;
  version: number;
  status: CampaignDraft['status'];
  total: number;
  queued: number;
  sent: number;
  delivered: number;
  failed: number;
  percent: number;
  actionable: number;
  progressSeq: number;
  eta: CampaignEtaEstimate;
  counts: {
    pending: number; queued: number; submitted: number; delivered: number;
    bounced: number; failed: number; skipped: number; cancelled: number;
  };
  totalSnapshot: number;
  executionId: string | null;
};
export function getCampaignProgress(campaignId: string): Promise<CampaignProgress> {
  return request(`/campaigns/${campaignId}/progress`);
}

/** BR-SEND-010: a separate terminal route from cancelCampaign -- legal only while 'sending' (DEC-091). */
export type CampaignSendCancelAccepted = {
  campaignId: string;
  executionId: string | null;
  status: 'cancelled';
  submittedCount: number;
  cancelledCount: number;
  cancelledAt: string;
  idempotencyReplayed: boolean;
};
export function cancelCampaignSend(campaignId: string, idempotencyKey: string): Promise<CampaignSendCancelAccepted> {
  return request(`/campaigns/${campaignId}/send/cancel`, { method: 'POST', headers: { ...csrfHeaders(), 'idempotency-key': idempotencyKey } });
}
