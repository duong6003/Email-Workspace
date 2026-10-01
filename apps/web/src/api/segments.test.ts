import { describe, expect, it, vi } from 'vitest';
import { createRecipientList, listTags } from './segments.js';

describe('segments API client', () => {
  it('sends CSRF for a list mutation and returns master-data pages', async () => {
    vi.stubGlobal('document', { cookie: 'eow_csrf=csrf-token' });
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'list-1', name: 'Customers', memberCount: 0 }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [], nextCursor: null, total: 0 }), { status: 200 }));
    await expect(createRecipientList({ name: 'Customers' })).resolves.toMatchObject({ id: 'list-1' });
    await expect(listTags({ search: 'priority' })).resolves.toMatchObject({ total: 0 });
    expect(fetchMock).toHaveBeenNthCalledWith(1, expect.stringContaining('/recipient-lists'), expect.objectContaining({ method: 'POST', credentials: 'include', headers: expect.objectContaining({ 'x-csrf-token': 'csrf-token' }) }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, expect.stringContaining('/tags?search=priority'), expect.objectContaining({ credentials: 'include' }));
  });
});
