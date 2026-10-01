-- Narrow cross-tenant outbox relay API.
-- The worker remains eow_app/NOBYPASSRLS and can only list pending rows plus
-- acknowledge or increment attempts through these fixed SECURITY DEFINER
-- functions. It never receives table-wide owner credentials.

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
    AND event.event_type = p_event_type
    AND event.aggregate_type = p_aggregate_type
  ORDER BY event.occurred_at
  LIMIT LEAST(GREATEST(p_limit, 1), 1000)
$$;

CREATE OR REPLACE FUNCTION relay_mark_outbox_published(p_id uuid) RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH updated AS (
    UPDATE outbox_event
    SET published_at = now(), attempts = attempts + 1
    WHERE id = p_id AND published_at IS NULL
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM updated)
$$;

CREATE OR REPLACE FUNCTION relay_mark_outbox_attempt(p_id uuid) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE outbox_event SET attempts = attempts + 1 WHERE id = p_id
$$;

REVOKE ALL ON FUNCTION relay_pending_outbox_events(text, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION relay_mark_outbox_published(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION relay_mark_outbox_attempt(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION relay_pending_outbox_events(text, text, integer) TO eow_app;
GRANT EXECUTE ON FUNCTION relay_mark_outbox_published(uuid) TO eow_app;
GRANT EXECUTE ON FUNCTION relay_mark_outbox_attempt(uuid) TO eow_app;
