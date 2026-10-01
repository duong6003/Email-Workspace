-- M3-S3 — durable, tenant-isolated test sends are separate from campaign recipients.

CREATE TABLE template_test_send (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  template_version_id uuid NOT NULL REFERENCES email_template_version(id),
  actor_id uuid NOT NULL REFERENCES app_user(id),
  recipient_email text NOT NULL,
  status text NOT NULL CHECK (status IN ('sending', 'sent', 'failed')),
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_template_test_send_tenant_created ON template_test_send (tenant_id, created_at DESC);

-- Runtime needs only to create a durable attempt, inspect its own status, and
-- write the delivery outcome. Cleanup remains an owner/test-fixture concern.
GRANT SELECT, INSERT, UPDATE ON TABLE template_test_send TO eow_app;

ALTER TABLE template_test_send ENABLE ROW LEVEL SECURITY;
ALTER TABLE template_test_send FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS template_test_send_tenant_isolation ON template_test_send;
CREATE POLICY template_test_send_tenant_isolation ON template_test_send
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
