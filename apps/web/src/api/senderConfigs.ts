import { parseErrorResponse } from './problem.js';
const base = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api/v1';
function csrf() { const token = document.cookie.split('; ').find((row) => row.startsWith('eow_csrf='))?.split('=')[1]; return { 'content-type': 'application/json', ...(token ? { 'x-csrf-token': token } : {}) }; }
async function request<T>(path: string, init?: RequestInit): Promise<T> { const response = await fetch(`${base}${path}`, { credentials: 'include', ...init }); if (!response.ok) await parseErrorResponse(response); return response.status === 204 ? undefined as T : response.json() as Promise<T>; }
export type SenderConfig = { id: string; name: string; fromName: string; fromEmail: string; replyTo: string | null; provider: string; host: string; port: number; username: string; secretRef: string; credentialConfigured: boolean; status: 'pending' | 'verified' | 'failed' | 'disabled'; verifiedAt: string | null; lastTestedAt: string | null; createdAt: string; updatedAt: string };
export type SenderInput = { name: string; fromName: string; fromEmail: string; replyTo?: string | null; host: string; port: number; username: string; secret: string };
/** `defaultTimezone` (ADR-036) is the tenant default zone typed variables render in; null means UTC. */
export type SendingPolicy = { defaultSenderConfigId: string | null; replyTo: string | null; batchSize: number; maxAttempts: number; tenantRateLimitPerMinute: number; defaultTimezone: string | null };
export function listSenderConfigs(options: { usable?: boolean } = {}) { return request<{ items: SenderConfig[] }>(`/sender-configs${options.usable ? '?usable=true' : ''}`); }
export function createSenderConfig(body: SenderInput) { return request<SenderConfig>('/sender-configs', { method: 'POST', headers: csrf(), body: JSON.stringify(body) }); }
export function updateSenderConfig(id: string, body: Partial<SenderInput>) { return request<SenderConfig>(`/sender-configs/${id}`, { method: 'PATCH', headers: csrf(), body: JSON.stringify(body) }); }
export function disableSenderConfig(id: string) { return request<void>(`/sender-configs/${id}`, { method: 'DELETE', headers: csrf() }); }
export function testSenderConnection(id: string, secret?: string) { return request<{ ok: boolean; status?: string; code?: string; classification?: string; reason?: string | null }>(`/sender-configs/${id}/test-connection`, { method: 'POST', headers: { ...csrf(), 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify(secret ? { secret } : {}) }); }
export function getSendingPolicy() { return request<SendingPolicy>('/sending-policy'); }
export function updateSendingPolicy(body: SendingPolicy) { return request<SendingPolicy>('/sending-policy', { method: 'PUT', headers: csrf(), body: JSON.stringify(body) }); }
