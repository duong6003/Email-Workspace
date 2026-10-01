# ADR-029: Frozen recipient envelope

Status: Accepted

## Decision

Persist the recipient SMTP envelope address in `campaign_recipient.recipient_email` as immutable snapshot data. New freezes and resends copy the address explicitly. A database insert guard fills the value from frozen merge data, or from the tenant-owned recipient row only at insert time for compatibility with existing writers. The worker sends from this frozen column and never resolves a live recipient address during delivery.

Existing rows are forward-migrated once from `merge_data_json.email`, falling back to the referenced recipient address when an older snapshot did not contain that merge key. The migration also makes the new field non-blank and extends the snapshot immutability trigger to cover it.

## Rationale

Nodemailer reports `EENVELOPE` when an envelope has no valid recipient or sender. The worker previously derived `RCPT TO` only from `merge_data_json.email`, although that JSON was designed as template merge context rather than an explicit delivery-envelope contract. Older or manually restored snapshots could therefore contain valid rendered content and a valid recipient reference but still reach SMTP with an empty recipient.

The envelope address is business state frozen at confirmation under ADR-013, just like rendered content and merge data. Making it explicit removes the hidden dependency on one JSON key, keeps resend deterministic, supports recipient-level history after live recipient edits, and avoids reading live recipient data at send time.

## Alternatives

**Join the live `recipient` row in the worker.** Rejected because an address edited after confirmation would change the destination of an already-frozen campaign and violate ADR-013.

**Continue using `merge_data_json.email` and add only a runtime null check.** Rejected because it would turn the current opaque provider failure into a clearer failure without repairing the missing envelope contract.
