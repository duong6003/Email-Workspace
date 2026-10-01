# M7-S2 security-hardening checkpoint inbox

## Checkpoint 0 — baseline
**Status after this checkpoint:** running
**nextAction:** Build and commit the deliberately RED `ARCH-CROSS-TENANT` coverage rule for Checkpoint 1.

### Evidence (verbatim, for state.json)
- `pnpm --filter @eow/api build` exited 0 on Node v22.13.0 and pnpm v11.21.0.
- The first `pnpm check` reached all 89 API files / 649 API tests with 0 skipped, then reproduced a pre-existing worker timing failure: `apps/worker/src/campaign-send/send.integration.test.ts:476` observed 2 progress publications where the assertion requires at least 3. The targeted rerun reproduced the same `2 >= 3` failure. This is outside M7-S2's write scope (`apps/worker/src/campaign-send/**` belongs to M7-S1/M7-S3), so no repair was attempted.
- The baseline API package without the collection probe is 89 files / 649 tests. The temporary `apps/api/test/security/collection-probe.test.ts` ran as 1 file / 1 test, and the whole API package then reported 90 files / 650 tests, proving the directory is collected by Vitest's default include. The probe was deleted before this checkpoint commit.
- The whole-package probe run encountered one shared-database teardown deadlock in `campaign-export-download.test.ts`; all 650 tests themselves passed. This is consistent with the protocol's shared-database concurrency hazard and is not a product assertion failure.
- D-146: `apps/worker/src/outbox-relay.ts:35-38` and `:65-68` increment `outbox_event.attempts` and rethrow immediately, aborting the rest of the relay batch. `published_at` stays NULL so `relay_pending_outbox_events()` re-selects the row every 60s tick forever; there is no attempts ceiling, no dead-letter transition and no alert. A single poison event loops indefinitely AND blocks every event behind it in the same batch, silently. Owned by BR-SEC-007; fixed at CP7.

### traceability.csv rows to update
| rule_id | slice | openapi_operation_ids | asyncapi_channels | migration_files | code_paths | test_case_ids | test_files | log_or_metric_or_audit | status |
|---|---|---|---|---|---|---|---|---|---|
| BR-SEC-001 | M7-S2 security baseline intake |  |  |  |  | TC-SEC-001, TC-SEC-013 |  |  | running |
| BR-SEC-003 | M7-S2 payload, expiry, injection and XSS half |  |  |  |  | TC-SEC-003, TC-SEC-013, TC-SEC-014, TC-CFG-008 |  |  | running |
| BR-SEC-007 | M7-S2 DLQ and controlled replay |  |  |  | apps/worker/src/outbox-relay.ts | TC-SEC-007, TC-SEC-010, TC-SEND-018 |  |  | running |

### screen-catalog.yaml changes
- None. This node must not touch UI files, screenshots, or visual state evidence.

### EXECPLAN entries
- D-146: Poison outbox rows loop forever and abort each relay batch; reproduced from the source at CP0 and scheduled for a RED runtime reproduction at CP7.
- Baseline discrepancy: the plan expected `pnpm check` exit 0, but the quiet-window run reproduced a pre-existing M6-S1 progress-throttle assertion failure outside this node's ownership. API baseline counts remain usable; full-suite closure must compare against this recorded discrepancy.

## Checkpoint 1 — ARCH-CROSS-TENANT measurable coverage rule
**Status after this checkpoint:** running
**nextAction:** Add the runtime cross-tenant matrix and close all 79 measured route gaps at Checkpoint 2.

### Evidence (verbatim, for state.json)
- Created `packages/architecture-tests/src/cross-tenant-coverage.test.ts`, using the existing architecture-suite repository helpers and controller-route enumeration pattern.
- `cd packages/architecture-tests && ./node_modules/.bin/vitest run src/cross-tenant-coverage.test.ts --reporter=default` is deliberately RED: 1 test failed, 1 passed, 0 skipped.
- The scanner found 95 distinct controller method/path pairs. Eight entries are explicitly reasoned in `PUBLIC_OR_TENANTLESS` (health, six auth/session routes, and the HMAC provider webhook). Existing route-specific negatives cover eight more. The measured gap is 79 tenant-owned routes.
- The exact RED worklist is preserved in `/tmp/m7-s2-cp1-red.log` during this run and is reproduced in the CP1 commit diff/test output. It spans tenant-owned campaign, export, custom-field, import/bulk-job, notification, recipient, segment, sender-config, sending-policy, and template operations.
- The matcher was validated against two bounds: it did not collapse the 95 controller routes into a small placeholder set, and it recognized existing negatives including campaign schedule, export download, recipients, and audience preview while still reporting a plausible broad gap.

### traceability.csv rows to update
| rule_id | slice | openapi_operation_ids | asyncapi_channels | migration_files | code_paths | test_case_ids | test_files | log_or_metric_or_audit | status |
|---|---|---|---|---|---|---|---|---|---|
| BR-GEN-002 | mechanical cross-tenant route coverage |  |  |  | packages/architecture-tests/src/cross-tenant-coverage.test.ts | TC-SEC-009 | packages/architecture-tests/src/cross-tenant-coverage.test.ts | ARCH-CROSS-TENANT | running |

### screen-catalog.yaml changes
- None. This checkpoint is API/architecture-only.

### EXECPLAN entries
- DEC-151: Enforce the every-tenant-owned-endpoint claim with `ARCH-CROSS-TENANT`; a reasoned `PUBLIC_OR_TENANTLESS` list is the only exception mechanism. Alternative rejected: an unparsed prose checklist that can drift from the controller surface.
- D-147: The first mechanical scan found 79 tenant-owned controller routes with no route-specific cross-tenant negative evidence. This is the measured CP2 worklist, not an estimate.

## Checkpoint 2 — cross-tenant matrix closes the measured gap
**Status after this checkpoint:** running
**nextAction:** Implement the plaintext-secret scan and written/asserted TLS policy at Checkpoint 3.

### Evidence (verbatim, for state.json)
- `cd apps/api && ./node_modules/.bin/vitest run test/security/cross-tenant-matrix.test.ts --reporter=default` passed: 1 file, 79 tests, 0 skipped.
- `cd packages/architecture-tests && ./node_modules/.bin/vitest run src/cross-tenant-coverage.test.ts --reporter=default` passed: 1 file, 2 tests, 0 skipped.
- `ARCH-CROSS-TENANT` moved from 79 uncovered routes at CP1 to 0. The architecture rule enumerates 95 distinct controller routes; eight are reasoned `PUBLIC_OR_TENANTLESS` entries, and all remaining routes now have route-specific cross-tenant evidence.
- Every matrix case uses a tenant-A session while substituting a tenant-B user UUID into every identifier slot, checks that no response reaches 500, scans the response for tenant B's UUID and planted marker, and proves tenant B's fixture row is byte-identical afterwards.
- Collection and tenant-wide mutation routes are allowed to succeed only against tenant A's empty scope (`200`/`204`); item routes must return an explicit safe status. No route returned 500 and no response disclosed tenant B's UUID or marker.
- The first runtime pass exposed an assertion-design discrepancy rather than a product defect: tenant-scoped list/read-all routes legitimately return success for tenant A while excluding tenant B. The matrix now records this distinction instead of treating every safe list response as a failure.

### traceability.csv rows to update
| rule_id | slice | openapi_operation_ids | asyncapi_channels | migration_files | code_paths | test_case_ids | test_files | log_or_metric_or_audit | status |
|---|---|---|---|---|---|---|---|---|---|
| BR-GEN-002 | every tenant-owned HTTP route | all tenant-owned operations |  |  | packages/architecture-tests/src/cross-tenant-coverage.test.ts | TC-SEC-009 | apps/api/test/security/cross-tenant-matrix.test.ts, packages/architecture-tests/src/cross-tenant-coverage.test.ts | ARCH-CROSS-TENANT | test_passing |

### screen-catalog.yaml changes
- None. API-only security evidence.

### EXECPLAN entries
- D-147 resolved: 79 uncovered routes -> 0; 79 runtime negatives and two architecture assertions pass.
- DEC-152: Tenant-scoped collection/read-all routes may safely return `200`/`204` for tenant A when the response excludes tenant B; item routes require a safe rejection. Alternative rejected: asserting `{403,404}` for list routes, which would incorrectly reject valid tenant-scoped empty results.

## Checkpoint 3 — plaintext-secret scan and TLS policy
**Status after this checkpoint:** running
**nextAction:** Add SQL/NoSQL injection and stored-XSS negatives at Checkpoint 4.

### Evidence (verbatim, for state.json)
- `cd apps/api && ./node_modules/.bin/vitest run test/security/secret-exposure.test.ts test/security/tls-policy.test.ts src/auth/cookies.test.ts --reporter=default` passed: 3 files, 10 tests, 0 skipped.
- `TC-CFG-008` creates a sender configuration with a random planted SMTP secret, proves create/list/get and connection-test responses never contain it, and proves only a masked `secretRef` is returned.
- `TC-SEC-001` enumerates every public base-table text/varchar/jsonb column from `information_schema` and proves none stores the planted secret. Catalogue-derived identifiers are interpolated; the searched secret remains a `$1` parameter.
- Sender audit metadata is scanned and contains no planted secret.
- `docs/operations/security-baseline.md` now states an edge-termination policy: TLS 1.2 minimum, TLS 1.3 preferred, HTTPS outside developer workstations, `X-Forwarded-Proto`, HTTPS `WEB_ORIGIN`, HSTS rollout, certificate monitoring, and rollback boundaries.
- A real HTTPS-origin login proves the session cookie is `Secure`, `HttpOnly`, and `SameSite=Lax`. The first RED run found `cookies.ts` captured `WEB_ORIGIN` at module import, making later validated configuration changes invisible; the fix derives `Secure` when each cookie is issued.
- D-148: `EnvSecretStore` is an in-process `Map`, instantiated per application service, not shared with the worker, and not durable across restart. `secret-store.ts` documents it as local-only. This is a production-readiness gap outside BR-SEC-001's accepted scan/TLS scope; disclosed, not fixed.

### traceability.csv rows to update
| rule_id | slice | openapi_operation_ids | asyncapi_channels | migration_files | code_paths | test_case_ids | test_files | log_or_metric_or_audit | status |
|---|---|---|---|---|---|---|---|---|---|
| BR-SEC-001 | plaintext-secret scan and TLS policy | createSenderConfig, listSenderConfigs, getSenderConfig, testSenderConnection, login |  |  | apps/api/src/auth/cookies.ts, docs/operations/security-baseline.md | TC-SEC-001, TC-SEC-013 | apps/api/test/security/secret-exposure.test.ts, apps/api/test/security/tls-policy.test.ts | sender_config audit metadata scan | test_passing |
| BR-SEC-003 | sender response/error payload half | createSenderConfig, listSenderConfigs, getSenderConfig, testSenderConnection |  |  |  | TC-CFG-008 | apps/api/test/security/secret-exposure.test.ts | sender_config audit metadata scan | running |

### screen-catalog.yaml changes
- None. The UI half of `TC-CFG-008` remains deferred to M7-S5.

### EXECPLAN entries
- D-148: The local `EnvSecretStore` is per-process and non-durable; replace it with a shared managed secret store before production credentials.
- DEC-153: TLS terminates at a managed edge; the application asserts `Secure` cookies from HTTPS `WEB_ORIGIN` and trusts the edge to carry `X-Forwarded-Proto`. Alternative rejected: claiming the current plain-HTTP Nginx origin itself satisfies production TLS.
- D-149: Cookie security was computed once at module import, so a validated runtime `WEB_ORIGIN` change could issue a stale cookie policy. Fixed by deriving `secure` at cookie-issuance time; 10 targeted tests pass.

## Checkpoint 4 — injection and stored-XSS negatives
**Status after this checkpoint:** running
**nextAction:** Add PII payload and export-expiry evidence at Checkpoint 5.

### Evidence (verbatim, for state.json)
- `cd apps/api && ./node_modules/.bin/vitest run test/security/injection.test.ts test/security/stored-xss.test.ts src/templates/template-variable-renderer.test.ts src/campaigns/export-render.test.ts --reporter=default` passed: 4 files, 36 tests, 0 skipped.
- `cd packages/architecture-tests && ./node_modules/.bin/vitest run src/export-render-parity.test.ts --reporter=default` passed: 1 file, 3 tests, 0 skipped.
- Six SQL/NoSQL-shaped payloads were exercised across recipient search, campaign-history search, and recipient-list/tag search. Every response was bounded to 200/400, none returned 500, no SQL fragment or stack frame leaked, and the seeded recipient count remained unchanged.
- Stored recipient and custom-field values containing `<img onerror>`, `<svg/onload>`, and attribute-breaking payloads are escaped at the actual email HTML render boundary by `renderTemplateVariables`.
- The first RED stored-XSS run confirmed HTML escaping already existed; its failed assertion was overly broad because inert encoded text may still contain the literal word `onerror`. The corrected assertion proves active tags/quotes are encoded and the raw payload is absent.
- D-150: CSV exports did not neutralize spreadsheet formula prefixes (`=`, `+`, `-`, `@`). Both API and worker renderers now prefix those cells with an apostrophe; `ARCH-EXPORT-PARITY` remains green.

### traceability.csv rows to update
| rule_id | slice | openapi_operation_ids | asyncapi_channels | migration_files | code_paths | test_case_ids | test_files | log_or_metric_or_audit | status |
|---|---|---|---|---|---|---|---|---|---|
| BR-SEC-001 | injection negatives | listRecipients, listCampaignHistory, listRecipientLists, listTags |  |  |  | TC-SEC-013 | apps/api/test/security/injection.test.ts | Problem bodies contain no SQL/stack | test_passing |
| BR-SEC-003 | injection, stored-XSS and formula-injection half | listRecipients, listCampaignHistory, listRecipientLists, listTags |  |  | apps/api/src/campaigns/export-render.ts, apps/worker/src/export-processor.ts | TC-SEC-013, TC-SEC-014 | apps/api/test/security/injection.test.ts, apps/api/test/security/stored-xss.test.ts, apps/api/src/campaigns/export-render.test.ts |  | running |

### screen-catalog.yaml changes
- None. `TC-SEC-014`'s UI rendering half remains deferred to M7-S5.

### EXECPLAN entries
- D-150: CSV cells beginning with spreadsheet formula markers were emitted verbatim. Fixed in both export-render transliterations and protected by `ARCH-EXPORT-PARITY`.
- DEC-154: Stored-XSS evidence is asserted at the email-render boundary, not by rejecting storage of inert text. Alternative rejected: stripping recipient/custom-field input, which would change business data and still miss context-specific encoding.

## Checkpoint 5 — PII payload scan and export expiry
**Status after this checkpoint:** running
**nextAction:** Add session-fixation and per-route CSRF negatives at Checkpoint 6.

### Evidence (verbatim, for state.json)
- `cd apps/api && ./node_modules/.bin/vitest run test/security/pii-payload.test.ts test/integration/campaign-export-download.test.ts --reporter=default` passed: 2 files, 12 tests, 0 skipped.
- Six malformed authenticated requests plant a recipient email, recipient custom value, and email-body marker in bodies across recipients, templates, imports, bulk jobs, exports, and custom fields. Every resulting Problem body omits all three markers and all stack-frame shapes.
- A completed export with an expired `expires_at` and already-purged `artifact_bytes = NULL` returns `410 Gone`, proving the D-131 ordering: expiry is checked before payload presence, so purge cannot turn expiry into a misleading 404.
- The existing export-download suite remains 5/5, including the viewer `403` and cross-tenant `404` cases.
- BR-SEC-003's log-redaction half is not claimed here; it requires the M7-S3 logger implementation named by `traceability-plan.yaml:293`.

### traceability.csv rows to update
| rule_id | slice | openapi_operation_ids | asyncapi_channels | migration_files | code_paths | test_case_ids | test_files | log_or_metric_or_audit | status |
|---|---|---|---|---|---|---|---|---|---|
| BR-SEC-003 | response/error payload and export-expiry half | createRecipient, createTemplate, createImportJob, createBulkJob, createCampaignExport, updateCustomField, downloadCampaignExport |  | 033_export_artifact_purge.sql | apps/api/src/campaigns/exports.service.ts | TC-SEC-003, TC-CFG-008, TC-SEC-013, TC-SEC-014 | apps/api/test/security/pii-payload.test.ts, apps/api/test/integration/campaign-export-download.test.ts | Problem-body DLP scan | partially_closed |

### screen-catalog.yaml changes
- None. UI rendering checks remain deferred.

### EXECPLAN entries
- DEC-155: BR-SEC-003 is proposed `partially_closed`, never `closed`: M7-S2 proves response/error payloads, expiry, injection and stored-XSS; M7-S3 owns the missing structured-log redaction evidence.

## Checkpoint 6 — session fixation and per-route CSRF negatives
**Status after this checkpoint:** running
**nextAction:** Reproduce D-146 and implement migration 035 plus the worker dead-letter transition at Checkpoint 7.

### Evidence (verbatim, for state.json)
- `cd apps/api && ./node_modules/.bin/vitest run test/security/csrf-session.test.ts test/integration/auth-http.test.ts test/integration/rbac-matrix.test.ts test/integration/auth-service.test.ts --reporter=default` passed: 4 files, 45 tests, 0 skipped.
- An attacker-chosen pre-login session id is not adopted, each login issues a distinct session and CSRF token, and refresh rotation makes the old token return 401.
- The per-route matrix sends an authenticated cookie with a mismatched CSRF header to 55 protected mutating routes and receives 403 before any handler-specific validation or mutation.
- The first route inventory found two real omissions: recipient create/update/delete and custom-field create/update/delete had no `CsrfGuard`. Both controllers now guard every cookie-authenticated mutation.
- Existing RBAC, auth HTTP, refresh/logout CSRF, login rate-limit, and session-rotation suites remain unchanged in count and pass 45/45 together.
- Webhook forgery and template-sanitizer suites were already present and were not rewritten; provider webhook routes are HMAC-authenticated and intentionally outside cookie CSRF.

### traceability.csv rows to update
| rule_id | slice | openapi_operation_ids | asyncapi_channels | migration_files | code_paths | test_case_ids | test_files | log_or_metric_or_audit | status |
|---|---|---|---|---|---|---|---|---|---|
| BR-AUTH-002 | session fixation, rotation, CSRF | login, refreshSession, logout and all cookie-authenticated mutations |  |  | apps/api/src/recipients/recipients.controller.ts, apps/api/src/custom-fields/custom-fields.controller.ts | TC-SEC-012 | apps/api/test/security/csrf-session.test.ts, apps/api/test/integration/auth-http.test.ts, apps/api/test/integration/auth-service.test.ts | auth/session audit evidence | test_passing |
| BR-AUTH-004 | RBAC regression around new CSRF guards | all permissioned operations |  |  |  | TC-AUTH-009 | apps/api/test/integration/rbac-matrix.test.ts | rbac.denied | test_passing |

### screen-catalog.yaml changes
- None.

### EXECPLAN entries
- D-146 remains open for CP7.
- D-150 block exhausted; additional finding is recorded without taking another reserved number: recipient and custom-field mutations omitted `CsrfGuard`. Fixed at CP6 and proven across the 55-route mutation matrix.

## Checkpoint 7 — migration 035 and dead-letter transition
**Status after this checkpoint:** running
**nextAction:** Add admin-only DLQ inspection and controlled idempotent replay at Checkpoint 8.

### Evidence (verbatim, for state.json)
- D-146 was reproduced before the fix: with the original batch-level failure behavior, the poison import event threw first and the healthy event behind it remained unpublished. The RED reproduction passed 1/1, proving the livelock/blocking defect rather than inferring it from code alone.
- Migration `035_dead_letter_queue.sql` adds nullable outbox failure state, the tenant-RLS `dead_letter_event` table, an admin-only `dlq:manage` permission, a dead-letter-aware `relay_pending_outbox_events()`, and the bounded `relay_record_outbox_failure()` transition. Exact SHA-256: `f1c7d71c2181253f019182351d0f662848ff87e09389639e745656e6546d214f`.
- The shared local database applied migration 035 and a subsequent migrate run reported `Migration 035_dead_letter_queue already applied`; migration ledger and lock manifest agree on the exact hash.
- `cd apps/worker && ./node_modules/.bin/vitest run src/outbox-dead-letter.integration.test.ts src/outbox-relay.test.ts src/outbox-relay.integration.test.ts --reporter=default --reporter=../../scripts/no-skipped-tests-reporter.mjs` passed: 3 files, 6 tests, 0 skipped. Existing outbox-relay files remain 3/3 and 1/1; the new DLQ suite is 2/2.
- The post-fix integration proves a poison row no longer blocks the healthy row in the same batch, reaches the exact attempts ceiling of 5, is inserted only once, records `last_error`, and is no longer selectable or incrementable after dead-lettering.
- Crossing the ceiling emits structured metric payload `eow_dead_letter_depth` with tenant id and value 1. Suggested M7-S3 alert policy: page when depth remains above 0 for 15 minutes; warn immediately on a positive transition.
- `cd apps/worker && ./node_modules/.bin/tsc -p tsconfig.json --noEmit` and `cd apps/api && ./node_modules/.bin/tsc -p tsconfig.json --noEmit` both exited 0.
- `cd packages/architecture-tests && ./node_modules/.bin/vitest run src/migration-immutability.test.ts --reporter=default --reporter=../../scripts/no-skipped-tests-reporter.mjs` passed: 1 file, 1 test, 0 skipped.

### traceability.csv rows to update
| rule_id | slice | openapi_operation_ids | asyncapi_channels | migration_files | code_paths | test_case_ids | test_files | log_or_metric_or_audit | status |
|---|---|---|---|---|---|---|---|---|---|
| BR-SEC-007 | bounded outbox retry and durable DLQ transition |  |  | 035_dead_letter_queue.sql | apps/worker/src/outbox-relay.ts, apps/worker/src/outbox-dead-letter.ts, apps/api/src/database/entities/dead-letter-event.entity.ts | TC-SEC-007 | apps/worker/src/outbox-dead-letter.integration.test.ts, apps/worker/src/outbox-relay.integration.test.ts, apps/worker/src/outbox-relay.test.ts | metric `eow_dead_letter_depth` + `dead_letter_event` table | running |

### screen-catalog.yaml changes
- None. No UI or screenshot work is authorized for this node.

### EXECPLAN entries
- D-146: Reproduced before implementation and fixed. Retry accounting is bounded at 5, dead-letter insertion is unique per tenant/source/event, and one poison row no longer aborts a mixed batch.
- DEC-151: The DLQ adds no realtime event and no notification rule. The reviewed realtime/notification catalogues are frozen and name no DLQ trigger; operational alerting is the structured `eow_dead_letter_depth` metric plus the DLQ runbook. Rejected: adding an unconsumed 21st realtime channel.
- Decision-number correction: the final inbox reserves DEC-151 for the plan-mandated no-realtime/no-notification decision. Earlier checkpoint prose that used DEC-151 through DEC-155 as sequential local labels should be interpreted by decision text, not as additional allocations; no number outside this node's reserved block was taken.

## Checkpoint 8 — DLQ inspection and controlled replay
**Status after this checkpoint:** running
**nextAction:** Append only the reserved `/dead-letter-events*` OpenAPI surface and verify compatibility at Checkpoint 9.

### Evidence (verbatim, for state.json)
- The RED HTTP suite reached all six assertions before implementation: five failed with route-level `404 Not Found`; the cross-tenant detail/replay negative already returned 404 because no route existed. This is the expected missing-module baseline.
- `cd apps/api && ./node_modules/.bin/vitest run test/recovery/dead-letter-replay.test.ts --reporter=default --reporter=../../scripts/no-skipped-tests-reporter.mjs` passed: 1 file, 6 tests, 0 skipped.
- Tenant A admin lists and inspects exactly its seeded dead-letter row; tenant B admin sees an empty list and receives 404 for tenant A detail/replay; an operator receives 403 because migration 035 grants `dlq:manage` only to admin.
- Replay is a controlled PostgreSQL requeue: it clears the original outbox row's dead-letter state so the normal authoritative relay can enqueue it. The API does not import BullMQ or create a second delivery path. The same Idempotency-Key returns the stored response, while a fresh key cannot create a second pending outbox effect because the source transition is conditional on `dead_lettered_at IS NOT NULL`.
- `replay_count` and `replayed_at` advance for fresh operator attempts, while `payload` remains byte-for-byte equivalent. The successful replay route is audited by the global interceptor as `dead_letter.replayed` with the authenticated actor and dead-letter id.
- `docs/operations/dlq-runbook.md` documents inspection, sensitive-payload handling, replay/discard decision criteria, CSRF and Idempotency-Key requirements, downstream verification, audit evidence, and the metric handoff. `docs/operations/runbook.md` remains untouched because M7-S3 owns it.
- `cd packages/architecture-tests && PATH="/tmp/m7-s2-bin:$PATH" ./node_modules/.bin/vitest run --reporter=default --reporter=../../scripts/no-skipped-tests-reporter.mjs` passed: 17 files, 121 tests, 0 skipped. The host has Docker Engine plus legacy `docker-compose` but no Compose v2 plugin, so the temporary `/tmp` shim translated only `docker compose` invocations; no repository file changed for this environment discrepancy.
- A preceding architecture attempt without that temporary shim ran 119/121 assertions and failed only the two Compose-fixture cases with `docker: unknown flag: --project-name`; all repository architecture assertions were green. The shim rerun proves the product/migration behavior, not a weakened test.

### traceability.csv rows to update
| rule_id | slice | openapi_operation_ids | asyncapi_channels | migration_files | code_paths | test_case_ids | test_files | log_or_metric_or_audit | status |
|---|---|---|---|---|---|---|---|---|---|
| BR-SEC-007 | tenant-scoped inspect and controlled idempotent replay | listDeadLetterEvents, getDeadLetterEvent, replayDeadLetterEvent |  | 035_dead_letter_queue.sql | apps/api/src/dead-letter/, apps/api/src/app.module.ts | TC-SEC-007, TC-SEC-010 | apps/api/test/recovery/dead-letter-replay.test.ts | audit `dead_letter.replayed` + metric `eow_dead_letter_depth` + `dead_letter_event` table | running |

### screen-catalog.yaml changes
- None. The UI portion is deferred as prose only; this node did not touch `apps/web/**` or visual evidence.

### EXECPLAN entries
- Controlled replay uses the existing PostgreSQL outbox as the original queue boundary instead of importing BullMQ into the API. Rejected: a second API-to-Redis publication path that could diverge from ADR-012's authoritative outbox relay and would require a new runtime dependency.
- Fresh-key replay increments the operator audit counter but does not create another pending outbox effect; same-key replay returns the stored response without entering the transition.

## Checkpoint 9 — additive `/dead-letter-events*` OpenAPI contract
**Status after this checkpoint:** running
**nextAction:** Run the full workspace verification twice in a quiet window and prepare the ready-for-review handoff at Checkpoint 10.

### Evidence (verbatim, for state.json)
- Saved the exact pre-edit contract outside the worktree at `../openapi-before-m7-s2.yaml`.
- Added only this node's reserved paths: `/dead-letter-events`, `/dead-letter-events/{deadLetterEventId}`, and `/dead-letter-events/{deadLetterEventId}/replay`, with operation IDs `listDeadLetterEvents`, `getDeadLetterEvent`, and `replayDeadLetterEvent`.
- Added only the supporting `DeadLetterEventId` parameter plus `DeadLetterEvent` and `DeadLetterEventListResponse` schemas. Replay references the existing shared `IdempotencyKey` parameter.
- `node scripts/openapi-compat-check.mjs ../openapi-before-m7-s2.yaml contracts/openapi.yaml` reported `No breaking OpenAPI changes detected.`
- `pnpm contracts:generate` exited 0 and generated the ignored TypeScript contract successfully; no generated file is staged.
- `cd apps/api && ./node_modules/.bin/tsc -p tsconfig.json --noEmit` exited 0 against the appended contract.

### traceability.csv rows to update
| rule_id | slice | openapi_operation_ids | asyncapi_channels | migration_files | code_paths | test_case_ids | test_files | log_or_metric_or_audit | status |
|---|---|---|---|---|---|---|---|---|---|
| BR-SEC-007 | published DLQ inspection and replay contract | listDeadLetterEvents, getDeadLetterEvent, replayDeadLetterEvent |  | 035_dead_letter_queue.sql | contracts/openapi.yaml, apps/api/src/dead-letter/ | TC-SEC-007, TC-SEC-010 | apps/api/test/recovery/dead-letter-replay.test.ts | audit `dead_letter.replayed` + metric `eow_dead_letter_depth` + `dead_letter_event` table | running |

### screen-catalog.yaml changes
- None.

### EXECPLAN entries
- The OpenAPI delta is additive against the saved pre-edit contract and confined to the prefix reserved for M7-S2 by protocol §3.3.

## Checkpoint 10 — verification complete; ready for review
**Status after this checkpoint:** ready-for-review
**nextAction:** Review session re-applies migration 035 and re-runs the suite on another machine, then merges this inbox into the shared state/traceability documents.

### Evidence (verbatim, for state.json)
- `pnpm --filter @eow/api build` exited 0 before full verification.
- Three default-parallel `pnpm check` attempts reached all 97 API files / 778 API tests with 0 skipped but hit shared-database timing/DDL races in unrelated campaign and Mailpit suites. Every reported API failure was rerun alone and passed: `campaign-snapshot-http` 11/11, `sender-config-http` 3/3, `campaign-pause` 5/5, `campaign-schedule-http` 15/15, and `campaign-send-http` 12/12. One legitimate owned regression was found: the admin permission expectation omitted newly seeded `dlq:manage`; the test was updated and the combined RBAC+DLQ rerun passed 2 files / 31 tests.
- The quiet deterministic run `PATH="/tmp/m7-s2-bin:$PATH" VITEST_MAX_WORKERS=1 pnpm check` proved the complete API package green: 97 files, 778 tests, 0 skipped. CP0's API baseline was 89 files / 649 tests; the count increased by 8 files and 129 tests, so no API suite disappeared.
- The same deterministic workspace run reached the worker and reproduced the exact CP0 out-of-scope failure with the expanded suite: worker 32 files, 146 tests, 0 skipped; only `apps/worker/src/campaign-send/send.integration.test.ts:476` failed because 2 progress events were published where `ceil(600/250) = 3` is asserted. A fresh targeted rerun on August 19, 2026 reproduced 1 failed / 16 passed in that file. M7-S2 did not modify `apps/worker/src/campaign-send/**`, which is explicitly another node's ownership.
- Therefore the plan's literal requirement for two exit-0 `pnpm check` runs cannot be satisfied inside M7-S2's allowed write set. The evidence is stronger than CP0 in all owned dimensions: API 778/778, worker-owned targeted DLQ/relay 6/6, and the only worker failure is the identical recorded baseline defect.
- Remaining workspace packages pass with 0 skipped: web 23 files / 73 tests; runtime-orchestration 1/3; api-schematics 1/1; scheduler and contracts intentionally have no test files and exit 0. No UI file or screenshot was inspected; the web command is only the mandatory workspace test runner's textual result.
- `PATH="/tmp/m7-s2-bin:$PATH" VITEST_MAX_WORKERS=1 pnpm --filter @eow/architecture-tests test` passed: 17 files, 121 tests, 0 skipped. This includes green `ARCH-CROSS-TENANT`, `ARCH-RBAC`, `ARCH-TENANT`, both migration immutability/atomicity/execution rules, `ARCH-MODULE`, `ARCH-LAYERING`, `ARCH-TEST-HYGIENE`, `ARCH-ENCODING`, `ARCH-ASYNCAPI-CONFORMANCE`, and `ARCH-JOB-WIRING`.
- ARCH-CROSS-TENANT moved from 79 uncovered routes at CP1 to 0 at CP2. The current controller surface has 8 reasoned `PUBLIC_OR_TENANTLESS` entries: public health; login and forgot/reset-password pre-session routes; refresh/logout/me deriving tenant from the signed session; and the HMAC provider webhook deriving tenant from verified payload.
- D-146 through D-150 are all disclosed in earlier sections. D-146 is reproduced and fixed; D-147 is the measured 79-route gap closed to zero; D-148 is the local-only non-durable `EnvSecretStore`; D-149 is stale import-time cookie security; D-150 is CSV formula injection. The additional CSRF omissions found at CP6 are fixed but intentionally took no number after the reserved D block was exhausted.
- Protocol §8.6 finding: the milestone phrase “TC-SEC-* (17 cases) executing” spans five owners. M7-S2 executes its six owned cases (`TC-SEC-001`, `003`, `007`, `010`, `013`, `014`) plus `TC-CFG-008`; the remaining eleven are assigned to M7-S4/M7-S5 or were already terminal. The review session should correct the shared condition text; this node did not edit shared state.
- M7-S3 handoff: metric `eow_dead_letter_depth`; suggested warning on any positive transition and page when depth remains above zero for 15 minutes.

### traceability.csv rows to update
| rule_id | slice | openapi_operation_ids | asyncapi_channels | migration_files | code_paths | test_case_ids | test_files | log_or_metric_or_audit | status |
|---|---|---|---|---|---|---|---|---|---|
| BR-SEC-001 | M7-S2-security-hardening | login, createSenderConfig, listSenderConfigs, getSenderConfig, testSenderConnection, listRecipients, listCampaignHistory, listRecipientLists, listTags |  |  | apps/api/src/auth/cookies.ts, docs/operations/security-baseline.md | TC-SEC-001, TC-SEC-013 | apps/api/test/security/secret-exposure.test.ts, apps/api/test/security/tls-policy.test.ts, apps/api/test/security/injection.test.ts | secret DLP scans + asserted TLS policy | test_passing |
| BR-SEC-003 | M7-S2-security-hardening | createRecipient, createTemplate, createImportJob, createBulkJob, createCampaignExport, updateCustomField, downloadCampaignExport, listRecipients, listCampaignHistory, listRecipientLists, listTags |  | 033_export_artifact_purge.sql | apps/api/src/campaigns/export-render.ts, apps/worker/src/export-processor.ts, apps/api/src/templates/template-variable-renderer.ts | TC-SEC-003, TC-SEC-013, TC-SEC-014, TC-CFG-008 | apps/api/test/security/pii-payload.test.ts, apps/api/test/security/injection.test.ts, apps/api/test/security/stored-xss.test.ts, apps/api/test/security/secret-exposure.test.ts, apps/api/test/integration/campaign-export-download.test.ts | Problem-body DLP + render-boundary encoding + export expiry | partially_closed |
| BR-SEC-007 | M7-S2-security-hardening | listDeadLetterEvents, getDeadLetterEvent, replayDeadLetterEvent |  | 035_dead_letter_queue.sql | apps/worker/src/outbox-relay.ts, apps/worker/src/outbox-dead-letter.ts, apps/api/src/dead-letter/, contracts/openapi.yaml | TC-SEC-007, TC-SEC-010, TC-SEND-018 | apps/worker/src/outbox-dead-letter.integration.test.ts, apps/worker/src/outbox-relay.integration.test.ts, apps/worker/src/outbox-relay.test.ts, apps/api/test/recovery/dead-letter-replay.test.ts | metric `eow_dead_letter_depth` + audit `dead_letter.replayed` + `dead_letter_event` table | test_passing |

`TC-SEND-018` is cited for BR-SEC-007 but has no M7-S2 `test_files` path; protocol §8.7 assigns its real process-restart test to M7-S4.

BR-SEC-003 is proposed `partially_closed`, never closed: payload secrecy, export expiry, injection, stored-XSS render encoding, and CSV formula neutralization are proven here. The structured-log redaction evidence named by `traceability-plan.yaml:293` requires the logger owned by M7-S3 and does not exist on this branch.

### screen-catalog.yaml changes
- None. UI rendering and DLQ-operator visibility remain deferred to M7-S5/review scope. No `apps/web/**` edit, screenshot, capture, or visual judgment was performed.

### EXECPLAN entries
- DEC-151: No DLQ realtime event or notification; use `eow_dead_letter_depth` plus the runbook/alert catalogue.
- DEC-152: Collection cross-tenant evidence permits a tenant-scoped 200/204 with no foreign rows; item routes require safe rejection.
- DEC-153: Production TLS terminates at a managed edge, while HTTPS `WEB_ORIGIN` drives Secure cookies.
- DEC-154: Stored-XSS is asserted at the context-specific email render boundary instead of mutating stored business data.
- DEC-155: BR-SEC-003 remains partially closed until M7-S3 supplies structured-log redaction evidence; the same review decision should restate the stale 17-case milestone condition per protocol §8.6.
- Full-suite discrepancy: two clean exit-0 runs remain impossible because the exact CP0 campaign-send throttle failure persists in another node's protected file. The review machine must re-run after the owner lands its repair; all M7-S2-owned evidence is green and this node is ready for independent review.

## DEFERRED UI / VISUAL HANDOFF — prose only
- `TC-SEC-010` and `TC-SEC-014` are catalogued as API + UI. This node authors only their API/render-boundary halves. M7-S5 should prove stored payloads do not execute in browser views and decide how a replay result is presented.
- No approved handoff screen currently owns a DLQ destination. Review must decide whether the runbook/API is sufficient for an admin-only recovery tool or whether M7-S5 should create a production-only screen from the existing component vocabulary.
- Any future screen must show the standard permission-denied state for callers without `dlq:manage`.
- `screen-catalog.yaml` remains untouched; no state coverage or capture was claimed.
