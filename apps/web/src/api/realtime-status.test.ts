import { describe, expect, it } from 'vitest';
import { connectionStatus, pollIntervalMs, shouldRefetchOnReconnect, type RealtimeStatus } from './realtime-status.js';

describe('connectionStatus (GAP-UX-001 browser and socket state)', () => {
  it('reports offline whenever the browser has no network', () => {
    expect(connectionStatus(true, false)).toBe('offline');
    expect(connectionStatus(false, false)).toBe('offline');
  });

  it('distinguishes a live socket from an online browser that is reconnecting', () => {
    expect(connectionStatus(true, true)).toBe('live');
    expect(connectionStatus(false, true)).toBe('reconnecting');
  });
});

describe('pollIntervalMs (SendingBanner cadence while a socket may or may not be live)', () => {
  it('is 3s while not live -- unchanged from the pre-realtime behaviour', () => {
    const statuses: RealtimeStatus[] = ['reconnecting', 'offline'];
    for (const status of statuses) expect(pollIntervalMs(status)).toBe(3_000);
  });

  it('is 15s while live -- a cheap safety net against a missed socket event, not the primary channel', () => {
    expect(pollIntervalMs('live')).toBe(15_000);
  });
});

describe('shouldRefetchOnReconnect (BR-NOT-012: the unread API is authoritative after a reconnect)', () => {
  it('refetches when the socket comes back after a drop', () => {
    expect(shouldRefetchOnReconnect('reconnecting', 'live')).toBe(true);
    expect(shouldRefetchOnReconnect('offline', 'live')).toBe(true);
  });

  it('does not refetch while the socket stays live -- the socket itself is the channel', () => {
    expect(shouldRefetchOnReconnect('live', 'live')).toBe(false);
  });

  it('does not refetch on the way down -- there is nothing to fill in yet', () => {
    expect(shouldRefetchOnReconnect('live', 'reconnecting')).toBe(false);
    expect(shouldRefetchOnReconnect('reconnecting', 'offline')).toBe(false);
  });

  it('does not refetch on first mount, when there is no previous status', () => {
    expect(shouldRefetchOnReconnect(null, 'live')).toBe(false);
  });
});
