-- M6-S3 CP6 -- 029 added campaign_snapshot.parent_snapshot_id but never
-- updated campaign_snapshot_immutable()'s own column list, so an UPDATE
-- that superseded a row while also silently changing its parent_snapshot_id
-- was not caught by the guard that already protects every other frozen
-- column. Forward-only fix, following 023's own precedent of
-- CREATE OR REPLACE on this same function to correct a discoverable gap.

CREATE OR REPLACE FUNCTION campaign_snapshot_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Campaign snapshots are immutable and cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.superseded_at IS NOT NULL OR NEW.superseded_at IS NULL THEN
    RAISE EXCEPTION 'A campaign snapshot may only be superseded once, and nothing else may change'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.id IS DISTINCT FROM NEW.id
    OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
    OR OLD.campaign_id IS DISTINCT FROM NEW.campaign_id
    OR OLD.template_version_id IS DISTINCT FROM NEW.template_version_id
    OR OLD.frozen_by IS DISTINCT FROM NEW.frozen_by
    OR OLD.sender_json IS DISTINCT FROM NEW.sender_json
    OR OLD.audience_query_json IS DISTINCT FROM NEW.audience_query_json
    OR OLD.policy_result_json IS DISTINCT FROM NEW.policy_result_json
    OR OLD.variable_schema_json IS DISTINCT FROM NEW.variable_schema_json
    OR OLD.total_snapshot IS DISTINCT FROM NEW.total_snapshot
    OR OLD.sendable_count IS DISTINCT FROM NEW.sendable_count
    OR OLD.skipped_count IS DISTINCT FROM NEW.skipped_count
    OR OLD.frozen_at IS DISTINCT FROM NEW.frozen_at
    OR OLD.parent_snapshot_id IS DISTINCT FROM NEW.parent_snapshot_id THEN
    RAISE EXCEPTION 'Campaign snapshot content is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
