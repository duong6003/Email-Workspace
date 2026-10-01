import { parseErrorResponse } from './problem.js';

const base = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api/v1';

export type SegmentPage<T> = { items: T[]; nextCursor: string | null; total: number };
export type RecipientList = { id: string; name: string; description: string | null; memberCount: number; createdAt: string; updatedAt: string };
export type Tag = { id: string; name: string; color: TagColor; memberCount: number; createdAt: string; updatedAt: string };
export const tagColors = ['#ef6f45', '#7356c8', '#278b6e', '#d79022', '#3a78c2', '#9a5eb0', '#31806b', '#b85b73'] as const;
export type TagColor = (typeof tagColors)[number];
export type SegmentQuery = { search?: string; cursor?: string; limit?: number };
export type RecipientSegments = { lists: RecipientList[]; tags: Tag[] };

function csrfHeaders(): Record<string, string> {
  const token = document.cookie.split('; ').find((row) => row.startsWith('eow_csrf='))?.split('=')[1];
  return { 'content-type': 'application/json', ...(token ? { 'x-csrf-token': token } : {}) };
}

function queryString(query: SegmentQuery): string {
  const params = new URLSearchParams();
  if (query.search) params.set('search', query.search);
  if (query.cursor) params.set('cursor', query.cursor);
  if (query.limit) params.set('limit', String(query.limit));
  return params.toString();
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${base}${path}`, { credentials: 'include', ...init });
  if (!response.ok) await parseErrorResponse(response);
  return response.status === 204 ? undefined as T : response.json();
}

export function listRecipientLists(query: SegmentQuery = {}): Promise<SegmentPage<RecipientList>> {
  const suffix = queryString(query);
  return request(`/recipient-lists${suffix ? `?${suffix}` : ''}`);
}
export function listTags(query: SegmentQuery = {}): Promise<SegmentPage<Tag>> {
  const suffix = queryString(query);
  return request(`/tags${suffix ? `?${suffix}` : ''}`);
}
export function createRecipientList(body: { name: string; description?: string }): Promise<RecipientList> {
  return request('/recipient-lists', { method: 'POST', headers: csrfHeaders(), body: JSON.stringify(body) });
}
export function updateRecipientList(id: string, body: { name?: string; description?: string | null }): Promise<RecipientList> {
  return request(`/recipient-lists/${id}`, { method: 'PATCH', headers: csrfHeaders(), body: JSON.stringify(body) });
}
export function deleteRecipientList(id: string): Promise<void> {
  return request(`/recipient-lists/${id}`, { method: 'DELETE', headers: csrfHeaders() });
}
export function createTag(body: { name: string; color: TagColor }): Promise<Tag> {
  return request('/tags', { method: 'POST', headers: csrfHeaders(), body: JSON.stringify(body) });
}
export function updateTag(id: string, body: { name?: string; color?: TagColor }): Promise<Tag> {
  return request(`/tags/${id}`, { method: 'PATCH', headers: csrfHeaders(), body: JSON.stringify(body) });
}
export function deleteTag(id: string): Promise<void> {
  return request(`/tags/${id}`, { method: 'DELETE', headers: csrfHeaders() });
}
export function getRecipientSegments(id: string): Promise<RecipientSegments> {
  return request(`/recipients/${id}/segments`);
}
export function addRecipientListMembers(id: string, recipientIds: string[]): Promise<void> {
  return request(`/recipient-lists/${id}/members`, { method: 'POST', headers: csrfHeaders(), body: JSON.stringify({ recipientIds }) });
}
export function removeRecipientListMembers(id: string, recipientIds: string[]): Promise<void> {
  return request(`/recipient-lists/${id}/members`, { method: 'DELETE', headers: csrfHeaders(), body: JSON.stringify({ recipientIds }) });
}
export function addTagMembers(id: string, recipientIds: string[]): Promise<void> {
  return request(`/tags/${id}/members`, { method: 'POST', headers: csrfHeaders(), body: JSON.stringify({ recipientIds }) });
}
export function removeTagMembers(id: string, recipientIds: string[]): Promise<void> {
  return request(`/tags/${id}/members`, { method: 'DELETE', headers: csrfHeaders(), body: JSON.stringify({ recipientIds }) });
}
