-- MC-UI-005 asset library (Mailcraft S6), per ADR-043 §3.
--
-- The row is the source of truth; the object store holds only bytes. The object
-- key is DERIVED (`tenant/<tenant_id>/<id>`, ADR-043 §3) rather than stored, so
-- there is no second place for the two to disagree, and moving to per-tenant
-- buckets later changes one function instead of a column.
--
-- `content_type` is constrained to the four types ADR-043 §4 allows. The API
-- already refuses anything else by magic bytes; this is the last line, and it is
-- the one that still holds if a future code path forgets to call the validator.
-- `image/svg+xml` is absent on purpose: SVG can carry script, and these files are
-- served from our own origin through a public route.
--
-- No unique index on the filename, deliberately -- unlike `reusable_block`, whose
-- names are how people refer to blocks. Two departments uploading their own
-- `logo.png` is ordinary, and the served URL is keyed by id, so a collision has
-- no meaning here.
CREATE TABLE asset (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  original_filename text NOT NULL CHECK (btrim(original_filename) <> ''),
  content_type text NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp')),
  -- 5 MB, the same ceiling template HTML has (ADR-043 §4): one number to
  -- remember, not two. `> 0` because a zero-byte image is a failed upload that
  -- would otherwise sit in the library looking real.
  byte_size integer NOT NULL CHECK (byte_size > 0 AND byte_size <= 5242880),
  width integer CHECK (width IS NULL OR width > 0),
  height integer CHECK (height IS NULL OR height > 0),
  created_by uuid NULL,
  -- ADR-043 §5: soft delete only. A published version is immutable and still
  -- points at this asset's URL, so removing it would break an already-approved
  -- email that can no longer be edited. Archiving hides it from the library;
  -- the public route keeps serving it. This is the opposite of reusable_block
  -- (075), where insert copies the subtree and a hard delete breaks nothing.
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The library listing: a tenant's live assets, newest first.
CREATE INDEX idx_asset_tenant_live
  ON asset (tenant_id, created_at DESC) WHERE archived_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON TABLE asset TO eow_app;
-- No DELETE grant. ADR-043 §5 has no hard delete, and withholding the privilege
-- means a future code path cannot quietly acquire one.
ALTER TABLE asset ENABLE ROW LEVEL SECURITY;
ALTER TABLE asset FORCE ROW LEVEL SECURITY;
CREATE POLICY asset_tenant_isolation ON asset
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
