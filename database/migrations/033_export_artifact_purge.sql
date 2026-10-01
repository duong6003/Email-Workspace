-- D-131 (found while scoping BR-HIS-006 against export_job's own lifecycle,
-- not part of that rule): migration 029's export_job.expires_at already
-- gates *download* (downloadCampaignExport refuses a download past expiry),
-- but nothing ever cleared artifact_bytes once an export passed its own
-- expiry -- completed export CSVs (bytea) accumulated in PostgreSQL
-- indefinitely. Driven by EXPORT_ARTIFACT_TTL_HOURS, not by any tenant's
-- message-event retention policy (HISTORY_EVENT_RETENTION_DAYS/BR-HIS-006),
-- so this is deliberately a separate scan over a separate column, not a
-- fold-in of the two.
--
-- The row itself (status, row_count, filename, timestamps) is kept for
-- audit/history -- only artifact_bytes is cleared. export_job already has
-- GRANT UPDATE for eow_app (029) and its own RLS tenant-isolation policy, so
-- the clearing UPDATE runs as an ordinary tenant-scoped statement inside
-- runInTenantTransaction, the notifications.service.ts purgeExpired() shape
-- -- unlike BR-HIS-006's append-only ledger purge, export_job is not
-- append-only, so there's no reason to avoid a plain UPDATE here.
--
-- Only the cross-tenant scan needs its own privilege boundary: the same
-- narrow SECURITY DEFINER shape as 013/025/026/027/028/029/032's own scans,
-- a fixed query returning only the ids the caller needs so eow_app stays
-- NOBYPASSRLS and gains no cross-tenant SELECT.
--
-- 029's own export_job_completed_has_artifact CHECK required artifact_bytes
-- IS NOT NULL for every 'completed' row -- correct for the row a running
-- export just finished writing, but it forbids exactly the state this purge
-- needs to leave behind (status still 'completed', artifact cleared). A
-- forward migration relaxes it rather than editing 029: filename and
-- expires_at stay required (a completed job always finished with a real
-- artifact at some point), only the bytea payload's presence is no longer
-- constrained.
ALTER TABLE export_job DROP CONSTRAINT export_job_completed_has_artifact;
ALTER TABLE export_job ADD CONSTRAINT export_job_completed_has_artifact CHECK (
  status <> 'completed'
  OR (artifact_filename IS NOT NULL AND expires_at IS NOT NULL)
);

CREATE OR REPLACE FUNCTION expired_export_artifacts(p_limit integer)
RETURNS TABLE (id uuid, tenant_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT export_job.id, export_job.tenant_id
  FROM export_job
  WHERE export_job.status = 'completed'
    AND export_job.artifact_bytes IS NOT NULL
    AND export_job.expires_at IS NOT NULL
    AND export_job.expires_at < now()
  ORDER BY export_job.expires_at
  LIMIT LEAST(GREATEST(p_limit, 1), 1000)
$$;
REVOKE ALL ON FUNCTION expired_export_artifacts(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION expired_export_artifacts(integer) TO eow_app;
