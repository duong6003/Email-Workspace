-- M6-S4 -- BR-HIS-006's tenant-configurable retention policy and the
-- audited purge of detailed message events (DEC-140/141/142).
--
-- Only message_attempt and delivery_event are ever deleted here. campaign,
-- campaign_execution, campaign_snapshot and campaign_recipient are never
-- touched, which is what keeps "campaign summary giu toi thieu 24 thang"
-- true by construction and what keeps the stored 028 progress summary --
-- the only thing the history report reads (D-130) -- unchanged by a purge.

-- ---------------------------------------------------------------------------
-- (1) The per-tenant policy row (DEC-141). Absent row means "use the
-- deployment default" (HISTORY_EVENT_RETENTION_DAYS). The 30..3650 bound
-- mirrors the floor purge_message_events() enforces below, so the table,
-- the API's Zod schema and the purge function cannot disagree.
-- ---------------------------------------------------------------------------
CREATE TABLE retention_policy (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL UNIQUE REFERENCES tenant(id),
  message_event_retention_days integer NOT NULL,
  updated_by uuid REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT retention_policy_days_bounded
    CHECK (message_event_retention_days BETWEEN 30 AND 3650)
);

GRANT SELECT, INSERT, UPDATE ON TABLE retention_policy TO eow_app;
ALTER TABLE retention_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE retention_policy FORCE ROW LEVEL SECURITY;
CREATE POLICY retention_policy_tenant_isolation ON retention_policy
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

-- ---------------------------------------------------------------------------
-- (2) Supporting indexes for the two time-bounded scans below. Neither
-- table had a (tenant_id, <own clock column>) index before this: 026's
-- message_attempt indexes lead with (tenant_id, execution_id, ...), 027's
-- delivery_event with (tenant_id, campaign_recipient_id, occurred_at).
-- delivery_event is aged by received_at (this system's own ingest clock),
-- not occurred_at (provider-supplied and can be skewed/backdated) --
-- retention is a fact about our own storage, not a third party's clock.
-- ---------------------------------------------------------------------------
CREATE INDEX idx_message_attempt_tenant_attempted ON message_attempt (tenant_id, attempted_at);
CREATE INDEX idx_delivery_event_tenant_received ON delivery_event (tenant_id, received_at);

-- ---------------------------------------------------------------------------
-- (3) The cross-tenant scan (DEC-140). Same narrow SECURITY DEFINER shape
-- as 013/025/026/027/028/029: a fixed query returning only what the caller
-- needs, so eow_app stays NOBYPASSRLS and gains no DELETE grant on either
-- ledger. Oldest-first on purpose, and the opposite of D-127's bug rather
-- than a repeat of it: this scan's own caller *deletes* the rows it
-- ordered by, so a tenant cannot be starved -- each run drains the oldest
-- data and the next run sees a different head. D-127's scan re-listed the
-- same aged rows forever because reconciliation never deleted anything.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION purgeable_retention_tenants(p_default_days integer, p_limit integer)
RETURNS TABLE (tenant_id uuid, retention_days integer, from_policy boolean, oldest_event_at timestamptz)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH effective AS (
    SELECT t.id AS tenant_id,
           GREATEST(COALESCE(rp.message_event_retention_days, p_default_days), 30)::integer AS retention_days,
           (rp.message_event_retention_days IS NOT NULL) AS from_policy
    FROM tenant t
    LEFT JOIN retention_policy rp ON rp.tenant_id = t.id
  ),
  oldest AS (
    SELECT e.tenant_id, e.retention_days, e.from_policy,
           LEAST(
             (SELECT min(ma.attempted_at) FROM message_attempt ma WHERE ma.tenant_id = e.tenant_id),
             (SELECT min(de.received_at) FROM delivery_event de WHERE de.tenant_id = e.tenant_id)
           ) AS oldest_event_at
    FROM effective e
  )
  SELECT oldest.tenant_id, oldest.retention_days, oldest.from_policy, oldest.oldest_event_at
  FROM oldest
  WHERE oldest.oldest_event_at IS NOT NULL
    AND oldest.oldest_event_at < now() - make_interval(days => oldest.retention_days)
  ORDER BY oldest.oldest_event_at
  LIMIT LEAST(GREATEST(p_limit, 1), 1000)
$$;
REVOKE ALL ON FUNCTION purgeable_retention_tenants(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purgeable_retention_tenants(integer, integer) TO eow_app;

-- ---------------------------------------------------------------------------
-- (4) The purge itself (DEC-140). The 30-day floor is enforced here, inside
-- the database function, not only by the caller: a wrong caller --
-- including a future one -- cannot delete recent evidence. Bounded per
-- table per call so a first run over a multi-year backlog is many bounded
-- transactions, not one lock-holding statement; the next tick continues
-- where this one stopped, because the rows it deleted no longer qualify.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION purge_message_events(p_tenant_id uuid, p_cutoff timestamptz, p_limit integer)
RETURNS TABLE (message_attempts_deleted integer, delivery_events_deleted integer, executions_affected integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_limit integer := LEAST(GREATEST(p_limit, 1), 100000);
  v_attempts integer := 0;
  v_events integer := 0;
  v_executions integer := 0;
BEGIN
  IF p_cutoff > now() - interval '30 days' THEN
    RAISE EXCEPTION 'Retention cutoff % is inside the 30-day floor; message events younger than 30 days are never purged', p_cutoff
      USING ERRCODE = '55000';
  END IF;

  WITH doomed AS (
    SELECT ma.id FROM message_attempt ma
    WHERE ma.tenant_id = p_tenant_id AND ma.attempted_at < p_cutoff
    ORDER BY ma.attempted_at
    LIMIT v_limit
  ), removed AS (
    DELETE FROM message_attempt ma USING doomed
    WHERE ma.id = doomed.id
    RETURNING ma.execution_id
  )
  SELECT count(*)::integer, count(DISTINCT removed.execution_id)::integer
    INTO v_attempts, v_executions
  FROM removed;

  WITH doomed AS (
    SELECT de.id FROM delivery_event de
    WHERE de.tenant_id = p_tenant_id AND de.received_at < p_cutoff
    ORDER BY de.received_at
    LIMIT v_limit
  ), removed AS (
    DELETE FROM delivery_event de USING doomed
    WHERE de.id = doomed.id
    RETURNING de.id
  )
  SELECT count(*)::integer INTO v_events FROM removed;

  RETURN QUERY SELECT v_attempts, v_events, v_executions;
END;
$$;
REVOKE ALL ON FUNCTION purge_message_events(uuid, timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_message_events(uuid, timestamptz, integer) TO eow_app;
