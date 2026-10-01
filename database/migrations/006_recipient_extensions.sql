-- Forward migration for M2-S1 (Recipient directory). Never edits 001-005.
--
-- The `recipient` table already exists (001_initial.sql: email, first_name,
-- last_name, phone, department, title, location, subscription_status,
-- version, UNIQUE(tenant_id, email)). This slice extends it per
-- catalog/entities.json's recipient shape ("id, organization_id,
-- normalized_email, profile fields, subscription_status, deleted_at" --
-- unique (organization_id, normalized_email)) and BR-REC-001..010:
--
-- BR-REC-001 (email uniqueness, case/whitespace-insensitive per tenant):
--   normalized_email is a STORED generated column (lower(trim(email))), so
--   Postgres itself keeps it in sync -- no trigger to drift out of date.
--   The old case-sensitive UNIQUE(tenant_id, email) is dropped and replaced
--   by a *partial* unique index on (tenant_id, normalized_email) WHERE
--   deleted_at IS NULL, so a soft-deleted recipient's email can be reused
--   (BR-GEN-006: the old row's id is never reused, but its email is not
--   permanently locked out of re-registration once removed from the active
--   set) while a live duplicate is still rejected atomically by Postgres
--   (BR-REC-001's 409 path relies on this being a real DB constraint, not
--   just an application-level pre-check, to be race-free).
-- BR-REC-003 (status: active/paused/unsubscribed/bounced): a CHECK
--   constraint replaces the free-text default, since only these four values
--   are valid per the rule.
-- BR-REC-004 (unsubscribed cannot be re-activated by import/bulk-update):
--   unsubscribed_at records *when* a recipient unsubscribed, which the
--   application layer uses to refuse a bulk/import transition back to
--   active (M2-S4 scope) while still allowing an explicit Admin
--   confirm/re-consent flow (M2-S4) to clear it.
-- BR-GEN-006 (soft delete): deleted_at nullable timestamptz; active-set
--   queries always filter deleted_at IS NULL, but the row (and any
--   campaign_recipient snapshot referencing it, per BR-REC-010) remains
--   queryable for history/audit.
-- Custom-data placeholder: custom_data jsonb NOT NULL DEFAULT '{}' -- the
-- custom-fields *feature* (typed field definitions, validation, compose
-- variable panel) is M2-S3 scope; this column only exists so the M2-S1
-- recipient row shape will not need a breaking migration when M2-S3 lands.
-- BR-REC-007 (search by email/name/department, case-insensitive):
--   idx_recipient_search covers the common filter/sort columns.

ALTER TABLE recipient
  ADD COLUMN normalized_email text GENERATED ALWAYS AS (lower(trim(email))) STORED,
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN unsubscribed_at timestamptz,
  ADD COLUMN custom_data jsonb NOT NULL DEFAULT '{}';

ALTER TABLE recipient DROP CONSTRAINT recipient_tenant_id_email_key;

ALTER TABLE recipient
  ADD CONSTRAINT recipient_subscription_status_check
  CHECK (subscription_status IN ('active', 'paused', 'unsubscribed', 'bounced'));

CREATE UNIQUE INDEX idx_recipient_tenant_normalized_email_active
  ON recipient (tenant_id, normalized_email)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_recipient_search
  ON recipient (tenant_id, deleted_at, last_name, first_name);

CREATE INDEX idx_recipient_normalized_email_lookup
  ON recipient (tenant_id, normalized_email);

-- Permission catalogue: recipients now have real CRUD (previously bucketed
-- under the coarser 'content:manage' at M1-S2, when no recipient screen/API
-- existed yet). Split read/manage to match the granularity already used for
-- campaigns (campaign:read / campaign:manage). Granted the same way
-- 004_rbac.sql grants content:manage: admin gets every permission
-- automatically (see role_permission grant WHERE r.key = 'admin' in
-- 004_rbac.sql), operator gets recipient:read + recipient:manage (mirrors
-- its existing content:manage grant), viewer gets neither (BR-AUTH-003:
-- Viewer only views history/reports, not the recipient directory).
INSERT INTO permission (key, description) VALUES
  ('recipient:read', 'View the recipient directory, search and filters'),
  ('recipient:manage', 'Create, edit and soft-delete recipients');

INSERT INTO role_permission (role_id, permission_id)
SELECT r.id, p.id FROM role r, permission p
WHERE r.key = 'admin' AND p.key IN ('recipient:read', 'recipient:manage');

INSERT INTO role_permission (role_id, permission_id)
SELECT r.id, p.id FROM role r, permission p
WHERE r.key = 'operator' AND p.key IN ('recipient:read', 'recipient:manage');
