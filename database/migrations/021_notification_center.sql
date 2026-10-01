-- M6-S2: durable notification centre extensions. Existing notification tables
-- were published by 001_initial.sql and are intentionally extended in place.
ALTER TABLE notification
  ADD COLUMN IF NOT EXISTS source_event_id text,
  ADD COLUMN IF NOT EXISTS message_key text NOT NULL DEFAULT 'notification.generic',
  ADD COLUMN IF NOT EXISTS params_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS deep_link_route text,
  ADD COLUMN IF NOT EXISTS group_key text,
  ADD COLUMN IF NOT EXISTS batch_window_seconds integer NOT NULL DEFAULT 300,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS uq_notification_tenant_source_event
  ON notification (tenant_id, source_event_id) WHERE source_event_id IS NOT NULL;

ALTER TABLE user_notification
  ADD COLUMN IF NOT EXISTS action_state text NOT NULL DEFAULT 'open';
ALTER TABLE user_notification
  DROP CONSTRAINT IF EXISTS user_notification_action_state_check;
ALTER TABLE user_notification
  ADD CONSTRAINT user_notification_action_state_check
  CHECK (action_state IN ('open', 'resolved', 'expired'));

CREATE TABLE IF NOT EXISTS notification_preference (
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  user_id uuid NOT NULL REFERENCES app_user(id),
  category text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  muteable boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, category)
);
CREATE INDEX IF NOT EXISTS idx_notification_preference_user
  ON notification_preference (tenant_id, user_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE notification_preference TO eow_app;
ALTER TABLE notification_preference ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_preference FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notification_preference_tenant_isolation ON notification_preference;
CREATE POLICY notification_preference_tenant_isolation ON notification_preference
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

CREATE INDEX IF NOT EXISTS idx_notification_tenant_created
  ON notification (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_notification_user_created
  ON user_notification (tenant_id, user_id, notification_id);
