# ADR-028: Feature-gap ownership, defaults and reconciliation contracts

Status: Accepted

## Decision

Campaign drafts use `created_by` as their immutable owner. Draft listing defaults
to the authenticated user's drafts; an explicit `scope=all` is available only to
Admin users holding `settings:manage`. Draft edit and delete are owner-only unless
the caller holds `settings:manage`; duplication creates a new draft owned by the
caller. Ownership reassignment remains a separately auditable administrative
action and is not implicit when a user is disabled.

Opening `/email/compose` without a draft id creates a usable draft immediately
with a generated local name. Sender resolution is deterministic: an explicitly
selected verified and active sender wins; otherwise the tenant's verified default
sender is copied into the draft; otherwise the draft remains editable but
send/schedule preflight blocks with `SENDER_REQUIRED`. Confirmation continues to
freeze the selected sender and policy in the immutable campaign snapshot under
ADR-013.

HTTP failures keep RFC 9457 fields and add a stable application contract: `code`,
`category`, `messageKey`, `retryable`, optional `fieldErrors`, optional
`nextAction`, and `traceId`. Explicit domain codes are preserved. Uncoded
exceptions receive stable HTTP-derived codes and safe public detail. The web maps
codes centrally to Vietnamese copy/actions and treats unknown codes safely while
retaining the trace id.

Template import analysis is additive and occurs before persistence/publish. It
reports sanitized-content warnings and variable occurrences with field and
character offsets; unknown variables remain blocking at publish. Sample import
artifacts are versioned application assets and are safe to download without tenant
data.

Notification rows remain authoritative under ADR-011. After a notification
transaction commits, the API publishes versioned `notification.created`,
`notification.updated`, or `notification.read` hints to each affected user's
realtime room. The shell responds with targeted REST reconciliation; reconnect
also reconciles. Socket payloads never replace durable state.

Preflight results distinguish blocking errors from warnings. Sender usability,
required variables, audience eligibility, unsubscribe policy and quota are
blocking; content-quality and domain-readiness findings may be warnings only when
an accepted business rule does not require blocking.

## Rationale

This closes ambiguous UI behavior without changing the accepted campaign
snapshot, tenant-isolation, realtime-consistency or durable-notification
decisions. Immutable ownership provides a stable authorization boundary, while
explicit Admin scope prevents the existing tenant-wide draft list from being
mislabeled as personal. Applying the verified default at draft creation makes
compose immediately useful without silently substituting a sender at execution
time.

## Recovery

All API additions are backward-compatible. The ownership migration backfills
`owner_id` from `created_by`; rows without a creator remain Admin-visible and
cannot be mutated by non-Admin users until explicitly reassigned. Realtime
publication can be disabled without losing notifications because REST remains
authoritative. Sample artifacts are static and can be removed independently.

## Alternatives

Tenant-wide drafts for every Operator were rejected because they violate the
requested "my drafts" semantics and make ownership unenforceable. Choosing any
verified sender at send time was rejected because it breaks deterministic review
and snapshot expectations. Treating socket payloads as state was rejected by
ADR-010. Returning raw backend exception text was rejected because it is unstable,
difficult to localize and can expose internals.
