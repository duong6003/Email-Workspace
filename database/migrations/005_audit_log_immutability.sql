-- Forward migration for M1-S3 (Audit and errors). Never edits 001-004.
--
-- BR-SEC-002: "Ghi immutable audit cho login, config, ..." (write *immutable*
-- audit for login, config, ...). audit_log has existed since 001_initial.sql,
-- but nothing enforced the "immutable" half of the rule at the only layer
-- that can actually guarantee it -- an application bug or a future migration
-- author could otherwise UPDATE or DELETE a row and no test would catch it.
-- A BEFORE trigger that rejects both operations closes that real gap.

CREATE OR REPLACE FUNCTION reject_audit_log_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log rows are immutable (BR-SEC-002): % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_immutable
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION reject_audit_log_mutation();
