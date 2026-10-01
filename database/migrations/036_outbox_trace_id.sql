-- BR-SEND-013 / ADR-017: propagate correlation across the API -> outbox -> job boundary.
-- Nullable with no default keeps older running processes compatible during rollout.
ALTER TABLE outbox_event ADD COLUMN IF NOT EXISTS trace_id text;

CREATE INDEX IF NOT EXISTS idx_outbox_event_trace
  ON outbox_event (trace_id)
  WHERE trace_id IS NOT NULL;
