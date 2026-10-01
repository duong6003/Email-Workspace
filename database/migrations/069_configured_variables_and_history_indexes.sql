CREATE TABLE configured_variable (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('global', 'template')),
  template_id uuid REFERENCES email_template(id),
  variable_key text NOT NULL CHECK (variable_key ~ '^[a-z][a-z0-9_]{0,63}$'),
  label text NOT NULL CHECK (btrim(label) <> ''),
  default_value jsonb,
  required boolean NOT NULL DEFAULT false,
  allow_campaign_override boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT configured_variable_scope_owner CHECK (
    (scope = 'global' AND template_id IS NULL AND default_value IS NOT NULL AND required = false)
    OR (scope = 'template' AND template_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX uq_configured_variable_global_key
  ON configured_variable (tenant_id, variable_key) WHERE scope = 'global';
CREATE UNIQUE INDEX uq_configured_variable_template_key
  ON configured_variable (tenant_id, template_id, variable_key) WHERE scope = 'template';
CREATE INDEX idx_configured_variable_template
  ON configured_variable (tenant_id, template_id, created_at) WHERE scope = 'template';

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE configured_variable TO eow_app;
ALTER TABLE configured_variable ENABLE ROW LEVEL SECURITY;
ALTER TABLE configured_variable FORCE ROW LEVEL SECURITY;
CREATE POLICY configured_variable_tenant_isolation ON configured_variable
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE campaign_snapshot
  ADD COLUMN configured_variable_values_json jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE OR REPLACE FUNCTION campaign_snapshot_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Campaign snapshots are immutable and cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF OLD.superseded_at IS NOT NULL OR NEW.superseded_at IS NULL THEN
    RAISE EXCEPTION 'A campaign snapshot may only be superseded once, and nothing else may change' USING ERRCODE = '55000';
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
    OR OLD.configured_variable_values_json IS DISTINCT FROM NEW.configured_variable_values_json
    OR OLD.total_snapshot IS DISTINCT FROM NEW.total_snapshot
    OR OLD.sendable_count IS DISTINCT FROM NEW.sendable_count
    OR OLD.skipped_count IS DISTINCT FROM NEW.skipped_count
    OR OLD.frozen_at IS DISTINCT FROM NEW.frozen_at
    OR OLD.parent_snapshot_id IS DISTINCT FROM NEW.parent_snapshot_id THEN
    RAISE EXCEPTION 'Campaign snapshot content is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE INDEX idx_campaign_recipient_history_email
  ON campaign_recipient (tenant_id, campaign_id, lower(recipient_email), id);
CREATE INDEX idx_message_attempt_recipient_latest
  ON message_attempt (tenant_id, campaign_recipient_id, attempt_no DESC)
  INCLUDE (provider_message_id, error_code, error_class, provider_response, attempted_at, next_retry_at, outcome);
CREATE INDEX idx_message_attempt_recipient_submitted
  ON message_attempt (tenant_id, campaign_recipient_id, attempted_at DESC)
  WHERE outcome = 'submitted';
CREATE INDEX idx_delivery_event_recipient_delivered
  ON delivery_event (tenant_id, campaign_recipient_id, occurred_at DESC)
  WHERE event_type = 'delivered';
