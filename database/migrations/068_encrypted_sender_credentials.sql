-- Sender credentials must survive API restarts and be readable by workers without storing plaintext.
CREATE TABLE sender_credential (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  secret_ref text NOT NULL,
  ciphertext text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, secret_ref)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE sender_credential TO eow_app;
ALTER TABLE sender_credential ENABLE ROW LEVEL SECURITY;
ALTER TABLE sender_credential FORCE ROW LEVEL SECURITY;
CREATE POLICY sender_credential_tenant_isolation ON sender_credential
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- Existing authenticated configurations may point at an API-process-only secret.
-- Force an explicit credential save and successful probe before they can send again.
UPDATE sender_config
SET status = 'pending', verified_at = NULL, updated_at = now()
WHERE username <> '' AND status = 'verified';
