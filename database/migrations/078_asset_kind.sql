-- MC-UI-005's image/logo filter bar (ADR-044 Task SV-4, SV decision 3).
--
-- `kind` is what a PERSON says this file is. It is not `content_type`, which
-- 076 constrains to four values decided by magic bytes and never by what the
-- client declared (ADR-043 §4) -- the same PNG is a logo in one tenant's brand
-- kit and a photograph in another's newsletter, and no amount of sniffing can
-- tell those apart. Two questions about one file, so two columns.
--
-- The prototype's asset library filters on exactly this (`v3-asset-filterbar`)
-- and its brand kit section (`v3-brand-kit`) is the list of the `logo` ones.
-- Neither could be built before this column existed, which is why Task SV-4 was
-- recorded as contract-blocked in the plan rather than started and abandoned.
--
-- DEFAULT 'image' does two jobs and both are wanted: it backfills every row
-- that predates this migration, and it keeps the column NOT NULL for the
-- upload path that says nothing about the file. Most uploads are pictures; a
-- logo is the exception somebody marks. The default is kept rather than dropped
-- after the backfill so that an INSERT from a code path written before this
-- column still succeeds instead of failing at 3am on a NOT NULL violation.
--
-- The CHECK is the last line, in the same spirit as 076's `content_type`: the
-- API validates first and returns 400, and this still holds if some future path
-- forgets to call the validator.
ALTER TABLE asset
  ADD COLUMN kind text NOT NULL DEFAULT 'image'
  CHECK (kind IN ('logo', 'image'));

-- The filter bar's query: a tenant's live assets of one kind, newest first.
-- Deliberately a second index rather than a replacement for
-- `idx_asset_tenant_live` (076) -- "Tất cả" is the default tab and still reads
-- that one, so dropping it would slow the common case to speed up the rarer.
CREATE INDEX idx_asset_tenant_live_kind
  ON asset (tenant_id, kind, created_at DESC) WHERE archived_at IS NULL;

-- No GRANT line. 076 already granted eow_app SELECT, INSERT and UPDATE on this
-- table, and a column added to a table whose privileges are table-wide inherits
-- them; re-granting here would suggest column-level privileges are in use,
-- which they are not. DELETE stays withheld for the reason 076 gives.
