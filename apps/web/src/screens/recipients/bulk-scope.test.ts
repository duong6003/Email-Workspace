import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveBulkScope } from './bulk-scope.js';

describe('resolveBulkScope', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps an explicit selection stable and deduplicated before a dry run', async () => {
    await expect(resolveBulkScope({ kind: 'selected_recipients', recipientIds: ['b', 'a', 'a'] }))
      .resolves.toEqual({ label: 'người nhận đã chọn', recipientIds: ['a', 'b'] });
  });

  it('resolves the current filter through every canonical recipient page', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ id: 'r2' }, { id: 'r1' }], nextCursor: 'next', total: 3 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ id: 'r1' }, { id: 'r3' }], nextCursor: null, total: 3 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(resolveBulkScope({ kind: 'current_filter', filters: { status: ['active'], listIds: ['list-1'], tagIds: ['tag-1'] } }))
      .resolves.toEqual({ label: 'bộ lọc hiện tại', recipientIds: ['r1', 'r2', 'r3'] });
    expect(String(fetchMock.mock.calls[0][0])).toContain('status=active');
    expect(String(fetchMock.mock.calls[0][0])).toContain('listIds=list-1');
    expect(String(fetchMock.mock.calls[0][0])).toContain('tagIds=tag-1');
    expect(String(fetchMock.mock.calls[1][0])).toContain('cursor=next');
  });

  it.each([
    [{ kind: 'list', listId: 'list-1' } as const, 'listIds=list-1', 'danh sách đã chọn'],
    [{ kind: 'tag', tagId: 'tag-1' } as const, 'tagIds=tag-1', 'tag đã chọn'],
  ])('resolves a %o scope through the matching tenant query', async (scope, expectedQuery, label) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [{ id: 'r1' }], nextCursor: null, total: 1 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(resolveBulkScope(scope)).resolves.toEqual({ label, recipientIds: ['r1'] });
    expect(String(fetchMock.mock.calls[0][0])).toContain(expectedQuery);
  });
});
