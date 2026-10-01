-- M5-S1 sender configuration. Secrets are referenced only; plaintext never enters PostgreSQL.
CREATE TABLE sender_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  name text NOT NULL,
  from_name text NOT NULL DEFAULT '',
  from_email text NOT NULL,
  reply_to text,
  provider text NOT NULL DEFAULT 'smtp' CHECK (provider IN ('smtp')),
  host text NOT NULL,
  port integer NOT NULL DEFAULT 1025 CHECK (port BETWEEN 1 AND 65535),
  username text NOT NULL DEFAULT '',
  secret_ref text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'failed', 'disabled')),
  verified_at timestamptz,
  last_tested_at timestamptz,
  created_by uuid REFERENCES app_user(id),
  updated_by uuid REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX idx_sender_config_tenant_email_active ON sender_config (tenant_id, lower(from_email)) WHERE deleted_at IS NULL;
CREATE INDEX idx_sender_config_tenant_status ON sender_config (tenant_id, status, updated_at DESC);

CREATE TABLE sending_policy (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL UNIQUE REFERENCES tenant(id),
  default_sender_config_id uuid REFERENCES sender_config(id),
  reply_to text,
  updated_by uuid REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE sender_config TO eow_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE sending_policy TO eow_app;
ALTER TABLE sender_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE sender_config FORCE ROW LEVEL SECURITY;
CREATE POLICY sender_config_tenant_isolation ON sender_config USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
ALTER TABLE sending_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE sending_policy FORCE ROW LEVEL SECURITY;
CREATE POLICY sending_policy_tenant_isolation ON sending_policy USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
