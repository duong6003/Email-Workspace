# ADR-009: Realtime transport

Status: Accepted

## Decision

Socket.IO through Nest gateway with Redis adapter; versioned server-originated events.

## Rationale

The product needs rooms, reconnect and acknowledgements for notification and progress streams.

## Alternatives

SSE; native WebSocket; managed Ably
