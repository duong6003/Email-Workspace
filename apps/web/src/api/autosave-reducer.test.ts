import { describe, expect, it } from 'vitest';
import { autosaveReducer, type AutosaveState } from './autosave-reducer.js';

type Draft = { id: string; subject: string; draftRevision: number };
type Patch = Partial<Pick<Draft, 'subject'>>;

const initial = (): AutosaveState<Draft, Patch> => ({
  draft: { id: 't1', subject: 'first', draftRevision: 1 },
  pending: null,
  inFlight: null,
  status: 'saved',
});

describe('autosaveReducer over an arbitrary draft type', () => {
  it('queues a change and moves it in flight exactly once', () => {
    const changed = autosaveReducer(initial(), { type: 'change', patch: { subject: 'second' } });
    expect(changed.draft.subject).toBe('second');
    expect(changed.pending).toEqual({ subject: 'second' });

    const started = autosaveReducer(changed, { type: 'start' });
    expect(started.status).toBe('saving');
    expect(started.inFlight).toEqual({ subject: 'second' });
    expect(started.pending).toBeNull();

    expect(autosaveReducer(started, { type: 'start' })).toBe(started);
  });

  it('keeps a newer local edit on top of the saved server draft', () => {
    const started = autosaveReducer(
      autosaveReducer(initial(), { type: 'change', patch: { subject: 'second' } }),
      { type: 'start' },
    );
    const typedAgain = autosaveReducer(started, { type: 'change', patch: { subject: 'third' } });
    const saved = autosaveReducer(typedAgain, { type: 'saved', draft: { id: 't1', subject: 'second', draftRevision: 2 } });

    expect(saved.draft.draftRevision).toBe(2);
    expect(saved.draft.subject).toBe('third');
    expect(saved.status).toBe('idle');
  });

  it('returns the in-flight patch to pending on conflict', () => {
    const started = autosaveReducer(
      autosaveReducer(initial(), { type: 'change', patch: { subject: 'second' } }),
      { type: 'start' },
    );
    const conflicted = autosaveReducer(started, { type: 'failed', conflict: true });

    expect(conflicted.status).toBe('conflict');
    expect(conflicted.pending).toEqual({ subject: 'second' });
    expect(conflicted.inFlight).toBeNull();
  });

  it('resolves a conflict either way', () => {
    const server: Draft = { id: 't1', subject: 'server wins', draftRevision: 9 };
    const conflicted = autosaveReducer(
      autosaveReducer(autosaveReducer(initial(), { type: 'change', patch: { subject: 'mine' } }), { type: 'start' }),
      { type: 'failed', conflict: true },
    );

    const takeServer = autosaveReducer(conflicted, { type: 'resolveConflict', serverDraft: server, keepLocal: false });
    expect(takeServer.draft.subject).toBe('server wins');
    expect(takeServer.pending).toBeNull();
    expect(takeServer.status).toBe('saved');

    const keepMine = autosaveReducer(conflicted, { type: 'resolveConflict', serverDraft: server, keepLocal: true });
    expect(keepMine.draft.subject).toBe('mine');
    expect(keepMine.draft.draftRevision).toBe(9);
    expect(keepMine.status).toBe('idle');
  });

  // A save that fails for a reason other than a conflict used to drop the
  // in-flight patch entirely: the value stayed in `draft` but was never sent
  // again, so one network blip silently lost whatever field was in flight
  // until the user happened to retype that exact field.
  it('requeues the in-flight patch when a save fails without a conflict', () => {
    const started = autosaveReducer(
      autosaveReducer(initial(), { type: 'change', patch: { subject: 'second' } }),
      { type: 'start' },
    );
    const failed = autosaveReducer(started, { type: 'failed', conflict: false });

    expect(failed.status).toBe('error');
    expect(failed.pending).toEqual({ subject: 'second' });
    expect(failed.inFlight).toBeNull();
  });

  it('lets a newer edit win over a requeued failed patch', () => {
    const started = autosaveReducer(
      autosaveReducer(initial(), { type: 'change', patch: { subject: 'second' } }),
      { type: 'start' },
    );
    const typedAgain = autosaveReducer(started, { type: 'change', patch: { subject: 'third' } });
    const failed = autosaveReducer(typedAgain, { type: 'failed', conflict: false });

    expect(failed.pending).toEqual({ subject: 'third' });
    expect(failed.status).toBe('error');
  });
});
