# Feature Gap Remediation — Remaining Ownership

Run: `2026-08-20-feature-gap-remediation`

This checkpoint closes the gaps that have accepted semantics and executable
verification. The items below are deliberately re-owned rather than silently
implemented because their remaining behavior changes product, security,
provider or compliance meaning.

## Re-owned gaps

| Gap | Current evidence | Remaining decision/work | Owner | Next node |
| --- | --- | --- | --- | --- |
| `GAP-ORG-003` | Campaign drafts have immutable `created_by` ownership, owner-scoped listing and Admin all-drafts access. | Define an auditable reassignment operation and behavior when an owner is disabled; extend the model consistently to templates and lists. | Product + Backend | Organization administration / ownership reassignment |
| `GAP-IMP-003` | Recipient import mapping resumes for 24 hours from a SHA-256 file fingerprint and rejects a changed file. | Persist the dry-run draft and audit trail server-side instead of only in browser storage. | Backend | Import draft persistence |
| `GAP-SND-001` | Preflight explicitly reports `DOMAIN_READINESS_UNVERIFIED`; it does not claim SPF/DKIM/DMARC success without evidence. | Select DNS/provider authority, freshness rules and blocking thresholds, then model sending-domain verification. | Product + Backend + SRE | Domain readiness adapter |
| `GAP-SND-005` | Sender secrets are write-only and can be replaced without revealing the old secret. | Define versioned secret references, test-before-activate, grace period, expiry warnings and rollback/revocation policy. | Security + SRE | Credential rotation lifecycle |
| `GAP-SND-008` | `unsubscribe_url` remains a recognized variable, but no public endpoint is presented as safe. | Approve token lifetime, signing/rotation, confirmation UX, immediate suppression transaction and send/unsubscribe race semantics before implementation. | Product + Security + Backend + Frontend | Signed unsubscribe capability |

`GAP-SND-008` is an explicit STOP-gate item under the approved plan: inventing
unsubscribe/compliance semantics without an owner decision would be less safe
than keeping send policy visibly incomplete. Until that node lands, domain
readiness and unsubscribe policy must not be represented as verified.

## Closed in this checkpoint

- `GAP-CMP-004`: authoritative send/schedule preflight with blocking sender,
  template, audience, variable and quota checks plus content/domain warnings.
- `GAP-COL-002`: two-tab conflicts preserve the local patch, fetch the latest
  server draft, show field-level server/local values and offer explicit discard
  or rebase actions.
- `GAP-TPL-002`: template analysis and campaign preflight lint missing text,
  image alt text, missing/placeholder/invalid links and oversized HTML.
- `GAP-AUD-005`: deletion is blocked when an active draft or immutable
  published version references the exact custom-field key.
- `GAP-NOT-002/004/005/006`: trigger recipients, preferences, action state and
  message-key/parameter persistence are implemented and realtime remains a hint.
- `GAP-UX-001/002/004`: global offline/reconnecting visibility, durable job
  deep links and polite live announcements are present without focus theft.

## Verification boundary

Screenshot capture at `1440x900`, `768x1024` and `390x844` was explicitly
excluded by the user. Automated web/API/contract/build checks remain required;
this run does not claim screenshot-based visual equivalence evidence.

## Release follow-up

- The production dependency audit has no high or critical findings after
  upgrading API and worker SMTP delivery to `nodemailer@9.0.1`.
- One moderate transitive `uuid@8.3.2` advisory remains through `exceljs`.
  Dependency maintenance owns the upgrade path; recipient spreadsheet import
  remains covered by the executed parser and integration suites.
- The web production build still reports a non-blocking large-chunk warning.
  Frontend performance owns future route-level code splitting; this is not a
  correctness or deployment-health failure.
