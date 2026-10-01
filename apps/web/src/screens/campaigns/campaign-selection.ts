export type SelectableCampaign = { id: string; status: string };
export type BulkActionAvailability = { delete: boolean; duplicate: boolean; cancel: boolean };

const CANCELLABLE = new Set(['scheduled', 'queued', 'sending']);

export function toggleSelection(selected: readonly string[], id: string): string[] {
  return selected.includes(id) ? selected.filter((value) => value !== id) : [...selected, id];
}

export function selectAll(rows: readonly SelectableCampaign[], selected: readonly string[]): string[] {
  return selected.length === rows.length && rows.length > 0 ? [] : rows.map((row) => row.id);
}

/**
 * An action is offered only when it is valid for *every* selected row, so a
 * bulk click can never produce a result the user did not ask for. Ids that are
 * no longer on the page are ignored rather than blocking the action: the
 * server re-checks each row anyway and reports it as skipped.
 */
export function availableBulkActions(rows: readonly SelectableCampaign[], selected: readonly string[]): BulkActionAvailability {
  const statuses = selected
    .map((id) => rows.find((row) => row.id === id)?.status)
    .filter((status): status is string => status !== undefined);
  if (statuses.length === 0) return { delete: false, duplicate: false, cancel: false };
  return {
    delete: statuses.every((status) => status === 'draft'),
    duplicate: true,
    cancel: statuses.every((status) => CANCELLABLE.has(status)),
  };
}
