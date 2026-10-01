-- M5-S3 -- the send pipeline's own state. EXECPLAN SS10 reserved
-- campaign_executions/message_attempts for this node; both are named in the
-- singular here to match every other table in this schema (campaign,
-- campaign_snapshot, campaign_recipient, sender_config, outbox_event).

-- ---------------------------------------------------------------------------
-- (1) BR-SEND-002's vocabulary. D-88: the column has had no CHECK since 001 and
-- M4-S4's freeze wrote 'queued' even for skipped rows, so the rule's own
-- "counts sum to total_snapshot" was true only by collapsing two facts into one
-- value. Backfill first, constrain second.
-- ---------------------------------------------------------------------------
UPDATE campaign_recipient SET status = 'skipped' WHERE eligibility = 'skipped';
UPDATE campaign_recipient SET status = 'pending'
  WHERE eligibility = 'sendable' AND status = 'queued';

ALTER TABLE campaign_recipient
  ADD CONSTRAINT campaign_recipient_status_known CHECK (status IN (
    'pending', 'queued', 'submitted', 'delivered', 'bounced', 'failed', 'skipped', 'cancelled'
  )),
  ADD CONSTRAINT campaign_recipient_skipped_status_agrees CHECK (
    (eligibility = 'skipped' AND status = 'skipped')
    OR (eligibility = 'sendable' AND status <> 'skipped')
  );

ALTER TABLE campaign_recipient
  ADD COLUMN IF NOT EXISTS execution_id uuid,
  ADD COLUMN IF NOT EXISTS batch_no integer,
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_retry_at timestamptz,
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS content_hash text,
  ADD CONSTRAINT campaign_recipient_attempt_count_nonnegative
    CHECK (attempt_count >= 0);

-- The partition/send claim's index. Partial: only rows still owed work.
CREATE INDEX IF NOT EXISTS idx_campaign_recipient_sendable_pending
  ON campaign_recipient (tenant_id, campaign_id, id)
  WHERE eligibility = 'sendable' AND status = 'pending';
CREATE INDEX IF NOT EXISTS idx_campaign_recipient_retry_due
  ON campaign_recipient (next_retry_at)
  WHERE status = 'queued';

-- ---------------------------------------------------------------------------
-- (2) The execution. One row per (campaign, snapshot) -- the unique index IS
-- the DAG's idempotency key (SS3.3, A5): re-running `freeze` for the same
-- snapshot cannot create a second execution, so no distributed lock is needed.
-- ---------------------------------------------------------------------------
CREATE TABLE campaign_execution (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  campaign_id uuid NOT NULL REFERENCES campaign(id),
  snapshot_id uuid NOT NULL REFERENCES campaign_snapshot(id),
  status text NOT NULL DEFAULT 'validating' CHECK (status IN (
    'validating', 'sending', 'paused', 'completed', 'partial_failed', 'failed', 'cancelled'
  )),
  correlation_id text NOT NULL,
  batch_size integer NOT NULL DEFAULT 100 CHECK (batch_size BETWEEN 1 AND 5000),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  sender_config_id uuid REFERENCES sender_config(id),
  failure_code text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (campaign_id, snapshot_id)
);
CREATE INDEX idx_campaign_execution_active
  ON campaign_execution (tenant_id, status, started_at DESC);

-- ---------------------------------------------------------------------------
-- (3) BR-SEND-006's "every attempt has a provider response and next_retry_at".
-- One row per attempt, never updated -- an append-only attempt log is what makes
-- "no duplicate counting" (BR-SEND-002) checkable rather than asserted.
-- ---------------------------------------------------------------------------
CREATE TABLE message_attempt (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  execution_id uuid NOT NULL REFERENCES campaign_execution(id),
  campaign_recipient_id uuid NOT NULL REFERENCES campaign_recipient(id),
  attempt_no integer NOT NULL CHECK (attempt_no >= 1),
  outcome text NOT NULL CHECK (outcome IN ('submitted', 'transient_error', 'permanent_error')),
  provider_message_id text,
  error_code text,
  error_class text CHECK (error_class IN ('transient', 'permanent', 'auth', 'config')),
  provider_response text,
  retry_after_seconds integer CHECK (retry_after_seconds IS NULL OR retry_after_seconds >= 0),
  next_retry_at timestamptz,
  content_hash text NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_recipient_id, attempt_no)
);
CREATE INDEX idx_message_attempt_execution ON message_attempt (tenant_id, execution_id, attempted_at);
-- BR-SEND-007's daily ceiling counts submissions, not attempts.
CREATE INDEX idx_message_attempt_daily_rate
  ON message_attempt (tenant_id, execution_id, attempted_at)
  WHERE outcome = 'submitted';

-- ---------------------------------------------------------------------------
-- (4) D-90: the send-shaping fields BR-SEND-007 and BR-CFG-004/005 need and
-- 020 never shipped. Defaults are deliberately conservative -- a tenant that
-- has configured nothing must not be given an unlimited send rate.
-- ---------------------------------------------------------------------------
ALTER TABLE sender_config
  ADD COLUMN IF NOT EXISTS rate_limit_per_minute integer NOT NULL DEFAULT 60,
  ADD COLUMN IF NOT EXISTS daily_send_limit integer,
  ADD CONSTRAINT sender_config_rate_limit_positive CHECK (rate_limit_per_minute > 0),
  ADD CONSTRAINT sender_config_daily_limit_positive
    CHECK (daily_send_limit IS NULL OR daily_send_limit > 0);

ALTER TABLE sending_policy
  ADD COLUMN IF NOT EXISTS batch_size integer NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS max_attempts integer NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS tenant_rate_limit_per_minute integer NOT NULL DEFAULT 600,
  ADD CONSTRAINT sending_policy_batch_size_bounded CHECK (batch_size BETWEEN 1 AND 5000),
  ADD CONSTRAINT sending_policy_max_attempts_bounded CHECK (max_attempts BETWEEN 1 AND 20),
  ADD CONSTRAINT sending_policy_tenant_rate_positive CHECK (tenant_rate_limit_per_minute > 0);

-- ---------------------------------------------------------------------------
-- (5) BR-SEND-011's suppression, on the table that already governs future
-- eligibility. 006 published subscription_status IN
-- ('active','paused','unsubscribed','bounced') and M4-S2's resolver already
-- skips 'bounced' with skipped_reason='status_bounced' -- so suppression needs
-- no new exclusion path, only a durable record of why and when.
-- ---------------------------------------------------------------------------
ALTER TABLE recipient
  ADD COLUMN IF NOT EXISTS suppressed_at timestamptz,
  ADD COLUMN IF NOT EXISTS suppression_reason text,
  ADD CONSTRAINT recipient_suppression_reason_known CHECK (
    suppression_reason IS NULL
    OR suppression_reason IN ('hard_bounce', 'complaint')
  ),
  ADD CONSTRAINT recipient_suppression_complete CHECK (
    (suppressed_at IS NULL AND suppression_reason IS NULL)
    OR (suppressed_at IS NOT NULL AND suppression_reason IS NOT NULL)
  );

-- ---------------------------------------------------------------------------
-- (6) The worker's cross-tenant scan, in the exact narrow shape 013 and 025
-- already established: a fixed SECURITY DEFINER function returning nothing but
-- the two ids the scan needs, so the worker stays eow_app/NOBYPASSRLS.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION queued_campaign_executions(p_limit integer DEFAULT 100)
RETURNS TABLE (id uuid, tenant_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT campaign.id, campaign.tenant_id
  FROM campaign
  WHERE campaign.status IN ('queued', 'validating', 'sending')
    AND campaign.deleted_at IS NULL
  ORDER BY campaign.updated_at
  LIMIT LEAST(GREATEST(p_limit, 1), 1000)
$$;
REVOKE ALL ON FUNCTION queued_campaign_executions(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION queued_campaign_executions(integer) TO eow_app;

GRANT SELECT, INSERT, UPDATE ON TABLE campaign_execution TO eow_app;
GRANT SELECT, INSERT ON TABLE message_attempt TO eow_app;
ALTER TABLE campaign_execution ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_execution FORCE ROW LEVEL SECURITY;
CREATE POLICY campaign_execution_tenant_isolation ON campaign_execution
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
ALTER TABLE message_attempt ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_attempt FORCE ROW LEVEL SECURITY;
CREATE POLICY message_attempt_tenant_isolation ON message_attempt
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
