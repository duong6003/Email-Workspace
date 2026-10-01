# Feature Gap Remediation Execution Plan

Run: `2026-08-20-feature-gap-remediation`

## Handoff Objective

Implement and verify the missing or defective capabilities identified in the
2026-08-20 feature audit. The next session must start from
`feature-gap-remediation.state.json`, not re-derive the scope from chat history.

Primary user-visible outcomes:

1. Clicking the compose entry opens a real compose workflow immediately.
2. Drafts are durable, discoverable and correctly scoped as "my drafts" or
   tenant-wide drafts.
3. Sender configuration is selectable while composing and editable in settings.
4. API/frontend errors are machine-readable, localized and actionable.
5. Template import explains unknown custom variables and offers repair actions.
6. Recipient and template import flows provide safe downloadable sample files.
7. Template cards open an immediate preview.
8. Notification events update the shell in realtime without breaking the badge.
9. Preflight, conflict, offline, long-job and release-quality gaps are closed or
   explicitly re-owned with evidence.

## Authority And Constraints

Read before implementation:

- `AGENTS.md`
- `project.manifest.yaml`
- `docs/00-start-here.md`
- `design-reference/ui-source-contract.yaml`
- `design-reference/visual-acceptance.md`
- `.agents/orchestration-policy.yaml`
- `.agents/approval-policy.yaml`
- `.agents/agent-graph.yaml`
- `docs/index.yaml`
- `catalog/ba-rules.json`
- `catalog/open-decisions.json`
- `catalog/business-gaps.json`
- `contracts/openapi.yaml`
- `contracts/asyncapi.yaml`
- `docs/architecture/realtime-and-notification.md`
- `docs/delivery/definition-of-done.md`

The UI handoff controls presentation and interaction baseline. Business rules
control behavior. Do not redesign approved screens silently. Run
`python scripts/ui_handoff.py status` and inventory changed screens before
frontend edits.

## Graph

### Node A: Architecture and contract decisions

Dependencies: intake.

Resolve or record:

- draft ownership and Admin/Operator visibility/reassignment;
- direct compose behavior: auto-create draft versus inline name;
- sender precedence: explicit campaign sender, tenant default or blocked send;
- stable error code namespace, category, retryability, field errors, trace ID,
  message key and next action;
- template import analysis timing and repair semantics;
- sample artifact formats/versioning;
- realtime notification event, cursor/resync and ownership behavior;
- preflight blocking versus warning semantics.

If a choice changes an accepted ADR, create a superseding ADR. If tenant
isolation, snapshot semantics or notification durability changes, an ADR is
mandatory before implementation.

Outputs: decision record/ADR references, additive API event design, migration
allocation, file ownership map and traceability updates.

### Node B: Standard error contract

Dependencies: Node A.

Affected files include:

- `apps/api/src/common/problem.ts`
- `apps/api/src/common/http-exception.filter.ts`
- `apps/web/src/api/problem.ts`
- `contracts/openapi.yaml`

Target fields:

```json
{
  "code": "TEMPLATE_UNKNOWN_VARIABLE",
  "category": "validation",
  "messageKey": "template.unknownVariable",
  "detail": "Template contains variables that do not exist.",
  "fieldErrors": [
    { "field": "html", "code": "UNKNOWN_VARIABLE", "value": "customer_tier" }
  ],
  "retryable": false,
  "nextAction": "OPEN_CUSTOM_FIELDS",
  "traceId": "..."
}
```

Requirements:

- API always emits a stable `code`;
- raw internal exception text is never exposed;
- frontend has centralized code-to-copy/action mapping;
- unknown codes degrade safely and retain trace ID;
- validation, conflict, permission, rate-limit, network and retryable server
  failures render distinct UI states;
- tests cover 400, 401, 403, 404, 409, 422, 429 and 5xx.

### Node C: Sender configuration management

Dependencies: Nodes A and B.

Reuse the existing backend:

- `GET/POST/PATCH/DELETE /sender-configs`;
- `POST /sender-configs/{id}/test-connection`;
- `GET/PUT /sending-policy`.

Add the missing web workflow:

- edit overlay using `updateSenderConfig`;
- safe secret rotation without showing the old secret;
- disable confirmation and affected-campaign messaging;
- pending, verified, failed and disabled states;
- typed connection failure and retry;
- functional search/filter;
- tests for create/edit/test/disable/permission/error.

Business requirements:

- only verified and active senders can be used;
- sender identity cannot be spoofed;
- history keeps sender snapshot;
- disabled sender cannot be used by new sends;
- domain authentication status remains an explicit follow-up if unavailable.

### Node D: Compose and drafts

Dependencies: Nodes A, B and C.

Frontend:

- Email CTA opens compose directly;
- create/resume draft without unexplained intermediate screen;
- explicit sender, audience, template, subject and content steps;
- real verified-sender picker;
- "Bản nháp của tôi" and authorized "Tất cả bản nháp";
- loading, empty, permission, conflict, offline and autosave states;
- local edit preservation on 412/version conflicts;
- clear save, preview, test send, schedule/send actions.

Backend:

- owner-aware draft query;
- immutable owner or explicit owner model;
- server-side edit/delete authorization;
- preserve `If-Match`/version semantics;
- apply default sender policy on draft initialization;
- ensure displayed sender equals snapshot sender.

Acceptance:

- one click reaches a usable composer;
- draft close/reopen/find works for the correct owner;
- two-tab conflict is recoverable;
- selected sender is visible in confirmation and snapshot.

### Node E: Template import, variable repair and preview

Frontend:

- import preflight for sanitize and variables;
- distinguish system, known custom and unknown variables;
- show key, field, location/context and suggested repair;
- create/select custom field, rename/remove token or return to edit;
- card click opens preview; `...` owns management actions;
- preview draft/published content with sample data and missing-data state;
- desktop/mobile rendering and sanitized HTML;
- lint size, links, images, alt text and severity.

Backend/contract:

- additive analysis/preview contract where existing responses are insufficient;
- keep strict publish blocking for unknown variables;
- return machine-readable variable key, field, position/context and safe
  known-field catalogue;
- keep published versions immutable.

### Node F: Import samples and resumable jobs

Add downloadable:

- recipient CSV;
- recipient XLSX;
- HTML template;
- variable/catalogue reference.

Document required/optional columns, custom fields, encoding, delimiter,
limits, upsert behavior and valid/invalid examples.

Job UX:

- resumable bounded mapping/preview;
- file fingerprint and changed-file rejection;
- preserved error-file download;
- notification/activity links for long-running jobs;
- tenant and role restrictions on artifacts.

### Node G: Notification and realtime completion

Backend:

- publish `notification.created`, `notification.updated` and
  `notification.read` after durable persistence;
- preserve dedup/batching;
- correct mark-all-read metrics;
- explicit trigger ownership/action state;
- deep-link permission/target checks.

Frontend:

- subscribe from authenticated shell;
- socket events trigger targeted REST reconciliation;
- reconnect refetches unread state;
- badge updates immediately and caps at `99+`;
- dedicated badge CSS with fixed dimensions and mobile behavior;
- meaningful `aria-live` only, without focus theft;
- visible stale/reconnecting states.

### Node H: Business hardening

Close or explicitly re-own:

- `GAP-CMP-004` preflight checklist;
- `GAP-ORG-003` ownership/reassignment;
- `GAP-COL-002` conflict diff/merge;
- `GAP-IMP-003` dry-run persistence;
- `GAP-TPL-002` content lint;
- `GAP-AUD-005` custom-field dependency protection;
- `GAP-SND-001` SPF/DKIM/DMARC readiness;
- `GAP-SND-005` credential rotation;
- `GAP-SND-008` signed unsubscribe;
- `GAP-NOT-002/004/005/006` notification ownership/preferences/action/localization;
- `GAP-UX-001/002/004` offline, long-job activity and accessible live updates.

No gap is closed without rule, contract, code, test and observability evidence.

### Node I: Integration, visual QA and release repair

Run focused tests, tenant/permission/idempotency/snapshot/reconnect tests,
OpenAPI/AsyncAPI compatibility, migration idempotence, UI visual checks at
1440x900, 768x1024 and 390x844, accessibility checks, Compose validation and
deployment smoke where Docker is available.

Recheck prior audit blockers:

- clean-checkout root typecheck ordering;
- `validate_bundle.py` handoff placeholder expectation;
- worker test discovery without `.env`;
- Docker Compose v2 migration runner;
- dependency audit findings;
- incomplete M7-S5 and traceability rows.

## Parallelization

After Node B, these may run in parallel if shared files are locked:

- Node C sender configuration;
- Node E template import/preview;
- Node F import samples/jobs;
- Node G notifications/realtime.

Node D waits for sender. Node H waits for all user-visible branches. Node I is
serial.

Do not concurrently edit:

- `contracts/openapi.yaml`;
- `contracts/asyncapi.yaml`;
- `apps/web/src/app/AppShell.tsx`;
- shared problem/error files;
- migration numbering;
- traceability files;
- shared CSS without explicit ownership.

## Checkpoint Protocol

Every implementation node:

1. Write RED tests first.
2. Implement one vertical slice.
3. Run narrow verification.
4. Run the relevant workspace check.
5. Compare test and skip counts with the previous checkpoint.
6. Update state and traceability.
7. Commit the checkpoint without amending other commits.

Suggested subjects:

- `feature-gap CP1: standardize problem error contract`
- `feature-gap CP2: complete sender configuration actions`
- `feature-gap CP3: direct compose and owned drafts`
- `feature-gap CP4: guided template import and preview`
- `feature-gap CP5: import samples and resumable jobs`
- `feature-gap CP6: realtime notification synchronization`
- `feature-gap CP7: close business hardening gaps`
- `feature-gap CP8: integration and release verification`

## STOP Gates

Persist state and stop if a business decision changes accepted semantics,
real credentials/external provider access is required, a published migration
would need editing, production/destructive action is requested, security/
privacy/compliance/unsubscribe semantics are ambiguous, or repair budget is
exhausted without new evidence.

## Definition Of Done

Complete only when all nine user issues are fixed and usable, related P0/P1
gaps are closed or re-owned, contracts/migrations/frontend agree, errors are
actionable, sender/template/draft/snapshot invariants hold, notifications are
durable and realtime is only a hint, checks pass with zero unexplained skips,
packaging remains valid, traceability/docs are updated and state is terminal.
