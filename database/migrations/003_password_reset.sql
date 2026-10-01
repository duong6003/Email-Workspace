-- Forward migration for M1-S1 (Sign in). Never edits 001 or 002.
--
-- 1. password_reset_token backs BR-AUTH-006 (single-use reset link, 30 min
--    expiry). It did not exist in 002, which only covers session/lockout.
-- 2. login_attempt.tenant_id is relaxed to nullable so a login attempt for an
--    email that does not resolve to any tenant (unknown account) can still be
--    recorded for IP/email-based lockout counting (BR-AUTH-005) without
--    fabricating a tenant association. The column, FK and index created by
--    002 are otherwise untouched.

ALTER TABLE login_attempt ALTER COLUMN tenant_id DROP NOT NULL;

CREATE TABLE password_reset_token (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  user_id uuid NOT NULL REFERENCES app_user(id),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_password_reset_token_user ON password_reset_token (tenant_id, user_id) WHERE used_at IS NULL;
