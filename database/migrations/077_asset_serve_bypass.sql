-- Fixes a bug found 2026-09-03 verifying S6 end to end against a real https
-- deployment: EVERY asset URL ever minted 404'd for a real, unauthenticated
-- fetch, and it was never caught because it is deterministic, not flaky, and
-- the one integration suite that exercises the public serving route
-- (assets-http.test.ts) boots its app-under-test as the OWNER role, which
-- bypasses row-level security entirely -- it could not have seen this.
--
-- 076_asset_storage.sql's `asset_tenant_isolation` policy is
-- `USING (tenant_id = current_tenant_id())`, and `current_tenant_id()` returns
-- NULL when `app.tenant_id` was never set. `tenant_id = NULL` is never true, so
-- `findServableAsset`'s deliberately tenant-blind lookup (ADR-043 §2: "the id
-- IS the capability, the tenant is a result of the lookup, never an input to
-- it") returns zero rows for eow_app on every single call. Proved directly:
-- `psql -U eow_app` with no `app.tenant_id` set returns `(0 rows)` for a known,
-- existing id. `asset-rls.test.ts`'s own "fails closed when no tenant context
-- is set" test (Task 34) is the general rule working exactly as intended --
-- nobody added the one narrow exception this one route needs.
--
-- The fix is the same shape 013_outbox_relay_api.sql already established for
-- exactly this problem: eow_app stays RLS-restricted everywhere else, and gets
-- a single SECURITY DEFINER function scoped to precisely the lookup the public
-- route performs, returning only the columns `AssetsService.serve()` uses --
-- not the whole row, so this function can never become a second, wider way to
-- read asset content.
CREATE FUNCTION find_servable_asset(p_id uuid)
RETURNS TABLE (id uuid, tenant_id uuid, content_type text, original_filename text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT asset.id, asset.tenant_id, asset.content_type, asset.original_filename
  FROM asset
  WHERE asset.id = p_id
$$;

GRANT EXECUTE ON FUNCTION find_servable_asset(uuid) TO eow_app;
