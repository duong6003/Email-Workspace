-- Runtime role separation for PostgreSQL row-level security.
--
-- `eow` remains the database owner/migration role. Runtime services connect as
-- `eow_app`, which is deliberately unable to bypass RLS. The password is
-- supplied by database/migrate.sh as the psql variable `app_password`; it is
-- never stored in this migration.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eow_app') THEN
    CREATE ROLE eow_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

ALTER ROLE eow_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE
  PASSWORD :'app_password';

GRANT CONNECT ON DATABASE :"DBNAME" TO eow_app;
GRANT USAGE ON SCHEMA public TO eow_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  recipient,
  recipient_list,
  recipient_list_member,
  recipient_tag,
  tag,
  recipient_custom_value,
  custom_field_definition,
  campaign,
  campaign_recipient,
  campaign_snapshot,
  email_template,
  email_template_version,
  import_job,
  import_job_row,
  bulk_job,
  bulk_job_row,
  notification,
  user_notification,
  audit_log,
  outbox_event,
  idempotency_key,
  user_role
TO eow_app;

-- Auth bootstrap tables are intentionally not RLS-scoped in phase 1, but the
-- API still needs them to discover and validate tenant identity before a
-- tenant context exists.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  tenant,
  app_user,
  user_session,
  login_attempt,
  password_reset_token,
  role,
  permission,
  role_permission
TO eow_app;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO eow_app;
