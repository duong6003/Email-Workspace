-- M5-S4 -- inbound provider delivery events. EXECPLAN SS10 reserved
-- `delivery_events` with UNIQUE (provider, provider_event_id); that key makes a
-- replay a no-op but says nothing about ordering (M5-S4-WEBHOOK-PLAN.md SS0(g)),
-- so this migration also carries occurred_at here and delivery_state_at on
-- campaign_recipient. Singular table name, matching every other table in this
-- schema (campaign, campaign_execution, message_attempt).

-- ---------------------------------------------------------------------------
-- (1) The append-only event ledger. UNIQUE (provider, provider_event_id) IS the
-- idempotency key (BR-SEND-008, A1/A3): a replay conflicts and applies nothing.
-- Tenant-owned, because every row that reaches it has already been resolved to
-- exactly one tenant through a Message-ID this system minted (DEC-111 explains
-- why an unmatched event is not stored at all rather than stored tenant-less).
-- ---------------------------------------------------------------------------
CREATE TABLE delivery_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  provider text NOT NULL CHECK (provider IN ('smtp')),
  provider_event_id text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN (
    'delivered', 'bounced', 'complaint', 'deferred', 'unknown'
  )),
  provider_message_id text NOT NULL,
  campaign_recipient_id uuid NOT NULL REFERENCES campaign_recipient(id),
  execution_id uuid REFERENCES campaign_execution(id),
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  outcome text NOT NULL CHECK (outcome IN (
    'applied', 'ignored_out_of_order', 'ignored_illegal_transition', 'ignored_not_applicable'
  )),
  payload jsonb NOT NULL,
  UNIQUE (provider, provider_event_id)
);
CREATE INDEX idx_delivery_event_recipient
  ON delivery_event (tenant_id, campaign_recipient_id, occurred_at);

-- ---------------------------------------------------------------------------
-- (2) The ordering guard (M5-S4-WEBHOOK-PLAN.md SS3.4, A7). "Out-of-order
-- events do not regress state" needs a per-row high-water mark: the
-- occurred_at of the event that produced the current delivery state. NULL
-- until the first event applies.
-- ---------------------------------------------------------------------------
ALTER TABLE campaign_recipient
  ADD COLUMN IF NOT EXISTS delivery_state_at timestamptz;

-- ---------------------------------------------------------------------------
-- (3) D-107: provider_message_id is the only join key from a callback back to a
-- recipient and 026 left it unindexed. It cannot be UNIQUE -- the deterministic
-- Message-ID (DEC-104) repeats across re-submissions, which is exactly what
-- makes M5-S3 R2's crash window detectable -- so the resolver selects DISTINCT
-- and requires exactly one recipient (SS3.4).
-- ---------------------------------------------------------------------------
CREATE INDEX idx_message_attempt_provider_message_id
  ON message_attempt (provider_message_id)
  WHERE provider_message_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- (4) The tenant resolver. An inbound webhook carries no session, so the lookup
-- that finds the owning tenant must run before any tenant context exists. Same
-- narrow SECURITY DEFINER shape as 013/025/026: a fixed query returning nothing
-- but the ids the caller needs, so the API stays eow_app/NOBYPASSRLS and no
-- broad cross-tenant read is ever granted. DISTINCT per D-107.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION resolve_provider_message(p_provider_message_id text)
RETURNS TABLE (tenant_id uuid, campaign_recipient_id uuid, execution_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT DISTINCT message_attempt.tenant_id,
                  message_attempt.campaign_recipient_id,
                  message_attempt.execution_id
  FROM message_attempt
  WHERE message_attempt.provider_message_id = p_provider_message_id
    AND message_attempt.outcome = 'submitted'
  LIMIT 2
$$;
REVOKE ALL ON FUNCTION resolve_provider_message(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_provider_message(text) TO eow_app;

-- Append-only: no UPDATE, no DELETE grant. A correction is a new event row.
GRANT SELECT, INSERT ON TABLE delivery_event TO eow_app;
ALTER TABLE delivery_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_event FORCE ROW LEVEL SECURITY;
CREATE POLICY delivery_event_tenant_isolation ON delivery_event
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
