# Realtime and notification contract

Realtime covers campaign progress, notification creation/read sync, import/export, bulk
update, validation, sender/quota health and reconnect readiness. Events are server-originated,
versioned, tenant-authorized and deduplicated by `event_id`.

The notification center persists actionable business events and read state. Toasts only
confirm the current interaction. Socket delivery may be missed; reconnect always performs
REST reconciliation using the last known version/cursor.

Progress publication is throttled to no more than once per second or per 250 recipients,
whichever is less noisy. Counters are monotonic and computed from canonical delivery facts.
A completed campaign event is never accepted by the UI until REST state agrees.
