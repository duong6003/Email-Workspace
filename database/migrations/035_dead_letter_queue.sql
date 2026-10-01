-- M7-S2 / BR-SEC-007: bounded outbox retries, durable dead-letter storage,
-- admin-only inspection and controlled replay.

ALTER TABLE outbox_event ADD COLUMN IF NOT EXISTS dead_lettered_at timestamptz;
ALTER TABLE outbox_event ADD COLUMN IF NOT EXISTS last_error text;

CREATE TABLE dead_letter_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  source text NOT NULL,
  event_id uuid,
  event_type text NOT NULL,
  aggregate_type text,
  aggregate_id uuid,
  payload jsonb NOT NULL,
  attempts integer NOT NULL,
  last_error text,
  dead_lettered_at timestamptz NOT NULL DEFAULT now(),
  replayed_at timestamptz,
  replay_count integer NOT NULL DEFAULT 0,
  CONSTRAINT dead_letter_event_source_values CHECK (source IN ('outbox', 'job')),
  CONSTRAINT dead_letter_event_attempts_nonnegative CHECK (attempts >= 0),
  CONSTRAINT dead_letter_event_replay_count_nonnegative CHECK (replay_count >= 0),
  CONSTRAINT dead_letter_event_source_event_unique UNIQUE (tenant_id, source, event_id)
);
CREATE INDEX idx_dead_letter_event_tenant_time ON dead_letter_event (tenant_id, dead_lettered_at DESC, id DESC);

GRANT SELECT, INSERT, UPDATE ON TABLE dead_letter_event TO eow_app;
ALTER TABLE dead_letter_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE dead_letter_event FORCE ROW LEVEL SECURITY;
CREATE POLICY dead_letter_event_tenant_isolation ON dead_letter_event
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

CREATE OR REPLACE FUNCTION relay_pending_outbox_events(
  p_event_type text,
  p_aggregate_type text,
  p_limit integer DEFAULT 100
) RETURNS TABLE (id uuid, aggregate_id uuid, tenant_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT event.id, event.aggregate_id, event.tenant_id
  FROM outbox_event AS event
  WHERE event.published_at IS NULL
    AND event.dead_lettered_at IS NULL
    AND event.event_type = p_event_type
    AND event.aggregate_type = p_aggregate_type
  ORDER BY event.occurred_at
  LIMIT LEAST(GREATEST(p_limit, 1), 1000)
$$;

CREATE OR REPLACE FUNCTION relay_record_outbox_failure(
  p_id uuid,
  p_last_error text,
  p_max_attempts integer
) RETURNS TABLE (attempts integer, dead_lettered boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  failed outbox_event%ROWTYPE;
BEGIN
  UPDATE outbox_event
  SET attempts = outbox_event.attempts + 1,
      last_error = left(p_last_error, 4000),
      dead_lettered_at = CASE
        WHEN outbox_event.attempts + 1 >= GREATEST(p_max_attempts, 1) THEN COALESCE(outbox_event.dead_lettered_at, now())
        ELSE outbox_event.dead_lettered_at
      END
  WHERE id = p_id AND published_at IS NULL AND dead_lettered_at IS NULL
  RETURNING * INTO failed;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF failed.dead_lettered_at IS NOT NULL THEN
    INSERT INTO dead_letter_event
      (tenant_id, source, event_id, event_type, aggregate_type, aggregate_id, payload, attempts, last_error, dead_lettered_at)
    VALUES
      (failed.tenant_id, 'outbox', failed.id, failed.event_type, failed.aggregate_type,
       failed.aggregate_id, failed.payload, failed.attempts, failed.last_error, failed.dead_lettered_at)
    ON CONFLICT (tenant_id, source, event_id) DO UPDATE
      SET attempts = GREATEST(dead_letter_event.attempts, EXCLUDED.attempts),
          last_error = EXCLUDED.last_error;
  END IF;

  RETURN QUERY SELECT failed.attempts, failed.dead_lettered_at IS NOT NULL;
END
$$;

REVOKE ALL ON FUNCTION relay_record_outbox_failure(uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION relay_record_outbox_failure(uuid, text, integer) TO eow_app;

INSERT INTO permission (key, description) VALUES
  ('dlq:manage', 'Inspect and replay dead-lettered internal events')
ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permission (role_id, permission_id)
SELECT role.id, permission.id FROM role, permission
WHERE role.key = 'admin' AND permission.key = 'dlq:manage'
ON CONFLICT DO NOTHING;
