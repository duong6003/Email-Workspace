-- New compose drafts are created before the operator has entered a name.
-- A non-blank name remains mandatory at the send/schedule preflight boundary.
ALTER TABLE campaign DROP CONSTRAINT IF EXISTS campaign_name_not_blank;

-- ADR-029: the SMTP RCPT TO address is frozen explicitly instead of being
-- inferred later from one merge-data key. Existing snapshots are repaired
-- once; future inserts are guarded for compatibility with direct/imported
-- writers while the application always supplies the value explicitly.
ALTER TABLE campaign_recipient ADD COLUMN recipient_email text;

UPDATE campaign_recipient cr
SET recipient_email = COALESCE(NULLIF(btrim(cr.merge_data_json->>'email'), ''), recipient.email)
FROM recipient
WHERE recipient.id = cr.recipient_id
  AND recipient.tenant_id = cr.tenant_id;

CREATE OR REPLACE FUNCTION campaign_recipient_freeze_envelope()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.recipient_email := COALESCE(
    NULLIF(btrim(NEW.recipient_email), ''),
    NULLIF(btrim(NEW.merge_data_json->>'email'), ''),
    (SELECT email FROM recipient WHERE id = NEW.recipient_id AND tenant_id = NEW.tenant_id)
  );
  IF NEW.recipient_email IS NULL THEN
    RAISE EXCEPTION 'Frozen campaign recipient requires a recipient email'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER campaign_recipient_freeze_envelope_trigger
BEFORE INSERT ON campaign_recipient
FOR EACH ROW EXECUTE FUNCTION campaign_recipient_freeze_envelope();

ALTER TABLE campaign_recipient
  ALTER COLUMN recipient_email SET NOT NULL,
  ADD CONSTRAINT campaign_recipient_email_not_blank CHECK (btrim(recipient_email) <> '');

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
    OR OLD.recipient_email IS DISTINCT FROM NEW.recipient_email
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
