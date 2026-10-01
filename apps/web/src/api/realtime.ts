import { io } from 'socket.io-client';

/**
 * `transports` is socket.io's own default order, restored deliberately.
 *
 * Long-polling is a plain request/response exchange that survives any proxy.
 * WebSocket is not: its handshake needs `Upgrade`/`Connection` headers, which
 * RFC 7230 classifies as hop-by-hop and proxies therefore strip unless told
 * otherwise, and it needs HTTP/1.1 -- nginx's `proxy_pass` speaks HTTP/1.0
 * until `proxy_http_version 1.1` is set. Connecting on polling first and
 * letting engine.io upgrade in the background means a proxy that blocks the
 * upgrade costs efficiency instead of the whole realtime channel.
 *
 * Listing websocket first inverted that: behind a reverse proxy forwarding
 * HTTP/1.0, every handshake was answered 400 and the client retried the same
 * failing transport every five seconds without ever falling back, so the app
 * sat on its 3s polling fallback under a permanent "Đang kết nối lại…" banner.
 * If the proxy is fixed later, the upgrade simply starts succeeding again --
 * no code change needed.
 */
export const socket = io(`${import.meta.env.VITE_SOCKET_URL ?? 'http://localhost:3000'}/realtime`, {
  autoConnect: false, withCredentials: true, transports: ['polling', 'websocket'],
});

// Dev-only escape hatch for forcing a deterministic disconnect in visual
// evidence capture (TC-SEND-016's reconnecting state) -- tree-shaken out of
// the production bundle by import.meta.env.DEV, never present outside a
// local/dev server. Also guarded on `window` existing: vitest runs this
// module under Node, with no global window at all.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as { __eowSocket?: typeof socket }).__eowSocket = socket;
}

export function subscribeToJobs(jobIds: string[]): void {
  socket.auth = { jobIds };
  if (!socket.connected) socket.connect();
}

/**
 * M6-S1 CP10. Merges into any existing auth payload (job subscriptions set
 * by subscribeToJobs) rather than overwriting it, so a client watching both
 * a job and a campaign at once keeps both -- socket.auth is one shared
 * handshake payload for the whole connection, not per-subscription state.
 */
export function subscribeToCampaigns(campaignIds: string[]): void {
  socket.auth = { ...(socket.auth as Record<string, unknown>), campaignIds };
  if (!socket.connected) socket.connect();
}

export function subscribeToNotifications(): void {
  if (!socket.connected) socket.connect();
}
