import { parseErrorResponse } from './problem.js';

const base = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api/v1';

export type ImportJob = {
  id: string; jobId: string; kind: 'import'; fileName: string; status: 'queued' | 'running' | 'completed' | 'partial_success' | 'failed';
  totalRows: number; processedRows: number; succeededRows: number; failedRows: number; skippedRows: number;
  idempotencyReplayed: boolean; createdAt: string;
};

export type ImportJobRequest = {
  fileName: string;
  fileSizeBytes: number;
  fileFingerprint?: string;
  mode: 'create_only' | 'update_existing' | 'upsert';
  mapping: Record<string, string>;
  rows: Array<{ rowNumber: number; rawData: Record<string, unknown> }>;
};

export type ImportPreview = {
  rows: Array<{ rowNumber: number; rawData: Record<string, unknown> }>;
  errors: Array<{ rowNumber: number; column: string; reason: string }>;
};

function csrfHeader(): Record<string, string> {
  const token = document.cookie.split('; ').find((row) => row.startsWith('eow_csrf='))?.split('=')[1];
  return { 'content-type': 'application/json', ...(token ? { 'x-csrf-token': token } : {}) };
}

export async function listImportJobs(): Promise<ImportJob[]> {
  const response = await fetch(`${base}/import-jobs`, { credentials: 'include' });
  if (!response.ok) await parseErrorResponse(response);
  return response.json();
}

export async function getImportJob(jobId: string): Promise<ImportJob> {
  const response = await fetch(`${base}/import-jobs/${jobId}`, { credentials: 'include' });
  if (!response.ok) await parseErrorResponse(response);
  return response.json();
}

export async function createImportJob(request: ImportJobRequest, idempotencyKey: string): Promise<ImportJob> {
  const response = await fetch(`${base}/import-jobs`, {
    method: 'POST', credentials: 'include',
    headers: { ...csrfHeader(), 'idempotency-key': idempotencyKey },
    body: JSON.stringify(request),
  });
  if (!response.ok) await parseErrorResponse(response);
  return response.json();
}

export async function previewImportJob(request: ImportJobRequest): Promise<ImportPreview> {
  const response = await fetch(`${base}/import-jobs/preview`, {
    method: 'POST', credentials: 'include', headers: csrfHeader(), body: JSON.stringify(request),
  });
  if (!response.ok) await parseErrorResponse(response);
  return response.json();
}

export function importJobErrorFileUrl(jobId: string): string {
  return `${base}/import-jobs/${jobId}/error-file`;
}
