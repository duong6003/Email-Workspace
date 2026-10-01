-- Phase 1 PostgreSQL row-level security for tenant-owned business data.
--
-- Deliberately excluded auth-bootstrap tables:
--   app_user              login discovers the tenant by email before context exists
--   user_session          session validation runs before tenant context exists
--   login_attempt         unknown-email attempts deliberately carry tenant_id = NULL
--   password_reset_token  consumed without an authenticated tenant session
-- The tenant registry and global RBAC catalogues are not tenant-owned.

CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

GRANT EXECUTE ON FUNCTION current_tenant_id() TO eow_app;

ALTER TABLE recipient ENABLE ROW LEVEL SECURITY;
ALTER TABLE recipient FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS recipient_tenant_isolation ON recipient;
CREATE POLICY recipient_tenant_isolation ON recipient
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE recipient_list ENABLE ROW LEVEL SECURITY;
ALTER TABLE recipient_list FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS recipient_list_tenant_isolation ON recipient_list;
CREATE POLICY recipient_list_tenant_isolation ON recipient_list
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE recipient_list_member ENABLE ROW LEVEL SECURITY;
ALTER TABLE recipient_list_member FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS recipient_list_member_tenant_isolation ON recipient_list_member;
CREATE POLICY recipient_list_member_tenant_isolation ON recipient_list_member
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE recipient_tag ENABLE ROW LEVEL SECURITY;
ALTER TABLE recipient_tag FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS recipient_tag_tenant_isolation ON recipient_tag;
CREATE POLICY recipient_tag_tenant_isolation ON recipient_tag
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE tag ENABLE ROW LEVEL SECURITY;
ALTER TABLE tag FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tag_tenant_isolation ON tag;
CREATE POLICY tag_tenant_isolation ON tag
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE recipient_custom_value ENABLE ROW LEVEL SECURITY;
ALTER TABLE recipient_custom_value FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS recipient_custom_value_tenant_isolation ON recipient_custom_value;
CREATE POLICY recipient_custom_value_tenant_isolation ON recipient_custom_value
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE custom_field_definition ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_field_definition FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS custom_field_definition_tenant_isolation ON custom_field_definition;
CREATE POLICY custom_field_definition_tenant_isolation ON custom_field_definition
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE campaign ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS campaign_tenant_isolation ON campaign;
CREATE POLICY campaign_tenant_isolation ON campaign
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE campaign_recipient ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_recipient FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS campaign_recipient_tenant_isolation ON campaign_recipient;
CREATE POLICY campaign_recipient_tenant_isolation ON campaign_recipient
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE campaign_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_snapshot FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS campaign_snapshot_tenant_isolation ON campaign_snapshot;
CREATE POLICY campaign_snapshot_tenant_isolation ON campaign_snapshot
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE email_template ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_template FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS email_template_tenant_isolation ON email_template;
CREATE POLICY email_template_tenant_isolation ON email_template
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE email_template_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_template_version FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS email_template_version_tenant_isolation ON email_template_version;
CREATE POLICY email_template_version_tenant_isolation ON email_template_version
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE import_job ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_job FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS import_job_tenant_isolation ON import_job;
CREATE POLICY import_job_tenant_isolation ON import_job
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE bulk_job ENABLE ROW LEVEL SECURITY;
ALTER TABLE bulk_job FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bulk_job_tenant_isolation ON bulk_job;
CREATE POLICY bulk_job_tenant_isolation ON bulk_job
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE notification ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notification_tenant_isolation ON notification;
CREATE POLICY notification_tenant_isolation ON notification
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE user_notification ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_notification FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_notification_tenant_isolation ON user_notification;
CREATE POLICY user_notification_tenant_isolation ON user_notification
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_log_tenant_isolation ON audit_log;
CREATE POLICY audit_log_tenant_isolation ON audit_log
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE outbox_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_event FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS outbox_event_tenant_isolation ON outbox_event;
CREATE POLICY outbox_event_tenant_isolation ON outbox_event
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE idempotency_key ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_key FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS idempotency_key_tenant_isolation ON idempotency_key;
CREATE POLICY idempotency_key_tenant_isolation ON idempotency_key
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE user_role ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_role FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_role_tenant_isolation ON user_role;
CREATE POLICY user_role_tenant_isolation ON user_role
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- Row tables inherit tenant ownership through their parent job. The parent
-- lookup is itself protected by RLS, and the explicit tenant predicate keeps
-- the policy intent clear and independently auditable.
ALTER TABLE import_job_row ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_job_row FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS import_job_row_tenant_isolation ON import_job_row;
CREATE POLICY import_job_row_tenant_isolation ON import_job_row
  USING (EXISTS (
    SELECT 1 FROM import_job j
    WHERE j.id = import_job_row.job_id
      AND j.tenant_id = current_tenant_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM import_job j
    WHERE j.id = import_job_row.job_id
      AND j.tenant_id = current_tenant_id()
  ));

ALTER TABLE bulk_job_row ENABLE ROW LEVEL SECURITY;
ALTER TABLE bulk_job_row FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bulk_job_row_tenant_isolation ON bulk_job_row;
CREATE POLICY bulk_job_row_tenant_isolation ON bulk_job_row
  USING (EXISTS (
    SELECT 1 FROM bulk_job j
    WHERE j.id = bulk_job_row.job_id
      AND j.tenant_id = current_tenant_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM bulk_job j
    WHERE j.id = bulk_job_row.job_id
      AND j.tenant_id = current_tenant_id()
  ));
