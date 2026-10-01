-- M5-S2 CP4 -- narrow cross-tenant dispatch scan API, same shape as 013's
-- outbox relay: the worker stays eow_app/NOBYPASSRLS and can only list due
-- campaigns through this fixed SECURITY DEFINER function. It never receives
-- table-wide owner credentials, and this function returns nothing except the
-- two ids the scan needs to re-enter a tenant transaction per campaign.

CREATE OR REPLACE FUNCTION due_scheduled_campaigns(
  p_now timestamptz,
  p_limit integer DEFAULT 100
) RETURNS TABLE (id uuid, tenant_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT campaign.id, campaign.tenant_id
  FROM campaign
  WHERE campaign.status = 'scheduled'
    AND campaign.scheduled_at_utc <= p_now
    AND campaign.deleted_at IS NULL
  ORDER BY campaign.scheduled_at_utc
  LIMIT LEAST(GREATEST(p_limit, 1), 1000)
$$;

REVOKE ALL ON FUNCTION due_scheduled_campaigns(timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION due_scheduled_campaigns(timestamptz, integer) TO eow_app;
