-- M4-S4 CP1 hardening. 022_campaign_snapshot.sql is published: fix every
-- discoverable gap forward-only, while retaining existing frozen history.

ALTER TABLE campaign_snapshot
  ALTER COLUMN variable_schema_json SET DEFAULT '{"required":[],"optional":[]}'::jsonb,
  ADD CONSTRAINT campaign_snapshot_counts_valid CHECK (
    total_snapshot >= 0
    AND sendable_count >= 0
    AND skipped_count >= 0
    AND sendable_count + skipped_count = total_snapshot
  );

ALTER TABLE campaign_recipient
  ALTER COLUMN email_snapshot SET DEFAULT '{"subject":"","html":"","textBody":""}'::jsonb,
  DROP CONSTRAINT campaign_recipient_skipped_reason_known,
  ADD CONSTRAINT campaign_recipient_skipped_reason_known CHECK (
    (eligibility = 'sendable' AND skipped_reason IS NULL)
    OR (
      eligibility = 'skipped'
      AND skipped_reason IS NOT NULL
      AND skipped_reason IN (
        'deleted', 'status_paused', 'status_unsubscribed', 'status_bounced',
        'excluded_by_list', 'excluded_by_tag', 'excluded_by_recipient',
        'missing_required_variable'
      )
    )
  );

-- Composite parent keys make tenant-consistent foreign keys possible without
-- weakening global primary keys. campaign_snapshot also needs campaign_id in
-- its parent key so a recipient cannot point at another campaign's snapshot.
ALTER TABLE campaign
  ADD CONSTRAINT campaign_tenant_id_id_key UNIQUE (tenant_id, id);
ALTER TABLE email_template_version
  ADD CONSTRAINT email_template_version_tenant_id_id_key UNIQUE (tenant_id, id);
ALTER TABLE app_user
  ADD CONSTRAINT app_user_tenant_id_id_key UNIQUE (tenant_id, id);
ALTER TABLE recipient
  ADD CONSTRAINT recipient_tenant_id_id_key UNIQUE (tenant_id, id);
ALTER TABLE campaign_snapshot
  ADD CONSTRAINT campaign_snapshot_tenant_campaign_id_id_key UNIQUE (tenant_id, campaign_id, id);

-- Add first without a table scan, validate every composite relationship, then
-- remove legacy singleton FKs. Validation failure leaves old FKs intact.
ALTER TABLE campaign_snapshot
  ADD CONSTRAINT campaign_snapshot_tenant_campaign_fkey
    FOREIGN KEY (tenant_id, campaign_id)
    REFERENCES campaign (tenant_id, id) NOT VALID,
  ADD CONSTRAINT campaign_snapshot_tenant_template_version_fkey
    FOREIGN KEY (tenant_id, template_version_id)
    REFERENCES email_template_version (tenant_id, id) NOT VALID,
  ADD CONSTRAINT campaign_snapshot_tenant_frozen_by_fkey
    FOREIGN KEY (tenant_id, frozen_by)
    REFERENCES app_user (tenant_id, id) NOT VALID;

ALTER TABLE campaign_recipient
  ADD CONSTRAINT campaign_recipient_tenant_campaign_fkey
    FOREIGN KEY (tenant_id, campaign_id)
    REFERENCES campaign (tenant_id, id) NOT VALID,
  ADD CONSTRAINT campaign_recipient_tenant_recipient_fkey
    FOREIGN KEY (tenant_id, recipient_id)
    REFERENCES recipient (tenant_id, id) NOT VALID,
  ADD CONSTRAINT campaign_recipient_tenant_campaign_snapshot_fkey
    FOREIGN KEY (tenant_id, campaign_id, snapshot_id)
    REFERENCES campaign_snapshot (tenant_id, campaign_id, id) NOT VALID;

ALTER TABLE campaign_snapshot
  VALIDATE CONSTRAINT campaign_snapshot_tenant_campaign_fkey,
  VALIDATE CONSTRAINT campaign_snapshot_tenant_template_version_fkey,
  VALIDATE CONSTRAINT campaign_snapshot_tenant_frozen_by_fkey;
ALTER TABLE campaign_recipient
  VALIDATE CONSTRAINT campaign_recipient_tenant_campaign_fkey,
  VALIDATE CONSTRAINT campaign_recipient_tenant_recipient_fkey,
  VALIDATE CONSTRAINT campaign_recipient_tenant_campaign_snapshot_fkey;

ALTER TABLE campaign_snapshot
  DROP CONSTRAINT campaign_snapshot_campaign_id_fkey,
  DROP CONSTRAINT campaign_snapshot_template_version_id_fkey,
  DROP CONSTRAINT campaign_snapshot_frozen_by_fkey;
ALTER TABLE campaign_recipient
  DROP CONSTRAINT campaign_recipient_campaign_id_fkey,
  DROP CONSTRAINT campaign_recipient_recipient_id_fkey,
  DROP CONSTRAINT campaign_recipient_snapshot_id_fkey;

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
  IF OLD.id IS DISTINCT FROM NEW.id
    OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
    OR OLD.campaign_id IS DISTINCT FROM NEW.campaign_id
    OR OLD.template_version_id IS DISTINCT FROM NEW.template_version_id
    OR OLD.frozen_by IS DISTINCT FROM NEW.frozen_by
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

CREATE OR REPLACE FUNCTION campaign_recipient_snapshot_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Frozen campaign recipients cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.id IS DISTINCT FROM NEW.id
    OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
    OR OLD.snapshot_id IS DISTINCT FROM NEW.snapshot_id
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

-- Returning to draft is safe only after the live snapshot has been superseded.
-- Frozen content, schedule, and soft-delete state cannot change in the same
-- transition, while a live snapshot exists, or while either side of an update
-- is otherwise non-draft.
CREATE OR REPLACE FUNCTION campaign_no_edit_after_send()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'draft'
    AND NEW.status = 'draft'
    AND EXISTS (
      SELECT 1
      FROM campaign_snapshot
      WHERE tenant_id = OLD.tenant_id
        AND campaign_id = OLD.id
        AND superseded_at IS NULL
    ) THEN
    RAISE EXCEPTION 'A campaign with a live snapshot cannot return to draft'
      USING ERRCODE = '55000';
  END IF;
  IF (
      OLD.status <> 'draft'
      OR NEW.status <> 'draft'
      OR EXISTS (
        SELECT 1
        FROM campaign_snapshot
        WHERE tenant_id = OLD.tenant_id
          AND campaign_id = OLD.id
          AND superseded_at IS NULL
      )
    )
    AND (
      OLD.name IS DISTINCT FROM NEW.name
      OR OLD.subject IS DISTINCT FROM NEW.subject
      OR OLD.template_id IS DISTINCT FROM NEW.template_id
      OR OLD.template_version_id IS DISTINCT FROM NEW.template_version_id
      OR OLD.sender_json IS DISTINCT FROM NEW.sender_json
      OR OLD.audience_json IS DISTINCT FROM NEW.audience_json
      OR OLD.settings_json IS DISTINCT FROM NEW.settings_json
      OR OLD.scheduled_at_utc IS DISTINCT FROM NEW.scheduled_at_utc
      OR OLD.scheduled_timezone IS DISTINCT FROM NEW.scheduled_timezone
      OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at
    ) THEN
    RAISE EXCEPTION 'Campaign content cannot be edited after it has been frozen for sending'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
