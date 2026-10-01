import { useEffect, useState } from 'react';
import { socket } from './realtime.js';

export type RealtimeStatus = 'live' | 'reconnecting' | 'offline';

export function connectionStatus(socketConnected: boolean, browserOnline: boolean): RealtimeStatus {
  if (!browserOnline) return 'offline';
  return socketConnected ? 'live' : 'reconnecting';
}

/**
 * 15s while the socket is live is a cheap safety net against a missed
 * event, not the primary channel -- the socket still satisfies BR-SEND-004's
 * p95-under-5-seconds latency. 3s while not live is the unchanged pre-M6-S1
 * fallback (BR-SEND-004's own "polling fallback" half).
 */
export function pollIntervalMs(status: RealtimeStatus): number {
  return status === 'live' ? 15_000 : 3_000;
}

/**
 * Maps the shared socket's own connection lifecycle to a display status.
 * Untested directly (no @testing-library/react in this repo -- every
 * existing hook, e.g. use-theme.ts, follows the same pattern of keeping
 * hook wiring thin and pushing testable logic into a pure function
 * alongside it); the reconnecting state itself is verified visually
 * (CP12's evidence capture) and via E2E (TC-SEND-016).
 */
export function useRealtimeStatus(): RealtimeStatus {
  const browserOnline = () => typeof navigator === 'undefined' || navigator.onLine;
  const [status, setStatus] = useState<RealtimeStatus>(() => connectionStatus(socket.connected, browserOnline()));

  useEffect(() => {
    const handleConnect = () => setStatus('live');
    const handleDisconnect = () => setStatus(connectionStatus(false, browserOnline()));
    const handleOffline = () => setStatus('offline');
    const handleOnline = () => setStatus(connectionStatus(socket.connected, true));
    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    socket.on('connect_error', handleDisconnect);
    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);
    return () => {
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      socket.off('connect_error', handleDisconnect);
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
    };
  }, []);

  return status;
}

/**
 * BR-NOT-012: after a reconnect the REST unread list is authoritative and fills
 * whatever the socket missed while it was down. Only the down->live edge needs a
 * refetch: staying live means the socket is already the channel, going down
 * means there is nothing to fill in yet, and a null previous status is first
 * mount, whose own initial load already ran.
 */
export function shouldRefetchOnReconnect(previous: RealtimeStatus | null, next: RealtimeStatus): boolean {
  return next === 'live' && previous !== null && previous !== 'live';
}
