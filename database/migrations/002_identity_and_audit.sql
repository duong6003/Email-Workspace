ALTER TABLE app_user
  ADD COLUMN password_hash text,
  ADD COLUMN status text NOT NULL DEFAULT 'active',
  ADD COLUMN last_login_at timestamptz;

CREATE TABLE user_session (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  user_id uuid NOT NULL REFERENCES app_user(id),
  refresh_token_hash text NOT NULL UNIQUE,
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  rotated_from uuid REFERENCES user_session(id),
  revoked_at timestamptz,
  user_agent_hash text,
  ip_hash text
);
CREATE INDEX idx_user_session_active ON user_session (tenant_id, user_id) WHERE revoked_at IS NULL;

CREATE TABLE login_attempt (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  email text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  outcome text NOT NULL,
  ip_hash text
);
CREATE INDEX idx_login_attempt_lockout ON login_attempt (tenant_id, email, occurred_at DESC);

CREATE TABLE idempotency_key (
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  key text NOT NULL,
  request_hash text NOT NULL,
  resource_type text NOT NULL,
  resource_id uuid,
  response_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, key)
);
CREATE INDEX idx_idempotency_key_expiry ON idempotency_key (expires_at);
