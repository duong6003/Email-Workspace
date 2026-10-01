-- S0 template editor base: origin marks who owns the content model,
-- project_data is opaque storage for a builder's component tree, and
-- draft_revision backs optimistic concurrency on the draft.
-- draft_revision is deliberately NOT called "version": email_template_version
-- .version already means "published version number" in this module.
ALTER TABLE email_template
  ADD COLUMN origin text NOT NULL DEFAULT 'imported',
  ADD COLUMN project_data jsonb NULL,
  ADD COLUMN draft_revision integer NOT NULL DEFAULT 1;

ALTER TABLE email_template
  ADD CONSTRAINT email_template_origin_check CHECK (origin IN ('imported', 'builder'));
