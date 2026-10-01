-- 034_sending_quota.sql
-- BR-CFG-006 (M7-S1). "Moi sender/tenant co quota va rate limit cau hinh; quota
-- duoc kiem khi review va thuc thi." Acceptance: "Khong oversubscribe khi nhieu
-- campaign song song; reservation duoc release khi cancel."
--
-- A derived COUNT(*) cannot satisfy the concurrency half: two transactions
-- counting at the same instant both see the pre-reservation total and both
-- succeed. Capacity therefore lives in a ledger, and reservation takes a row
-- lock on the tenant's sending_policy row.

ALTER TABLE sending_policy
  ADD COLUMN IF NOT EXISTS send_quota_limit integer,
  ADD COLUMN IF NOT EXISTS send_quota_period text NOT NULL DEFAULT 'month';

ALTER TABLE sending_policy
  ADD CONSTRAINT sending_policy_quota_limit_positive
    CHECK (send_quota_limit IS NULL OR send_quota_limit > 0),
  ADD CONSTRAINT sending_policy_quota_period_values
    CHECK (send_quota_period IN ('day', 'month'));

COMMENT ON COLUMN sending_policy.send_quota_limit IS
  'BR-CFG-006: messages allowed per send_quota_period. NULL means unlimited, preserving pre-M7-S1 behavior for existing tenants.';

CREATE TABLE IF NOT EXISTS quota_reservation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  campaign_id uuid NOT NULL,
  snapshot_id uuid,
  period_key text NOT NULL,
  amount integer NOT NULL,
  consumed integer NOT NULL DEFAULT 0,
  state text NOT NULL DEFAULT 'held',
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  CONSTRAINT quota_reservation_amount_positive CHECK (amount > 0),
  CONSTRAINT quota_reservation_consumed_range CHECK (consumed >= 0 AND consumed <= amount),
  CONSTRAINT quota_reservation_state_values CHECK (state IN ('held', 'released')),
  CONSTRAINT quota_reservation_released_consistent
    CHECK ((state = 'released') = (released_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_quota_reservation_live
  ON quota_reservation (tenant_id, campaign_id, period_key)
  WHERE state = 'held';

CREATE INDEX IF NOT EXISTS idx_quota_reservation_period
  ON quota_reservation (tenant_id, period_key)
  WHERE state = 'held';

CREATE TABLE IF NOT EXISTS quota_threshold_emission (
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  period_key text NOT NULL,
  threshold integer NOT NULL,
  emitted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, period_key, threshold),
  CONSTRAINT quota_threshold_emission_values CHECK (threshold IN (80, 90, 100))
);

ALTER TABLE quota_reservation ENABLE ROW LEVEL SECURITY;
ALTER TABLE quota_reservation FORCE ROW LEVEL SECURITY;
CREATE POLICY quota_reservation_tenant_isolation ON quota_reservation
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE quota_threshold_emission ENABLE ROW LEVEL SECURITY;
ALTER TABLE quota_threshold_emission FORCE ROW LEVEL SECURITY;
CREATE POLICY quota_threshold_emission_tenant_isolation ON quota_threshold_emission
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON quota_reservation TO eow_app;
GRANT SELECT, INSERT ON quota_threshold_emission TO eow_app;
