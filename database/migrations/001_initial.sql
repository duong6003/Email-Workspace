CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE tenant (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app_user (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenant(id),
  email text NOT NULL, display_name text NOT NULL, role text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (tenant_id, email)
);
CREATE TABLE recipient (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenant(id),
  email text NOT NULL, first_name text, last_name text, phone text, department text,
  title text, location text, subscription_status text NOT NULL DEFAULT 'active',
  version bigint NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (tenant_id, email)
);
CREATE TABLE recipient_list (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenant(id),
  name text NOT NULL, description text, UNIQUE (tenant_id, name)
);
CREATE TABLE tag (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenant(id),
  name text NOT NULL, color text NOT NULL, UNIQUE (tenant_id, name)
);
CREATE TABLE recipient_list_member (
  tenant_id uuid NOT NULL REFERENCES tenant(id), list_id uuid NOT NULL REFERENCES recipient_list(id),
  recipient_id uuid NOT NULL REFERENCES recipient(id), PRIMARY KEY (list_id, recipient_id)
);
CREATE TABLE recipient_tag (
  tenant_id uuid NOT NULL REFERENCES tenant(id), tag_id uuid NOT NULL REFERENCES tag(id),
  recipient_id uuid NOT NULL REFERENCES recipient(id), PRIMARY KEY (tag_id, recipient_id)
);
CREATE TABLE custom_field_definition (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenant(id),
  field_key text NOT NULL, label text NOT NULL, data_type text NOT NULL,
  required boolean NOT NULL DEFAULT false, UNIQUE (tenant_id, field_key)
);
CREATE TABLE recipient_custom_value (
  tenant_id uuid NOT NULL REFERENCES tenant(id), recipient_id uuid NOT NULL REFERENCES recipient(id),
  field_id uuid NOT NULL REFERENCES custom_field_definition(id), value_json jsonb NOT NULL,
  PRIMARY KEY (recipient_id, field_id)
);
CREATE TABLE email_template (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenant(id),
  name text NOT NULL, status text NOT NULL DEFAULT 'draft', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE email_template_version (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenant(id),
  template_id uuid NOT NULL REFERENCES email_template(id), version integer NOT NULL,
  subject text NOT NULL, html text NOT NULL, text_body text NOT NULL,
  required_variables text[] NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_id, version)
);
CREATE TABLE campaign (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenant(id),
  name text NOT NULL, status text NOT NULL DEFAULT 'draft', scheduled_at_utc timestamptz,
  scheduled_timezone text, version bigint NOT NULL DEFAULT 0, created_by uuid REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE campaign_snapshot (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenant(id),
  campaign_id uuid NOT NULL UNIQUE REFERENCES campaign(id), template_version_id uuid NOT NULL REFERENCES email_template_version(id),
  sender_json jsonb NOT NULL, audience_query_json jsonb NOT NULL, policy_result_json jsonb NOT NULL,
  frozen_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE campaign_recipient (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenant(id),
  campaign_id uuid NOT NULL REFERENCES campaign(id), recipient_id uuid NOT NULL REFERENCES recipient(id),
  merge_data_json jsonb NOT NULL, status text NOT NULL DEFAULT 'queued', provider_message_id text,
  last_error_code text, updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (campaign_id, recipient_id)
);
CREATE TABLE notification (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenant(id),
  type text NOT NULL, severity text NOT NULL, title text NOT NULL, body text NOT NULL,
  entity_type text, entity_id uuid, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE user_notification (
  tenant_id uuid NOT NULL REFERENCES tenant(id), notification_id uuid NOT NULL REFERENCES notification(id),
  user_id uuid NOT NULL REFERENCES app_user(id), read_at timestamptz, archived_at timestamptz,
  PRIMARY KEY (notification_id, user_id)
);
CREATE TABLE outbox_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenant(id),
  event_type text NOT NULL, aggregate_type text NOT NULL, aggregate_id uuid NOT NULL,
  aggregate_version bigint NOT NULL, payload jsonb NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz, attempts integer NOT NULL DEFAULT 0,
  UNIQUE (aggregate_type, aggregate_id, aggregate_version, event_type)
);
CREATE TABLE audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenant(id),
  actor_id uuid, action text NOT NULL, entity_type text NOT NULL, entity_id uuid,
  trace_id text NOT NULL, metadata jsonb NOT NULL DEFAULT '{}', occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_campaign_status_schedule ON campaign (tenant_id, status, scheduled_at_utc);
CREATE INDEX idx_campaign_recipient_progress ON campaign_recipient (tenant_id, campaign_id, status);
CREATE INDEX idx_outbox_unpublished ON outbox_event (occurred_at) WHERE published_at IS NULL;
CREATE INDEX idx_user_notification_unread ON user_notification (tenant_id, user_id) WHERE read_at IS NULL;
