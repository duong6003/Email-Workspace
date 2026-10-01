import { parseErrorResponse } from './problem.js';

const base = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api/v1';

export type BulkJobRequest = {
  action: 'add_tag' | 'remove_tag' | 'add_list' | 'remove_list' | 'set_custom_data' | 'export' | 'delete';
  actionPayload: Record<string, unknown>;
  recipientIds: string[];
};

export type BulkJob = {
  jobId: string;
  kind: 'bulk_update';
  action: BulkJobRequest['action'];
  status: 'queued' | 'running' | 'completed' | 'partial_success' | 'failed';
  resolvedCount: number;
  processedRows: number;
  succeededRows: number;
  failedRows: number;
  skippedRows: number;
  idempotencyReplayed: boolean;
  createdAt: string;
};

export type BulkJobPreview = {
  scope: 'selected_recipients';
  estimatedCount: number;
  action: BulkJobRequest['action'];
  actionPayload: Record<string, unknown>;
};

function csrfHeader(): Record<string, string> {
  const token = document.cookie.split('; ').find((row) => row.startsWith('eow_csrf='))?.split('=')[1];
  return { 'content-type': 'application/json', ...(token ? { 'x-csrf-token': token } : {}) };
}

export async function createBulkJob(request: BulkJobRequest): Promise<BulkJob> {
  const response = await fetch(`${base}/bulk-jobs`, {
    method: 'POST', credentials: 'include',
    headers: { ...csrfHeader(), 'idempotency-key': crypto.randomUUID() },
    body: JSON.stringify(request),
  });
  if (!response.ok) await parseErrorResponse(response);
  return response.json();
}

export async function previewBulkJob(request: BulkJobRequest): Promise<BulkJobPreview> {
  const response = await fetch(`${base}/bulk-jobs/preview`, {
    method: 'POST', credentials: 'include', headers: csrfHeader(), body: JSON.stringify(request),
  });
  if (!response.ok) await parseErrorResponse(response);
  return response.json();
}

export async function listBulkJobs(): Promise<BulkJob[]> {
  const response = await fetch(`${base}/bulk-jobs`, { credentials: 'include' });
  if (!response.ok) await parseErrorResponse(response);
  return response.json();
}

export async function getBulkJob(jobId: string): Promise<BulkJob> {
  const response = await fetch(`${base}/bulk-jobs/${jobId}`, { credentials: 'include' });
  if (!response.ok) await parseErrorResponse(response);
  return response.json();
}

export function bulkJobErrorFileUrl(jobId: string): string {
  return `${base}/bulk-jobs/${jobId}/error-file`;
}

export function bulkJobResultFileUrl(jobId: string): string {
  return `${base}/bulk-jobs/${jobId}/result-file`;
}
