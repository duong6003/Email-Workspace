-- MC-UI-004 reusable block library (Mailcraft S5).
--
-- Ownership is the TENANT, not the creator -- decided 2026-09-03, recorded in
-- docs/superpowers/plans/2026-08-31-mailcraft-builder-vertical-slice.md §S5
-- Task 26. So `tenant_id` is the scope column and there is no owner column:
-- `created_by` exists for attribution in the list, never for authorization.
-- Read is content:read, and rename/delete are content:manage over EVERY block
-- in the tenant, including ones another person saved.
--
-- `node` is a `Node` subtree from apps/web/.../builder/document.ts, not HTML.
-- Storing HTML would open a second path onto the canvas that the component
-- tree knows nothing about -- the thing ADR-037 §3 forbids. The API never
-- parses it, exactly as it never parses email_template.project_data
-- (ADR-019): it is opaque JSON that travels with the row.
--
-- No soft delete here, deliberately, and this is where the rule differs from
-- assets (ADR-043 §5). Inserting a block COPIES its subtree into the document,
-- so a template owns its copy and deleting the library entry cannot break any
-- template, published ones included. An asset needs a soft delete because an
-- immutable version still points at its URL. Do not carry that rule over.
--
-- `created_by` is nullable with no foreign key, following 072's published_by:
-- the actor can legitimately be unknown, and a FK would force a decision about
-- what happens to a tenant's shared blocks when the person who saved them is
-- removed -- which under tenant ownership is "nothing".
CREATE TABLE reusable_block (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (btrim(name) <> ''),
  node jsonb NOT NULL,
  created_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Unique per TENANT, not per creator (Task 26), and normalized the same way
-- email_template_active_normalized_name_key does it (015) so "Footer" and
-- " footer " collide here exactly as they already do for template names.
CREATE UNIQUE INDEX reusable_block_normalized_name_key
  ON reusable_block (tenant_id, lower(btrim(name)));

CREATE INDEX idx_reusable_block_tenant_name
  ON reusable_block (tenant_id, lower(btrim(name)));

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE reusable_block TO eow_app;
ALTER TABLE reusable_block ENABLE ROW LEVEL SECURITY;
ALTER TABLE reusable_block FORCE ROW LEVEL SECURITY;
CREATE POLICY reusable_block_tenant_isolation ON reusable_block
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
