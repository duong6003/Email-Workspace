import { listRecipients, type RecipientListQuery } from '../../api/recipients.js';
import type { RecipientFilterState } from '../../overlays/RecipientFilterOverlay.js';

export type BulkScope =
  | { kind: 'selected_recipients'; recipientIds: string[] }
  | { kind: 'list'; listId: string }
  | { kind: 'tag'; tagId: string }
  | { kind: 'current_filter'; filters: RecipientFilterState };

export type ResolvedBulkScope = { label: string; recipientIds: string[] };

function toQuery(scope: Exclude<BulkScope, { kind: 'selected_recipients' }>): RecipientListQuery {
  if (scope.kind === 'list') return { listIds: [scope.listId] };
  if (scope.kind === 'tag') return { tagIds: [scope.tagId] };
  return {
    status: scope.filters.status.length ? scope.filters.status : undefined,
    listIds: scope.filters.listIds.length ? scope.filters.listIds : undefined,
    tagIds: scope.filters.tagIds.length ? scope.filters.tagIds : undefined,
  };
}

/** Resolves a mutable list/tag/filter query into the frozen IDs sent to preview/create. */
export async function resolveBulkScope(scope: BulkScope): Promise<ResolvedBulkScope> {
  if (scope.kind === 'selected_recipients') {
    return { label: 'người nhận đã chọn', recipientIds: [...new Set(scope.recipientIds)].sort() };
  }

  const recipientIds: string[] = [];
  let cursor: string | null = null;
  do {
    const page = await listRecipients({ ...toQuery(scope), cursor: cursor ?? undefined, limit: 100 });
    recipientIds.push(...page.items.map((recipient) => recipient.id));
    cursor = page.nextCursor;
  } while (cursor);

  const label = scope.kind === 'list' ? 'danh sách đã chọn'
    : scope.kind === 'tag' ? 'tag đã chọn' : 'bộ lọc hiện tại';
  return { label, recipientIds: [...new Set(recipientIds)].sort() };
}
