-- M4-S4 -- campaign snapshot: the frozen send set. Both tables were published by
-- 001_initial.sql with grants (011) and RLS (012) and have never been written to,
-- so added NOT NULL columns need no backfill and no DEFAULT-then-drop dance.

ALTER TABLE campaign_snapshot
  ADD COLUMN IF NOT EXISTS variable_schema_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS total_snapshot integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sendable_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS skipped_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS frozen_by uuid REFERENCES app_user(id),
  ADD COLUMN IF NOT EXISTS superseded_at timestamptz;

-- BR-CMP-007's "refresh yêu cầu hủy và tạo snapshot mới": one *live* snapshot per
-- campaign, but superseded ones are retained as immutable history. 001's blanket
-- UNIQUE(campaign_id) would have made a second snapshot impossible, i.e. would have
-- made the rule's own refresh transition unimplementable.
ALTER TABLE campaign_snapshot DROP CONSTRAINT IF EXISTS campaign_snapshot_campaign_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_campaign_snapshot_live
  ON campaign_snapshot (campaign_id) WHERE superseded_at IS NULL;

ALTER TABLE campaign_recipient
  ADD COLUMN IF NOT EXISTS snapshot_id uuid NOT NULL REFERENCES campaign_snapshot(id),
  ADD COLUMN IF NOT EXISTS email_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS eligibility text NOT NULL DEFAULT 'sendable',
  ADD COLUMN IF NOT EXISTS skipped_reason text;

ALTER TABLE campaign_recipient
  ADD CONSTRAINT campaign_recipient_eligibility_known
    CHECK (eligibility IN ('sendable', 'skipped')),
  ADD CONSTRAINT campaign_recipient_skipped_reason_known
    CHECK (
      (eligibility = 'sendable' AND skipped_reason IS NULL)
      OR (eligibility = 'skipped' AND skipped_reason IN (
        'deleted', 'status_paused', 'status_unsubscribed', 'status_bounced',
        'excluded_by_list', 'excluded_by_tag', 'excluded_by_recipient',
        'missing_required_variable'
      ))
    );

-- Per-snapshot, not per-campaign: a refreshed snapshot re-freezes the same people.
ALTER TABLE campaign_recipient DROP CONSTRAINT IF EXISTS campaign_recipient_campaign_id_recipient_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_campaign_recipient_snapshot
  ON campaign_recipient (snapshot_id, recipient_id);
CREATE INDEX IF NOT EXISTS idx_campaign_recipient_snapshot_eligibility
  ON campaign_recipient (tenant_id, snapshot_id, eligibility);

-- Immutability. 015_template_versions.sql's trigger raises unconditionally
-- (BEFORE UPDATE OR DELETE, body is a bare RAISE) because a published version has
-- no legal mutation at all. A snapshot has exactly one -- superseding -- so this
-- function must inspect OLD/NEW instead of raising blind.
CREATE OR REPLACE FUNCTION campaign_snapshot_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Campaign snapshots are immutable and cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.superseded_at IS NOT NULL OR NEW.superseded_at IS NULL THEN
    RAISE EXCEPTION 'A campaign snapshot may only be superseded once, and nothing else may change'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.campaign_id IS DISTINCT FROM NEW.campaign_id
    OR OLD.template_version_id IS DISTINCT FROM NEW.template_version_id
    OR OLD.sender_json IS DISTINCT FROM NEW.sender_json
    OR OLD.audience_query_json IS DISTINCT FROM NEW.audience_query_json
    OR OLD.policy_result_json IS DISTINCT FROM NEW.policy_result_json
    OR OLD.variable_schema_json IS DISTINCT FROM NEW.variable_schema_json
    OR OLD.total_snapshot IS DISTINCT FROM NEW.total_snapshot
    OR OLD.sendable_count IS DISTINCT FROM NEW.sendable_count
    OR OLD.skipped_count IS DISTINCT FROM NEW.skipped_count
    OR OLD.frozen_at IS DISTINCT FROM NEW.frozen_at THEN
    RAISE EXCEPTION 'Campaign snapshot content is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER campaign_snapshot_immutable_trigger
BEFORE UPDATE OR DELETE ON campaign_snapshot
FOR EACH ROW EXECUTE FUNCTION campaign_snapshot_immutable();

-- campaign_recipient's send-progress columns (status, provider_message_id,
-- last_error_code, updated_at) stay writable -- M5-S3 owns them. Only the frozen
-- half is locked.
CREATE OR REPLACE FUNCTION campaign_recipient_snapshot_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Frozen campaign recipients cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.snapshot_id IS DISTINCT FROM NEW.snapshot_id
    OR OLD.campaign_id IS DISTINCT FROM NEW.campaign_id
    OR OLD.recipient_id IS DISTINCT FROM NEW.recipient_id
    OR OLD.merge_data_json IS DISTINCT FROM NEW.merge_data_json
    OR OLD.email_snapshot IS DISTINCT FROM NEW.email_snapshot
    OR OLD.eligibility IS DISTINCT FROM NEW.eligibility
    OR OLD.skipped_reason IS DISTINCT FROM NEW.skipped_reason THEN
    RAISE EXCEPTION 'Frozen campaign recipient data is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER campaign_recipient_snapshot_immutable_trigger
BEFORE UPDATE OR DELETE ON campaign_recipient
FOR EACH ROW EXECUTE FUNCTION campaign_recipient_snapshot_immutable();

-- BR-CMP-007's other half: 017's campaign_no_edit_after_send() only guards
-- 'sending'/'completed'. A frozen campaign sits in 'queued', which that trigger
-- lets straight through -- so today a PATCH could still rewrite audience_json out
-- from under a snapshot. Extended, not replaced (forward-only: 017 is untouched).
-- 018_campaign_status_values.sql already widened campaign_status_known to admit
-- 'queued'/'validating', so this needs no CHECK-constraint change.
CREATE OR REPLACE FUNCTION campaign_no_edit_after_send()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('queued', 'validating', 'scheduled', 'sending', 'completed')
    AND (
      OLD.name IS DISTINCT FROM NEW.name
      OR OLD.subject IS DISTINCT FROM NEW.subject
      OR OLD.template_id IS DISTINCT FROM NEW.template_id
      OR OLD.template_version_id IS DISTINCT FROM NEW.template_version_id
      OR OLD.sender_json IS DISTINCT FROM NEW.sender_json
      OR OLD.audience_json IS DISTINCT FROM NEW.audience_json
      OR OLD.settings_json IS DISTINCT FROM NEW.settings_json
    ) THEN
    RAISE EXCEPTION 'Campaign content cannot be edited after it has been frozen for sending'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
