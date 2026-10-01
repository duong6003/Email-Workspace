-- 028's reconcilable_campaign_executions() ordered its bounded scan
-- `ORDER BY started_at` ascending, so once the system-wide candidate set
-- (status = 'sending' OR finished_at within 7 days) exceeds p_limit, the
-- LIMIT always keeps the OLDEST executions and permanently starves the
-- NEWEST ones -- exactly backwards, since a freshly started execution is
-- the one most likely to still need reconciliation soon. Forward-only fix,
-- following 023/030's own precedent of CREATE OR REPLACE on this locked
-- function: order newest-first so a bounded scan always covers the most
-- time-sensitive candidates first.
CREATE OR REPLACE FUNCTION reconcilable_campaign_executions(p_limit integer)
RETURNS TABLE (id uuid, tenant_id uuid, campaign_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT campaign_execution.id, campaign_execution.tenant_id, campaign_execution.campaign_id
  FROM campaign_execution
  WHERE campaign_execution.status = 'sending'
     OR campaign_execution.finished_at > now() - interval '7 days'
  ORDER BY campaign_execution.started_at DESC
  LIMIT p_limit
$$;
