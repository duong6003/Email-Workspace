-- M4-S1 follow-up — 017's campaign_status_known CHECK only listed 6 of the
-- 10 statuses the accepted business rules actually define: BR-CMP-001
-- (draft), BR-SCH-* (scheduled), and BR-SEND-001's literal execution state
-- machine ("Campaign execution di qua queued, validating, sending, paused,
-- completed, partial_failed, failed hoac cancelled"). The gap was invisible
-- until a real M2-S1 test (recipients.test.ts, BR-REC-010) inserted a
-- campaign row with status 'queued' and hit the CHECK for the first time on
-- the newly widened table. 001_initial.sql and 017 are never edited; this
-- is a forward-only correction.

ALTER TABLE campaign DROP CONSTRAINT campaign_status_known;

ALTER TABLE campaign
  ADD CONSTRAINT campaign_status_known CHECK (status IN (
    'draft', 'scheduled',
    'queued', 'validating', 'sending', 'paused', 'completed', 'partial_failed', 'failed', 'cancelled'
  ));
