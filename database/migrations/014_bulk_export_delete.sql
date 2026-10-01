-- Forward migration for BR-REC-009: bulk export and recipient soft-delete
-- share the existing durable bulk-job snapshot/checkpoint pipeline.
-- Never edit the published 008 constraint; replace it with a forward change.

ALTER TABLE bulk_job
  DROP CONSTRAINT IF EXISTS bulk_job_action_check;

ALTER TABLE bulk_job
  ADD CONSTRAINT bulk_job_action_check
  CHECK (action IN ('add_tag', 'remove_tag', 'add_list', 'remove_list', 'set_custom_data', 'export', 'delete'));
