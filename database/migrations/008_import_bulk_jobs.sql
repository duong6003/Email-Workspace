-- Forward migration for M2-S4 (Import and bulk update). Never edits 001-007.
--
-- BR-IMP-001..007 (XLSX import) and BR-CF-004..008 / BR-REC-009 (bulk
-- tag/list/custom-data update) both need an async-job record a client can
-- poll, plus a per-row/per-recipient checkpoint table so a crashed worker
-- can resume without double-processing or losing progress (this is the
-- first node with real background job processing -- see ADR-008/ADR-012
-- and apps/worker's previously-stub main.ts).
--
-- Checkpointing design (shared by both job kinds): each unit of work (one
-- import row / one bulk-selected recipient) is its own row in a *_row table
-- with a `status` state machine (pending -> processing -> succeeded|failed
-- |skipped). The worker claims a batch with
--   UPDATE ... WHERE status = 'pending' ... FOR UPDATE SKIP LOCKED
-- (see apps/worker/src/claim.ts), so state lives in Postgres, not in the
-- BullMQ job's in-memory loop -- a worker process killed mid-batch leaves
-- some rows 'processing' with a claimed_at timestamp; a stale-claim sweep
-- (claimed_at older than the reclaim threshold) returns them to 'pending'
-- so the next worker attempt (BullMQ redelivery or a manual restart) picks
-- up exactly the unfinished rows, never the already-terminal ones. This is
-- what the recovery tests (duplicate-job, worker-crash-mid-batch) exercise
-- against real Postgres/Redis.
--
-- BR-GEN-005 (Idempotency-Key on send/import/bulk-update jobs): reuses the
-- existing idempotency_key table from 002_identity_and_audit.sql
-- (tenant_id, key, request_hash, resource_type, resource_id, response_json,
-- expires_at) rather than inventing a parallel mechanism -- this is the
-- first node with a real qualifying endpoint (import/bulk-update job
-- creation), closing the rule for real per DEC-027/DEC-034.

CREATE TABLE import_job (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'partial_success', 'failed')),
  -- BR-IMP-004: create_only | update_existing | upsert, matched on normalized email.
  mode text NOT NULL DEFAULT 'upsert'
    CHECK (mode IN ('create_only', 'update_existing', 'upsert')),
  file_name text NOT NULL,
  total_rows integer NOT NULL DEFAULT 0,
  processed_rows integer NOT NULL DEFAULT 0,
  succeeded_rows integer NOT NULL DEFAULT 0,
  failed_rows integer NOT NULL DEFAULT 0,
  skipped_rows integer NOT NULL DEFAULT 0,
  error_summary jsonb,
  idempotency_key text,
  created_by uuid REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  last_progress_emitted_at timestamptz
);
CREATE INDEX idx_import_job_tenant_created ON import_job (tenant_id, created_at DESC);

CREATE TABLE import_job_row (
  id bigserial PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES import_job(id) ON DELETE CASCADE,
  row_number integer NOT NULL,
  raw_data jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'succeeded', 'failed', 'skipped')),
  error text,
  recipient_id uuid,
  outcome text CHECK (outcome IN ('created', 'updated', 'skipped')),
  claimed_at timestamptz,
  processed_at timestamptz,
  UNIQUE (job_id, row_number)
);
-- BR-IMP-007 (per-row atomicity) / crash recovery: the worker claims the
-- next pending batch and sweeps stale 'processing' claims via this index.
CREATE INDEX idx_import_job_row_claim ON import_job_row (job_id, status, row_number);

CREATE TABLE bulk_job (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'partial_success', 'failed')),
  -- BR-REC-009 / BR-CF-004: add_tag | remove_tag | add_list | remove_list | set_custom_data
  action text NOT NULL
    CHECK (action IN ('add_tag', 'remove_tag', 'add_list', 'remove_list', 'set_custom_data')),
  action_payload jsonb NOT NULL,
  -- BR-CF-005: the resolved recipient id list is snapshotted at
  -- confirmation time and frozen here; resolved_count is that snapshot's
  -- length. processed_rows (via bulk_job_row) can never exceed it, even if
  -- the underlying filter/segment would match more recipients later.
  selection_snapshot jsonb NOT NULL,
  resolved_count integer NOT NULL,
  processed_rows integer NOT NULL DEFAULT 0,
  succeeded_rows integer NOT NULL DEFAULT 0,
  failed_rows integer NOT NULL DEFAULT 0,
  skipped_rows integer NOT NULL DEFAULT 0,
  idempotency_key text,
  created_by uuid REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  last_progress_emitted_at timestamptz
);
CREATE INDEX idx_bulk_job_tenant_created ON bulk_job (tenant_id, created_at DESC);

CREATE TABLE bulk_job_row (
  id bigserial PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES bulk_job(id) ON DELETE CASCADE,
  recipient_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'succeeded', 'failed', 'skipped')),
  error text,
  claimed_at timestamptz,
  processed_at timestamptz,
  UNIQUE (job_id, recipient_id)
);
CREATE INDEX idx_bulk_job_row_claim ON bulk_job_row (job_id, status, recipient_id);
