export type AutosaveStatus = 'idle' | 'saving' | 'saved' | 'conflict' | 'error';
export type AutosaveState<TDraft, TPatch> = { draft: TDraft; pending: TPatch | null; inFlight: TPatch | null; status: AutosaveStatus };
export type AutosaveAction<TDraft, TPatch> =
  | { type: 'change'; patch: TPatch }
  | { type: 'start' }
  | { type: 'saved'; draft: TDraft }
  | { type: 'failed'; conflict: boolean }
  | { type: 'resolveConflict'; serverDraft: TDraft; keepLocal: boolean };

/** One request is in flight at most; later edits wait for the response's revision. */
export function autosaveReducer<TDraft, TPatch extends object>(
  state: AutosaveState<TDraft, TPatch>,
  action: AutosaveAction<TDraft, TPatch>,
): AutosaveState<TDraft, TPatch> {
  if (action.type === 'change') return { ...state, draft: { ...state.draft, ...action.patch }, pending: { ...state.pending, ...action.patch } as TPatch, status: 'idle' };
  if (action.type === 'start') return state.inFlight || !state.pending ? state : { ...state, inFlight: state.pending, pending: null, status: 'saving' };
  if (action.type === 'saved') return { ...state, draft: { ...action.draft, ...(state.pending ?? {}) }, inFlight: null, status: state.pending ? 'idle' : 'saved' };
  if (action.type === 'resolveConflict') {
    if (!action.keepLocal) return { draft: action.serverDraft, pending: null, inFlight: null, status: 'saved' };
    const localPatch = (state.pending ?? {}) as TPatch;
    return { draft: { ...action.serverDraft, ...localPatch }, pending: localPatch, inFlight: null, status: Object.keys(localPatch).length > 0 ? 'idle' : 'saved' };
  }
  // Both failure kinds put the in-flight patch back under any newer edit, so a
  // rejected save never loses what it was carrying. They differ only in status:
  // a conflict needs the user to choose a side, an error just needs another
  // attempt. Neither retries on its own -- the screens hold off while status is
  // 'conflict' or 'error', and the next keystroke flushes the merged patch.
  return { ...state, pending: { ...state.inFlight, ...state.pending } as TPatch, inFlight: null, status: action.conflict ? 'conflict' : 'error' };
}
