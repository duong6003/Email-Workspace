-- Forward migration for M2-S2 (lists and tags). Never edits 001-009.
--
-- The published baseline already has the four segment tables, but it cannot
-- represent soft deletion or enforce the BR-SEG-002 comparison rule.  The
-- partial indexes make active names unique after trim/case normalization;
-- archived names may safely be reused by a newly created segment.

ALTER TABLE recipient_list
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

ALTER TABLE tag
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- 001's unconditional unique constraints would keep a soft-deleted name
-- reserved forever. Replace them with the active-row indexes below.
ALTER TABLE recipient_list DROP CONSTRAINT IF EXISTS recipient_list_tenant_id_name_key;
ALTER TABLE tag DROP CONSTRAINT IF EXISTS tag_tenant_id_name_key;

ALTER TABLE recipient_list_member
  ADD COLUMN IF NOT EXISTS joined_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';

ALTER TABLE recipient_tag
  ADD COLUMN IF NOT EXISTS joined_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';

DROP INDEX IF EXISTS uq_recipient_list_active_normalized_name;
CREATE UNIQUE INDEX uq_recipient_list_active_normalized_name
  ON recipient_list (tenant_id, lower(btrim(name)))
  WHERE deleted_at IS NULL;

DROP INDEX IF EXISTS uq_tag_active_normalized_name;
CREATE UNIQUE INDEX uq_tag_active_normalized_name
  ON tag (tenant_id, lower(btrim(name)))
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_recipient_list_tenant_active_name
  ON recipient_list (tenant_id, name, id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_tag_tenant_active_name
  ON tag (tenant_id, name, id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_recipient_list_member_tenant_recipient
  ON recipient_list_member (tenant_id, recipient_id, list_id);

CREATE INDEX IF NOT EXISTS idx_recipient_tag_tenant_recipient
  ON recipient_tag (tenant_id, recipient_id, tag_id);
