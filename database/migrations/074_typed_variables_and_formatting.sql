-- 074_typed_variables_and_formatting.sql
-- ADR-036 (docs/adr/adr-036-variable-formatting-outside-the-version-snapshot.md).
--
-- A recipient custom field of type `date` is stored as
-- new Date(value).toISOString() and was substituted into templates verbatim, so
-- a customer read "2026-08-31T00:00:00.000Z" in an email body -- and a value
-- carrying a +07:00 offset rendered on the PREVIOUS calendar day. Presentation
-- is therefore declared on the variable definition (data_type / format /
-- timezone) and resolved at render time, deliberately outside the immutable
-- template version snapshot and outside content_hash.
--
-- Forward migration only: 069 published configured_variable and 007 published
-- custom_field_definition, and neither may be edited (AGENTS.md section 5).
-- Existing configured_variable rows default to 'text', which is exactly what
-- they were -- untyped free text -- so nothing about them changes.

ALTER TABLE configured_variable
  ADD COLUMN data_type text NOT NULL DEFAULT 'text',
  ADD COLUMN enum_options jsonb,
  ADD COLUMN format text,
  ADD COLUMN timezone text;

-- Same value set as custom_field_definition.data_type (007_custom_fields.sql).
-- Without a type on this side, half the variables in the system could never be
-- formatted, because nothing recorded that they were dates.
ALTER TABLE configured_variable
  ADD CONSTRAINT configured_variable_data_type_values
    CHECK (data_type IN ('text', 'number', 'date', 'boolean', 'enum')),
  ADD CONSTRAINT configured_variable_enum_options_shape
    CHECK (
      CASE WHEN data_type = 'enum'
        THEN jsonb_typeof(enum_options) = 'array' AND jsonb_array_length(enum_options) > 0
        ELSE enum_options IS NULL
      END
    ),
  ADD CONSTRAINT configured_variable_format_shape
    CHECK (format IS NULL OR (btrim(format) <> '' AND length(format) <= 40)),
  ADD CONSTRAINT configured_variable_timezone_shape
    CHECK (timezone IS NULL OR (btrim(timezone) <> '' AND length(timezone) <= 64));

COMMENT ON COLUMN configured_variable.data_type IS
  'ADR-036: closes the asymmetry with custom_field_definition. Existing rows default to text, which is what an untyped configured variable already was.';
COMMENT ON COLUMN configured_variable.format IS
  'ADR-036: presentation pattern (currently dates only, e.g. dd/MM/yyyy). NULL means the product default. Resolved at render time, never frozen into a template version and never part of content_hash.';
COMMENT ON COLUMN configured_variable.timezone IS
  'ADR-036: IANA zone this variable renders in. NULL falls back to sending_policy.default_timezone, then UTC.';

ALTER TABLE custom_field_definition
  ADD COLUMN format text,
  ADD COLUMN timezone text;

ALTER TABLE custom_field_definition
  ADD CONSTRAINT custom_field_definition_format_shape
    CHECK (format IS NULL OR (btrim(format) <> '' AND length(format) <= 40)),
  ADD CONSTRAINT custom_field_definition_timezone_shape
    CHECK (timezone IS NULL OR (btrim(timezone) <> '' AND length(timezone) <= 64));

COMMENT ON COLUMN custom_field_definition.format IS
  'ADR-036: presentation pattern for this field''s values (currently dates only). Same render-time resolution as configured_variable.format.';
COMMENT ON COLUMN custom_field_definition.timezone IS
  'ADR-036: IANA zone this field renders in. NULL falls back to sending_policy.default_timezone, then UTC.';

-- ADR-036 scope item 3. No timezone existed per tenant anywhere: `tenant` holds
-- only id/name/created_at, and the only timezone in the system was the api
-- container's process-wide TZ, shared by every tenant. sending_policy is the
-- existing per-tenant settings row, so this needs no new table.
ALTER TABLE sending_policy
  ADD COLUMN default_timezone text;

ALTER TABLE sending_policy
  ADD CONSTRAINT sending_policy_default_timezone_shape
    CHECK (default_timezone IS NULL OR (btrim(default_timezone) <> '' AND length(default_timezone) <= 64));

COMMENT ON COLUMN sending_policy.default_timezone IS
  'ADR-036: tenant default IANA zone for rendering typed variables. NULL keeps the pre-ADR-036 behaviour (UTC). Distinct from campaign.scheduled_timezone, which records when a send fires, not how a value reads.';
