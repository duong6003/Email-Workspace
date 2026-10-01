import { afterEach, describe, expect, it, vi } from 'vitest';
import { getRecipient, listRecipients } from './recipients.js';

describe('recipient API query serialization', () => {
  afterEach(() => vi.restoreAllMocks());

  it('serializes list and tag membership filters as repeated tenant-scoped query parameters', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [], nextCursor: null, total: 0 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await listRecipients({ listIds: ['list-1', 'list-2'], tagIds: ['tag-1'], status: ['active'] });

    expect(String(fetchMock.mock.calls[0][0])).toContain('status=active');
    expect(String(fetchMock.mock.calls[0][0])).toContain('listIds=list-1');
    expect(String(fetchMock.mock.calls[0][0])).toContain('listIds=list-2');
    expect(String(fetchMock.mock.calls[0][0])).toContain('tagIds=tag-1');
  });
});

describe('getRecipient', () => {
  afterEach(() => vi.restoreAllMocks());

  it('fetches /recipients/:id and returns the parsed recipient', async () => {
    const body = { id: 'r1', email: 'a@x.test', firstName: 'A', lastName: null, phone: null, department: null, title: null, location: null, subscriptionStatus: 'active', customData: {}, unsubscribedAt: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await getRecipient('r1');

    expect(String(fetchMock.mock.calls[0][0])).toContain('/recipients/r1');
    expect(result.email).toBe('a@x.test');
  });
});
