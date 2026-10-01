-- M3-S1 — mutable drafts live on email_template; every published snapshot is immutable.

ALTER TABLE email_template
  ADD COLUMN draft_subject text NOT NULL DEFAULT '',
  ADD COLUMN draft_html text NOT NULL DEFAULT '',
  ADD COLUMN draft_text_body text NOT NULL DEFAULT '',
  ADD COLUMN draft_validation_json jsonb NOT NULL DEFAULT '{"warnings":[],"errors":[],"changes":[]}'::jsonb,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN deleted_at timestamptz;

ALTER TABLE email_template
  ADD CONSTRAINT email_template_status_check CHECK (status IN ('draft', 'published', 'archived'));

CREATE UNIQUE INDEX email_template_active_normalized_name_key
  ON email_template (tenant_id, lower(btrim(name)))
  WHERE deleted_at IS NULL;

ALTER TABLE email_template
  ADD CONSTRAINT email_template_tenant_id_id_key UNIQUE (tenant_id, id);

ALTER TABLE email_template_version
  ADD COLUMN variable_schema_json jsonb NOT NULL DEFAULT '{"required":[],"optional":[]}'::jsonb,
  ADD COLUMN content_hash text,
  ADD COLUMN published_at timestamptz;

UPDATE email_template_version
SET
  variable_schema_json = '{"required":[],"optional":[]}'::jsonb,
  content_hash = encode(
    digest(
      convert_to(
        '{"format":"eow-template-content/v1","subject":' || to_json(subject)::text ||
        ',"html":' || to_json(html)::text ||
        ',"textBody":' || to_json(text_body)::text ||
        ',"variableSchema":{"required":[],"optional":[]}}',
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  ),
  published_at = created_at
WHERE content_hash IS NULL OR published_at IS NULL;

ALTER TABLE email_template_version
  ALTER COLUMN content_hash SET NOT NULL,
  ALTER COLUMN published_at SET NOT NULL,
  ADD CONSTRAINT email_template_version_content_hash_check CHECK (content_hash ~ '^[0-9a-f]{64}$');

ALTER TABLE email_template_version
  ADD CONSTRAINT email_template_version_tenant_template_fkey
  FOREIGN KEY (tenant_id, template_id)
  REFERENCES email_template (tenant_id, id);

CREATE OR REPLACE FUNCTION email_template_version_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Published template versions are immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER email_template_version_immutable_trigger
BEFORE UPDATE OR DELETE ON email_template_version
FOR EACH ROW EXECUTE FUNCTION email_template_version_immutable();
