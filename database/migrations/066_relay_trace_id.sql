-- 066_relay_trace_id.sql
-- Review-session integration migration for M7-S3's follow-up 1.
--
-- BR-SEND-013 / ADR-017 require the correlation id to survive the
-- API -> outbox -> job hop. Migration 036 added outbox_event.trace_id, but
-- relay_pending_outbox_events() is the only way the worker reads that table
-- and migration 035 (M7-S2) had already replaced it with a three-column
-- return shape that predates the column. Neither node could fix this: 035 is
-- published and immutable (AGENTS.md 5), and outbox-relay.ts belonged to
-- M7-S2 while the trace work belonged to M7-S3.
--
-- CREATE OR REPLACE on this locked function is the established precedent in
-- this repository (023, 030, 031 and 035 all do exactly that). 066 is the
-- number PARALLEL-EXECUTION-PROTOCOL-M7 3.1 reserved for M7-S3's second
-- migration (NNN+30), used here for the integration it deferred.
--
-- The three original columns keep their names, order and types, so a caller
-- selecting just those is unaffected.
--
-- DROP before CREATE is required, not stylistic: PostgreSQL refuses
-- CREATE OR REPLACE FUNCTION when the return type changes ("cannot change
-- return type of existing function"), which is exactly what adding a column
-- to a RETURNS TABLE does. The whole file runs inside migrate.sh's single
-- transaction, so the drop and the recreate are atomic and no concurrent
-- relay run can observe the function missing.

DROP FUNCTION IF EXISTS relay_pending_outbox_events(text, text, integer);

CREATE FUNCTION relay_pending_outbox_events(
  p_event_type text,
  p_aggregate_type text,
  p_limit integer DEFAULT 100
) RETURNS TABLE (id uuid, aggregate_id uuid, tenant_id uuid, trace_id text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT event.id, event.aggregate_id, event.tenant_id, event.trace_id
  FROM outbox_event AS event
  WHERE event.published_at IS NULL
    AND event.dead_lettered_at IS NULL
    AND event.event_type = p_event_type
    AND event.aggregate_type = p_aggregate_type
  ORDER BY event.occurred_at
  LIMIT LEAST(GREATEST(p_limit, 1), 1000)
$$;
