-- M5-S2 -- scheduling. 001_initial.sql already published scheduled_at_utc,
-- scheduled_timezone and idx_campaign_status_schedule; 018 published the status
-- CHECK. Both are untouched here (forward-only).

-- BR-SCH-007 needs 'missed'; BR-SCH-009 needs 'blocked'. 018's CHECK has
-- neither, and contracts/openapi.yaml spells partial_failed as
-- "partially_failed" -- a live drift on a still-mocked operation (D-80). The DB
-- spelling wins (it is what campaign.entity.ts and every row already use); the
-- OpenAPI enum is corrected in CP5 to match, not the other way round.
ALTER TABLE campaign DROP CONSTRAINT campaign_status_known;
ALTER TABLE campaign
  ADD CONSTRAINT campaign_status_known CHECK (status IN (
    'draft', 'scheduled', 'blocked', 'missed',
    'queued', 'validating', 'sending', 'paused', 'completed', 'partial_failed', 'failed', 'cancelled'
  ));

-- BR-SCH-007: expected vs actual, persisted here, rendered by M6-S3 (DEC-089).
ALTER TABLE campaign
  ADD COLUMN IF NOT EXISTS actual_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS delay_seconds integer,
  ADD CONSTRAINT campaign_delay_seconds_nonnegative
    CHECK (delay_seconds IS NULL OR delay_seconds >= 0);

-- A scheduled campaign must carry both halves of BR-SCH-002 or neither.
ALTER TABLE campaign
  ADD CONSTRAINT campaign_schedule_complete CHECK (
    (scheduled_at_utc IS NULL AND scheduled_timezone IS NULL)
    OR (scheduled_at_utc IS NOT NULL AND scheduled_timezone IS NOT NULL)
  );

-- The dispatch claim (SS3.4) is a partial-index scan over due rows only. The 001
-- index is (tenant_id, status, scheduled_at_utc) and therefore cannot serve a
-- cross-tenant sweep, which is exactly what the dispatcher performs.
CREATE INDEX IF NOT EXISTS idx_campaign_due_schedule
  ON campaign (scheduled_at_utc)
  WHERE status = 'scheduled' AND deleted_at IS NULL;

-- SS0(b) reconciliation. 023 guards seven content columns whenever OLD.status
-- is in a fixed non-draft set, and additionally blocks the draft->scheduled
-- transition itself and every scheduled->* transition that touches the
-- schedule columns -- including the cancel/misfire clears this node requires.
-- Neither extreme is right: the schedule columns must be writable on the
-- transition INTO scheduled, and frozen once there except when clearing them
-- as part of leaving 'scheduled' for 'cancelled' or 'missed'.
--
-- CREATE OR REPLACE fully replaces the function body, so both of 023's own
-- guards -- queued-to-draft-while-a-live-snapshot-exists, and the content
-- freeze's three-way OR/EXISTS condition (not just a fixed OLD.status list,
-- which would silently readmit 'cancelled'/'failed'/'partial_failed' and the
-- draft-with-a-stray-live-snapshot case) -- are restated here verbatim rather
-- than narrowed. Caught by campaign-snapshot-immutability.test.ts's 023-added
-- cases failing on first re-run after this migration was first written
-- against the plan's own simplified (and, it turned out, incomplete)
-- transcription of 023's trigger (CP2 regression check, R4).
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
      OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at
    ) THEN
    RAISE EXCEPTION 'Campaign content cannot be edited after it has been frozen for sending'
      USING ERRCODE = '55000';
  END IF;

  -- BR-SCH-005: the schedule instant is set on the draft->scheduled transition
  -- and immutable thereafter. Changing it requires cancel-then-reschedule
  -- (BR-SCH-005's own "chinh sua tao lai snapshot va validation"), not an
  -- in-place UPDATE. This is a positive allow-list of the only two legitimate
  -- transitions that may touch these columns, not "anything except while
  -- draft" -- 023's own EXISTS-based content guard above would otherwise
  -- still block the initial draft->scheduled set via its NEW.status<>'draft'
  -- arm, and a permissive "OLD.status<>'draft'" schedule guard would fail to
  -- catch a stray write while OLD.status stays 'draft' with an orphaned live
  -- snapshot still attached (exactly what 023's EXISTS arm exists to catch).
  IF (
      OLD.scheduled_at_utc IS DISTINCT FROM NEW.scheduled_at_utc
      OR OLD.scheduled_timezone IS DISTINCT FROM NEW.scheduled_timezone
    )
    AND NOT (
      (OLD.status = 'draft' AND NEW.status = 'scheduled')
      OR (OLD.status = 'scheduled' AND NEW.status IN ('cancelled', 'missed'))
    )
    THEN
    RAISE EXCEPTION 'A scheduled campaign''s time cannot be edited in place; cancel and reschedule'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
