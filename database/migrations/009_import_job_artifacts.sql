-- Forward migration for M2-S4 import intake completion. Never edits 001-008.
--
-- Import rows are durable checkpoints, but reconstructing a job after a
-- worker restart also requires the approved column mapping and a durable
-- result/error-file reference. Keeping both on the authoritative job row
-- lets GET /import-jobs/{id} reconcile a realtime hint without trusting a
-- socket payload or an in-memory worker object.

ALTER TABLE import_job
  ADD COLUMN mapping_json jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN source_file_ref text,
  ADD COLUMN result_file_ref text;

