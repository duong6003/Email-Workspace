-- M6-S1 -- denormalised monotonic campaign progress counters and the
-- reconciliation scan (ADR-016, ADR-026, BR-HIS-008). campaign_recipient
-- stays canonical; these columns are a published summary that campaign.progress
-- publishes and that progress-reconcile repairs when it drifts from the facts.

-- ---------------------------------------------------------------------------
-- (1) The stored summary. progress_seq is the monotonic cursor: bumped by
-- exactly one `progress_seq = progress_seq + 1` inside the same UPDATE that
-- writes the counts, never a client-supplied value (D-116). The nine counts
-- are the raw per-status partition, not rollups -- only sent/delivered/failed
-- (computed at read time, D-105) are individually monotonic; the stored
-- counts must stay exact so "counts sum to total_snapshot" (BR-SEND-002)
-- keeps holding after a webhook moves a row out of submitted.
-- ---------------------------------------------------------------------------
ALTER TABLE campaign_execution
  ADD COLUMN IF NOT EXISTS progress_seq      bigint      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pending_count     integer     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS queued_count      integer     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS submitted_count   integer     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS delivered_count   integer     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bounced_count     integer     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS failed_count      integer     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS skipped_count     integer     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cancelled_count   integer     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reconciled_at     timestamptz;

ALTER TABLE campaign_execution DROP CONSTRAINT IF EXISTS campaign_execution_counts_non_negative;
ALTER TABLE campaign_execution
  ADD CONSTRAINT campaign_execution_counts_non_negative CHECK (
    progress_seq >= 0 AND pending_count >= 0 AND queued_count >= 0
    AND submitted_count >= 0 AND delivered_count >= 0 AND bounced_count >= 0
    AND failed_count >= 0 AND skipped_count >= 0 AND cancelled_count >= 0
  );

-- ---------------------------------------------------------------------------
-- (2) The cross-tenant reconciliation scan. Same SECURITY DEFINER shape as
-- 013/025/026/027 -- a fixed query returning only the ids the caller needs,
-- so eow_app stays NOBYPASSRLS and no broad cross-tenant read is granted.
-- The 7-day window bounds the scan; anything older is beyond any provider's
-- retry horizon (ADR-026) and is left to the audit trail.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reconcilable_campaign_executions(p_limit integer)
RETURNS TABLE (id uuid, tenant_id uuid, campaign_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT campaign_execution.id, campaign_execution.tenant_id, campaign_execution.campaign_id
  FROM campaign_execution
  WHERE campaign_execution.status = 'sending'
     OR campaign_execution.finished_at > now() - interval '7 days'
  ORDER BY campaign_execution.started_at
  LIMIT p_limit
$$;
REVOKE ALL ON FUNCTION reconcilable_campaign_executions(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reconcilable_campaign_executions(integer) TO eow_app;
