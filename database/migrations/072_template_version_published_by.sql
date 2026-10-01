-- Version history needs to show who published each version. audit_log has the
-- actor but falls under retention pruning, so it cannot back a history view
-- that outlives the retention window. Nullable on purpose: the actor cannot be
-- recovered for versions published before this column existed, and inventing a
-- default would be a lie in the table the system trusts for provenance.
ALTER TABLE email_template_version
  ADD COLUMN published_by uuid NULL;
