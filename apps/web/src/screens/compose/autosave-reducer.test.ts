import { describe, expect, it } from 'vitest';
import type { CampaignDraft } from '../../api/campaigns.js';
import { autosaveReducer, type AutosaveState } from './autosave-reducer.js';

const draft = { id: 'draft-1', name: 'Before', subject: '', templateId: null, templateVersionId: null, sender: {}, audience: {}, settings: {}, status: 'draft', version: 0, completeness: 20, ownerId: 'owner-1', createdAt: '', updatedAt: '' } as CampaignDraft;

describe('campaign autosave reducer', () => {
  it('queues a later edit and sends it with the version from the preceding response', () => {
    let state: AutosaveState = { draft, pending: null, inFlight: null, status: 'saved' };
    state = autosaveReducer(state, { type: 'change', patch: { subject: 'First' } });
    state = autosaveReducer(state, { type: 'start' });
    state = autosaveReducer(state, { type: 'change', patch: { name: 'Second' } });
    state = autosaveReducer(state, { type: 'saved', draft: { ...draft, subject: 'First', version: 1 } });
    expect(state).toMatchObject({ draft: { name: 'Second', subject: 'First', version: 1 }, pending: { name: 'Second' }, inFlight: null, status: 'idle' });
    expect(autosaveReducer(state, { type: 'start' }).inFlight).toEqual({ name: 'Second' });
  });

  it("surfaces an optimistic-concurrency conflict without dropping the user's local edit", () => {
    const changed = autosaveReducer({ draft, pending: null, inFlight: null, status: 'saved' }, { type: 'change', patch: { name: 'Edited locally' } });
    const started = autosaveReducer(changed, { type: 'start' });
    expect(autosaveReducer(started, { type: 'failed', conflict: true })).toMatchObject({ draft: { name: 'Edited locally' }, pending: { name: 'Edited locally' }, status: 'conflict' });
  });

  it('rebases preserved local changes onto the latest server version after explicit confirmation', () => {
    const conflict = autosaveReducer(
      { draft: { ...draft, name: 'Edited locally' }, pending: null, inFlight: { name: 'Edited locally' }, status: 'saving' },
      { type: 'failed', conflict: true },
    );
    const resolved = autosaveReducer(conflict, { type: 'resolveConflict', serverDraft: { ...draft, subject: 'Server subject', version: 2 }, keepLocal: true });
    expect(resolved).toMatchObject({ draft: { name: 'Edited locally', subject: 'Server subject', version: 2 }, pending: { name: 'Edited locally' }, status: 'idle' });
  });

  it('can discard local changes and use the latest server draft', () => {
    const conflict = { draft: { ...draft, name: 'Edited locally' }, pending: { name: 'Edited locally' }, inFlight: null, status: 'conflict' } as AutosaveState;
    expect(autosaveReducer(conflict, { type: 'resolveConflict', serverDraft: { ...draft, name: 'Server name', version: 2 }, keepLocal: false }))
      .toMatchObject({ draft: { name: 'Server name', version: 2 }, pending: null, status: 'saved' });
  });
});
