-- M4-S1 — durable campaign drafts. All added NOT NULL columns have defaults so
-- the already-running compose services remain compatible during rollout.

ALTER TABLE campaign
  ADD COLUMN subject text NOT NULL DEFAULT '',
  ADD COLUMN template_id uuid REFERENCES email_template(id),
  ADD COLUMN template_version_id uuid REFERENCES email_template_version(id),
  ADD COLUMN sender_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN audience_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN settings_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN updated_by uuid REFERENCES app_user(id),
  ADD COLUMN deleted_at timestamptz;

ALTER TABLE campaign
  ADD CONSTRAINT campaign_name_not_blank CHECK (length(btrim(name)) > 0),
  ADD CONSTRAINT campaign_status_known CHECK (status IN ('draft', 'scheduled', 'sending', 'completed', 'cancelled', 'failed'));

CREATE INDEX idx_campaign_drafts
  ON campaign (tenant_id, status, updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE OR REPLACE FUNCTION campaign_no_edit_after_send()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IN ('sending', 'completed')
    AND (
      OLD.name IS DISTINCT FROM NEW.name
      OR OLD.subject IS DISTINCT FROM NEW.subject
      OR OLD.template_id IS DISTINCT FROM NEW.template_id
      OR OLD.template_version_id IS DISTINCT FROM NEW.template_version_id
      OR OLD.sender_json IS DISTINCT FROM NEW.sender_json
      OR OLD.audience_json IS DISTINCT FROM NEW.audience_json
      OR OLD.settings_json IS DISTINCT FROM NEW.settings_json
    ) THEN
    RAISE EXCEPTION 'Campaign content cannot be edited after sending starts'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER campaign_no_edit_after_send_trigger
BEFORE UPDATE ON campaign
FOR EACH ROW EXECUTE FUNCTION campaign_no_edit_after_send();
