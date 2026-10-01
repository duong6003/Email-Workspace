-- M6-S3 -- resend lineage, background export artifacts and the export
-- permission (BR-HIS-005, BR-HIS-003, BR-HIS-007, ADR-027).

-- ---------------------------------------------------------------------------
-- (1) BR-HIS-005's "retry tao execution moi co lien ket parent". Nullable:
-- every execution that exists today is a root. The snapshot lineage is
-- carried too, because DEC-133 makes a resend a *new snapshot* -- without
-- parent_snapshot_id the superseded parent snapshot and its child are
-- related only by timestamp, which is not a key.
-- ---------------------------------------------------------------------------
ALTER TABLE campaign_execution
  ADD COLUMN IF NOT EXISTS parent_execution_id uuid REFERENCES campaign_execution(id),
  ADD COLUMN IF NOT EXISTS resend_generation integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT campaign_execution_resend_generation_nonnegative
    CHECK (resend_generation >= 0),
  ADD CONSTRAINT campaign_execution_parent_is_not_self
    CHECK (parent_execution_id IS NULL OR parent_execution_id <> id);

ALTER TABLE campaign_snapshot
  ADD COLUMN IF NOT EXISTS parent_snapshot_id uuid REFERENCES campaign_snapshot(id);

CREATE INDEX IF NOT EXISTS idx_campaign_execution_parent
  ON campaign_execution (tenant_id, parent_execution_id)
  WHERE parent_execution_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- (2) BR-HIS-003/BR-HIS-007's background export. Modelled on bulk_job
-- (008_import_bulk_jobs.sql:74) -- same status vocabulary shape, same
-- created_by/created_at/completed_at spine. artifact_bytes holds the rendered
-- CSV: DEC-134 -- there is no file storage in this system and adding a volume
-- for a P1 rule would change the one-command deployment contract.
-- ---------------------------------------------------------------------------
CREATE TABLE export_job (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  campaign_id uuid NOT NULL REFERENCES campaign(id),
  execution_id uuid REFERENCES campaign_execution(id),
  kind text NOT NULL CHECK (kind IN ('campaign_recipients', 'campaign_failures')),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  status_filter text[] NOT NULL DEFAULT '{}',
  row_count integer NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  artifact_bytes bytea,
  artifact_filename text,
  failure_code text,
  expires_at timestamptz,
  downloaded_count integer NOT NULL DEFAULT 0 CHECK (downloaded_count >= 0),
  created_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  CONSTRAINT export_job_completed_has_artifact CHECK (
    status <> 'completed'
    OR (artifact_bytes IS NOT NULL AND artifact_filename IS NOT NULL AND expires_at IS NOT NULL)
  )
);
CREATE INDEX idx_export_job_tenant_created ON export_job (tenant_id, created_at DESC);
CREATE INDEX idx_export_job_campaign ON export_job (tenant_id, campaign_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE ON TABLE export_job TO eow_app;
ALTER TABLE export_job ENABLE ROW LEVEL SECURITY;
ALTER TABLE export_job FORCE ROW LEVEL SECURITY;
CREATE POLICY export_job_tenant_isolation ON export_job
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

-- The worker's narrow cross-tenant boundary, in the exact shape 013/025/026/028
-- already established: a fixed SECURITY DEFINER query returning only the ids the
-- caller needs, so eow_app stays NOBYPASSRLS.
CREATE OR REPLACE FUNCTION queued_export_jobs(p_limit integer)
RETURNS TABLE (id uuid, tenant_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT export_job.id, export_job.tenant_id
  FROM export_job
  WHERE export_job.status = 'queued'
  ORDER BY export_job.created_at
  LIMIT LEAST(GREATEST(p_limit, 1), 1000)
$$;
REVOKE ALL ON FUNCTION queued_export_jobs(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION queued_export_jobs(integer) TO eow_app;

-- ---------------------------------------------------------------------------
-- (3) BR-HIS-007's "Viewer khong duoc export neu thieu quyen". DEC-135: no
-- existing key carries this distinction, and 004_rbac.sql's admin grant was an
-- unfiltered cross join executed once at seed time -- admin does NOT inherit a
-- later key, so it is granted explicitly here alongside operator.
-- ---------------------------------------------------------------------------
INSERT INTO permission (key, description) VALUES
  ('history:export', 'Export send history and recipient-level results')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permission (role_id, permission_id)
SELECT r.id, p.id FROM role r, permission p
WHERE r.key IN ('admin', 'operator') AND p.key = 'history:export'
ON CONFLICT DO NOTHING;
