-- Forward migration for M2-S3 (Custom fields). Never edits 001-006.
--
-- IMPORTANT DISCOVERY (see EXECPLAN Decision Log DEC-033): 001_initial.sql
-- (the published baseline) already creates `custom_field_definition`
-- (id, tenant_id, field_key, label, data_type, required,
-- UNIQUE(tenant_id, field_key)) and `recipient_custom_value`
-- (tenant_id, recipient_id, field_id -> custom_field_definition(id),
-- value_json jsonb, PK(recipient_id, field_id)). Neither table was
-- mentioned by 006_recipient_extensions.sql's own comment (which described
-- `recipient.custom_data jsonb` as a from-scratch "custom-fields feature
-- placeholder") nor by this run's earlier planning docs -- a real, previously
-- undiscovered gap in both. This migration extends the *existing*
-- custom_field_definition table (same forward-alter pattern
-- 006_recipient_extensions.sql already used on `recipient`) rather than
-- creating a duplicate table.
--
-- BR-CF-001 (definition): field_key already unique per tenant
-- (custom_field_definition_tenant_id_field_key_key, from 001). Adds the
-- ^[a-z][a-z0-9_]*$ format constraint. Immutability of field_key after
-- creation is enforced at the application layer (the PATCH DTO never
-- accepts a field_key change) -- there is no natural SQL constraint for
-- "this column may be set once".
-- BR-CF-002 (typed values): adds a CHECK restricting data_type to
-- text/number/date/boolean/enum, and default_value/enum_options jsonb
-- columns so a default or an enum option keeps its real type instead of
-- being forced through text.
-- BR-CF-003 (system fields protected): adds a CHECK rejecting the four
-- reserved keys (email, first_name, last_name, unsubscribe_url) at the
-- database level -- defence in depth under the application-level 422 the
-- API returns first (with the reserved-key list in the Problem body).
-- BR-CF-009 (audit): custom_field_definition mutations are audited via the
-- existing @AuditLog convention (custom-field.created|updated|deleted).
-- `sensitive` flags a field whose recipient-level *value* is masked
-- ("***") in the audit_log row apps/api/src/recipients/recipients.service.ts
-- writes when a recipient's custom_data changes that key.
--
-- Value storage decision: this slice stores recipient-level custom-field
-- values in `recipient.custom_data` jsonb (the placeholder
-- 006_recipient_extensions.sql already added and that M2-S1's Recipient
-- API contract -- GET/POST/PATCH /recipients's `customData` field -- is
-- already built against), NOT the pre-existing `recipient_custom_value`
-- table. Reading N `recipient_custom_value` rows per recipient would mean
-- either a per-row query or a join on every /recipients list page
-- (BR-REC-007/008 pagination), and would require reworking M2-S1's
-- already-shipped read/write paths. `recipient_custom_value` is left
-- present and unused; it remains available for a future migration if
-- per-field typed indexing/filtering becomes a real requirement.
-- See DEC-033 for the full reasoning and the rejected alternative.

ALTER TABLE custom_field_definition
  ADD COLUMN default_value jsonb,
  ADD COLUMN enum_options jsonb,
  ADD COLUMN sensitive boolean NOT NULL DEFAULT false,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE custom_field_definition
  ADD CONSTRAINT custom_field_definition_key_format_check
    CHECK (field_key ~ '^[a-z][a-z0-9_]*$'),
  ADD CONSTRAINT custom_field_definition_type_check
    CHECK (data_type IN ('text', 'number', 'date', 'boolean', 'enum')),
  ADD CONSTRAINT custom_field_definition_reserved_key_check
    CHECK (field_key NOT IN ('email', 'first_name', 'last_name', 'unsubscribe_url')),
  ADD CONSTRAINT custom_field_definition_enum_options_check
    CHECK (data_type = 'enum' OR enum_options IS NULL);

-- Mutations use the already-seeded settings:manage permission (admin-only,
-- 004_rbac.sql) -- this is an admin schema-defining action, the same
-- granularity settings:manage already covers for sender configuration, so
-- no new permission key is introduced. Reads use the already-seeded
-- recipient:read permission (006_recipient_extensions.sql, admin +
-- operator) since the field list must be visible wherever recipient data
-- is entered/viewed, not only to admins.
