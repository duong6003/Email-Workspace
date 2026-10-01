# M7-S2 Security hardening — Implementation Plan

> **For Codex, working in the `m7-s2-security-hardening` git worktree on a machine that does not
> have this conversation.** Every checkpoint is self-contained. Read
> [`PARALLEL-EXECUTION-PROTOCOL-M7.md`](PARALLEL-EXECUTION-PROTOCOL-M7.md) **first** — it is
> binding, and §3 allocates the numbers this plan uses. Read
> [`PARALLEL-EXECUTION-PROTOCOL.md`](PARALLEL-EXECUTION-PROTOCOL.md) §4 for the inbox pattern.

**Node:** `M7-S2-security-hardening` · **Branch:** `m7-s2-security-hardening`
**Rules:** `BR-SEC-001` (P0), `BR-SEC-003` (P0, **one half only** — see Scope), `BR-SEC-007` (P0)
**Migration reserved:** `035` (second, if needed: `065`)
**`DEC-*` block:** DEC-151…DEC-155 · **`D-*` block:** D-146…D-150
**OpenAPI prefix owned:** `/dead-letter-events*` · **AsyncAPI:** edits nothing

---

## Goal

The security test layer that `traceability-plan.yaml` has declared since M1 but that has never
existed becomes real: a cross-tenant negative test for **every** tenant-owned endpoint, enforced
mechanically rather than by discipline; a scan proving no plaintext secret reaches a response, an
error body or a stored column; injection and stored-XSS negatives; a written and asserted TLS
policy; and a dead-letter queue with alerting, inspection and controlled, idempotent replay —
which today does not exist at all, and whose absence is currently causing a live defect.

## Scope — read this before writing anything

### The three rules and their real acceptance text

These are quoted from `catalog/ba-rules.json` and are the authority, not any paraphrase:

| Rule | Statement | Acceptance |
|---|---|---|
| `BR-SEC-001` | "Traffic dùng TLS; database, object storage, backup và secret được mã hóa at rest." | "Security scan xác nhận không có plaintext secret; TLS policy đạt chuẩn tổ chức." |
| `BR-SEC-003` | "PII chỉ hiện theo quyền; log, metric và error payload không chứa recipient list/body email đầy đủ." | "DLP/log scan không phát hiện secret hoặc body; export có expiry." |
| `BR-SEC-007` | "Internal event và webhook dùng at-least-once; consumer phải idempotent và có dead-letter queue." | "Replay event không đổi count sai; DLQ có alert, inspect và replay có kiểm soát." |

### `BR-SEC-003` closes across two nodes — you own one half

`traceability-plan.yaml:293` names `BR-SEC-003`'s evidence as *"a redaction test asserting
recipient custom values and email bodies never appear in logs"*. **There is no logger on `main` to
redact.** Verified: `pino` and `winston` are absent from every `package.json`; the entire backend
logs through four `console.error`/`console.log` call sites plus one Nest `Logger` instance;
`LOG_LEVEL` exists in `apps/api/src/config/env.ts:16` and is read by nothing.

Building the logger is `M7-S3-observability`'s success condition, not yours. So:

- **You own:** the response/error-payload half, export expiry, injection, stored XSS — i.e.
  `TC-SEC-003`'s API surface, `TC-CFG-008`, `TC-SEC-013`, `TC-SEC-014`.
- **M7-S3 owns:** the log-redaction half.
- **Therefore you propose `BR-SEC-003` as `partially_closed` in your inbox, never `closed`,** and
  you say which half is missing and which node owns it. Protocol §8.2.

### Your six `TC-SEC-*` cases — not seventeen

`state.json`'s success condition says *"TC-SEC-* (17 cases) executing"*. Mapped against
`traceability.csv` row by row, the 17 belong to five owners. **Yours are:**

| Case | Rule | Layer per `catalog/test-cases.json` | Expected result (verbatim) |
|---|---|---|---|
| `TC-SEC-001` | BR-SEC-001 | API/Integration | "Security scan xác nhận không có plaintext secret; TLS policy đạt chuẩn tổ chức." |
| `TC-SEC-003` | BR-SEC-003 | API/Integration | "DLP/log scan không phát hiện secret hoặc body; export có expiry." |
| `TC-SEC-007` | BR-SEC-007 | API/Integration | "Replay event không đổi count sai; DLQ có alert, inspect và replay có kiểm soát." |
| `TC-SEC-010` | BR-SEC-007 | API + UI | "Consumer xử lý đúng một hiệu ứng; replay lần hai không thay đổi state/count." |
| `TC-SEC-013` | BR-SEC-001 + BR-SEC-003 | API + UI | "Không thực thi injection; response an toàn; log không lộ stack/secret." |
| `TC-SEC-014` | BR-TPL-006 (M3, **closed**) + BR-SEC-003 | API + UI | "Payload được escape/sanitize theo ngữ cảnh; không thực thi script." |
| `TC-CFG-008` | BR-CFG-001 (M5, **closed**) + BR-SEC-003 | API + UI | "Không response/log nào chứa secret; chỉ masked/has_secret flag; gửi vẫn dùng secret hiện hữu." |

**Not yours:** `TC-SEC-004`, `TC-SEC-005`, `TC-SEC-015`, `TC-SEC-016` → `M7-S4`.
`TC-SEC-006`, `TC-SEC-011` → `M7-S5`. `TC-SEC-002`, `TC-SEC-009`, `TC-SEC-012`, `TC-SEC-017` →
already `closed`. `TC-SEC-008` → `waived`. Full table in protocol §8.6.

In particular: **do not write the 10,000-connection SSE load test** (`TC-SEC-016`). It is
`M7-S4`'s and needs staging infrastructure neither machine has. Protocol §8.1 corrects a slip in
`EXECPLAN` `DEC-143` that attributes it here.

Also **do not write a worker-restart test** (`TC-SEND-018`). It is co-owned by your `BR-SEC-007`
and `M7-S4`'s `BR-SEC-005`, and `M7-S4` authors it (protocol §8.7). Cite it in your inbox; do not
give it a `test_files` path.

### The "every tenant-owned endpoint" condition, made measurable

`state.json`'s first success condition is *"Cross-tenant negative test exists and passes for every
tenant-owned endpoint"*, and `traceability-plan.yaml:261` states the rule with no escape hatch:
*"Every tenant-owned endpoint gets a cross-tenant negative test. No exceptions."*

`contracts/openapi.yaml` declares **65 paths / 95 operations** at `eb5a835`. About twenty ad-hoc
cross-tenant negatives exist, scattered across feature test files. A prose claim of coverage over
95 operations is unverifiable, and the previous milestone gates in this run have repeatedly shown
that unverifiable claims drift. **So coverage is enforced by a new architecture rule
(`ARCH-CROSS-TENANT`), not by a checklist** — that is CP1, and it is deliberately the first thing
you build, because it tells you exactly how much work CP2 is.

## What already exists (verified at `eb5a835` — do not rebuild it)

| Thing | Where | Note |
|---|---|---|
| The authoritative security doc | `docs/operations/security-baseline.md` — **10 lines** | Concrete requirements: Secure HttpOnly SameSite cookies; CSRF for state changes; server-side RBAC and tenant guards; parameterized queries; output encoding and sanitized email HTML; secret rotation; signed provider webhooks; encryption in transit, managed at rest; *"Never log tokens, recipient custom values or email bodies."*; the audit action list; *"Define retention and erasure workflows before production data is admitted."* **You own this file** (protocol §3.6) and will extend it. |
| Security test layer location | Declared at `traceability-plan.yaml:259` as `apps/api/test/security/**`, recovery at `:266` as `apps/api/test/recovery/**` | **Neither directory exists.** `apps/api/test/` contains only `integration/`. Vitest's default include picks up `**/*.test.ts`, so a new directory needs no config change — verify that in CP1 rather than assuming it. |
| Route enumeration mechanism to copy | `packages/architecture-tests/src/rbac-coverage.test.ts` — rule `ARCH-RBAC`, one test: "has no controller route missing both `@Public()` and `@RequirePermission()`" | It enumerates every `@Get|@Post|@Patch|@Put|@Delete` in every file containing `@Controller` under `apps/api/src`, scanning the decorator block in both directions. **This is the file to model `ARCH-CROSS-TENANT` on.** Do not edit it; write a sibling. |
| Static tenant-scoping rule | `packages/architecture-tests/src/tenant-isolation.test.ts` — rule `ARCH-TENANT`, 4 tests | Source scanning only: no request-scoped raw query without a `tenant_id` predicate (2 allowlisted files); ORM access to tenant-owned entities routed through `TenantScopedRepository`. **It executes no endpoint** — which is exactly the gap `ARCH-CROSS-TENANT` fills. |
| Runtime RLS proof | `apps/api/test/integration/rls-tenant-isolation.test.ts` (5 tests), `tenant-scoped-repository.test.ts:31,75`, `notification-preference-rls.test.ts:55` | Database-level. |
| Existing scattered cross-tenant negatives (~20) | `campaign-export-download.test.ts:186`, `recipients.test.ts:100`, `custom-fields.test.ts:92,245`, `import-jobs.test.ts:111`, `campaign-drafts.test.ts:76`, `bulk-jobs.test.ts:154,177`, `segments.test.ts:108`, `retention-policy.test.ts:127`, `campaign-schedule-http.test.ts:334`, `realtime-campaign.test.ts:199`, `campaign-snapshot-freeze.test.ts:255`, `campaign-snapshot-immutability.test.ts:298,365`, `campaign-variable-validation.test.ts:148`, `audience-resolution.test.ts:160`, `auth-service.test.ts:270`, `delivery-events-db.test.ts:169` | **Keep every one of them.** `ARCH-CROSS-TENANT` must recognise them as coverage, not demand they be rewritten. |
| Secret storage | `apps/api/src/sender-config/secret-store.ts` (15 lines): `SecretStore` interface, `EnvSecretStore` (in-process `Map` + `process.env` fallback), `maskSecretReference(reference)` returning `xx••••yy` | The comment at line 6 says "Local-only seam; production can replace this provider with a real secret manager." A new `SenderConfigService` is constructed per app (`sender-config.service.ts:19`), so secrets `put()` here do **not** survive restart and are **not** shared with the worker — record that as a discovery if you confirm it; do not fix it (out of rule scope, and it is the documented seam). |
| Secret never returned | `sender-config.service.ts:15` `response()` returns `secretRef: maskSecretReference(row.secretRef)`; `:25` explicitly `delete (row as ...).secret` before save | |
| Existing secret-adjacent tests | `sender-config.service.test.ts:7` "masks secret references and never exposes plaintext"; `sender-config-http.test.ts:83,107` "…with no secret leaked"; `webhooks-http.test.ts:328` "no error response body contains the configured webhook secret" | None is a *general* scan — that is `TC-SEC-001`'s and `TC-CFG-008`'s gap. |
| Problem body safety precedent | `apps/api/src/common/problem.ts:53` `mapErrorToProblem` collapses any non-`HttpException` to a generic 500 detail (doc: "the real message may contain internals… that must never reach a client"); `extensionsFrom` (`:41-45`) strips `message`/`statusCode`/`error` | This is already correct. Your job is to *prove* it holds across every route, not to change it. |
| HTML sanitizer (`BR-TPL-006`, closed) | `apps/api/src/templates/template-html-sanitizer.ts` (115 lines): `sanitize-html` + `juice`, three-pass pipeline, 36-tag allowlist, schemes `http/https/mailto/tel/cid`, `unsafeCss` regex, image `src` restricted to `^(?:https:|cid:)`, `MAX_TEMPLATE_HTML_BYTES = 5MB` | Its test has **3 cases** and covers template HTML only. `TC-SEC-014`'s other half — stored XSS in **recipient names, tag names and custom-field values** — is uncovered. That is your gap. |
| Query construction | TypeORM entities + `TenantScopedRepository`, plus substantial raw `manager.query`/`client.query`, all parameterized `$1..$n` | The two places that interpolate into SQL text (`apps/api/src/campaigns/exports.service.ts:69-74`, `apps/worker/src/export-processor.ts:86-115`) build only **placeholder indices**, never values. So `TC-SEC-013` validates behaviour; it is not fixing a known hole. Write it as a regression guard and say so. |
| CSRF | `apps/api/src/auth/csrf.guard.ts` (19 lines); `apps/api/src/auth/cookies.ts`: `SESSION_COOKIE='eow_session'`, `CSRF_COOKIE='eow_csrf'`, `CSRF_HEADER='x-csrf-token'`, `csrfTokensMatch()` is a plain `===`, `setCsrfCookie()` uses `randomUUID()` with `httpOnly: false`, `originRequiresSecureCookies(webOrigin)` returns `webOrigin.startsWith('https://')`, `sameSite: 'lax'` | Existing negatives: `auth-http.test.ts:115` (logout without CSRF header), `rbac-matrix.test.ts:217` (refresh/logout without header). **No session-fixation test exists** (grep "fixation" → zero hits) and no test asserts the CSRF token rotates on login. |
| Sessions | `apps/api/src/auth/session.service.ts`: `create()` (12h / 30d remember), `validate()` (checks `revokedAt`, `expiresAt`, `secretMatchesHash`), `rotate()` (revokes old row, issues new, links via `rotated_from`) | `rotate()`'s doc says "old refresh token cannot be reused after rotation" (`BR-AUTH-002`). |
| Rate limiting | Login only: `apps/api/src/auth/login-attempt.service.ts` — `LOCKOUT_MAX_FAILURES = 5`, `LOCKOUT_WINDOW_MS = 15min`, PostgreSQL-backed sliding window over `login_attempt`; thrown at `auth.controller.ts:39` as `TooManyRequestsException` | `TC-SEC-012` (`BR-AUTH-005`) is already **closed** with a test in `auth-service.test.ts`. No generic per-route limiter exists — and none is in your rules' scope. Do not add one. |
| Webhook signature | `apps/api/src/webhooks/webhook-signature.ts` (60 lines): header `/^t=(\d+),v1=([0-9a-f]+)$/`, `HMAC-SHA256(secret, \`${t}.${rawBody}\`)`, length checked before `timingSafeEqual`, 300s tolerance, `rawBody` is a `Buffer` by contract | **Already very well covered**: 17 unit tests + 26 HTTP tests including wrong secret (401, writes no state), tampered body (401, writes no state), expired, malformed, missing, unknown provider, over-size, secret unset → 503, duplicate replay → one row, two concurrent POSTs → exactly one row. **Do not rewrite these.** Reference them; add only what is genuinely absent. |
| Webhook dedupe | `apps/api/src/webhooks/webhooks.service.ts:160-182` — `INSERT INTO delivery_event ... ON CONFLICT (provider, provider_event_id) DO NOTHING`, zero rows → `{status: 'duplicate'}` | Ledger from `027_delivery_events.sql`. |
| HTTP idempotency | `apps/api/src/common/idempotency.service.ts` (105 lines): `run(manager, tenantId, key, resourceType, payload, create)`, sha256 over a canonicalized payload, existing row + different hash → 409, existing row with `responseJson` → `{replayed: true, value}` **without calling `create()`**, `INSERT ... orIgnore()` as the mutex, 24h TTL | This is how replay is already proven not to double-count: the second call never enters the creation path. `TC-SEC-010`'s DLQ replay must reach the same standard. |
| Send-path idempotency | `apps/worker/src/campaign-send/send.ts:91-94` doc + `:382-384`/`:408-410` `INSERT INTO message_attempt ... ON CONFLICT (campaign_recipient_id, attempt_no) DO NOTHING`; `STALE_CLAIM_MINUTES = 5`; stable Message-ID from `apps/worker/src/campaign-send/message.ts` | |
| Queues | `apps/scheduler/src/main.ts:5` `new Queue('campaign-execution')`, 7 repeating job names enqueued with `{jobId, removeOnComplete: 100, removeOnFail: 500}`; `apps/worker/src/main.ts` three `Worker`s (`campaign-execution`, `IMPORT_QUEUE`, `BULK_QUEUE`) each with only `{connection, concurrency}` | **No `attempts`, no `backoff` on any `queue.add`.** BullMQ default is 1 attempt, so a throwing job goes straight to `failed`. `removeOnFail: 500` retains the last 500. **The BullMQ job-option work is `M7-S4`'s** (protocol §3.6) — do not set `attempts`/`backoff`/`lockDuration` in `apps/worker/src/main.ts`. |
| **The live defect you own** | `apps/worker/src/outbox-relay.ts:35-38` and `:65-68` | See below. |
| Migration runner constraints | `database/migrate.sh` rejects psql meta-commands and transaction control inside a migration (`migration_source_is_safe()`, lines 52-195) and wraps each file in one transaction | |
| Integration-test shape to copy | `apps/api/test/integration/sender-config-http.test.ts:34-62` | Env before dynamic `import('../../src/app.module.js')`; unique tenant via `randomUUID()`; FK-ordered teardown; `30_000` hook timeout; `login()` at `:64` → `{cookie, csrfToken}`. |
| Test-URL helpers (mandatory) | `apps/api/test/integration/test-database-url.ts` (`testDatabaseUrl()`, `testAppDatabaseUrl()`), `apps/worker/src/test-urls.ts` (`testOwnerDatabaseUrl()`, `testAppDatabaseUrl()`, `testRedisUrl()`) | `ARCH-TEST-HYGIENE` fails on a hardcoded connection string. Test against `eow_app`, not the owner: owner bypasses RLS and would pass a missing `GRANT` (`EXECPLAN` D-51). |

### The live defect this node inherits — `D-146`, write it down first

`apps/worker/src/outbox-relay.ts:35-38` and `:65-68`, both paths, verbatim:

```ts
} catch {
  await pool.query(`SELECT relay_mark_outbox_attempt($1)`, [row.id]);
  throw new Error(`Unable to publish import outbox event ${row.id}.`);
}
```

It increments `outbox_event.attempts` and **rethrows immediately, aborting the remaining rows in
that pass**. `published_at` stays `NULL`, so `relay_pending_outbox_events()` re-selects the row on
the next 60-second tick — forever. `001_initial.sql:88` has `attempts integer NOT NULL DEFAULT 0`
but nothing reads it as a ceiling; `013_outbox_relay_api.sql:38` defines
`relay_mark_outbox_attempt(p_id uuid)` and nothing more. There is no dead-letter transition and no
alert.

A single poison event therefore loops indefinitely **and blocks every event behind it in the same
batch**, silently. That is precisely what `BR-SEC-007`'s "DLQ có alert, inspect và replay có kiểm
soát" exists to prevent, and it is a real bug, not a hypothetical. CP7 opens with a RED test that
reproduces it.

## Architecture

Two independent workstreams, deliberately sequenced so the mechanical one comes first:

1. **CP1-CP6 — the security test layer.** New `apps/api/test/security/` and
   `apps/api/test/recovery/` directories, and a new architecture rule `ARCH-CROSS-TENANT` that
   enumerates controller routes the same way `ARCH-RBAC` already does and requires each
   tenant-owned one to be named by at least one cross-tenant test. Building the rule *first* means
   CP2's workload is measured, not guessed, and means the coverage claim stays true after this node
   ends: a future controller route with no cross-tenant test fails the build.

2. **CP7-CP9 — the dead-letter queue.** A `dead_letter_event` table; an attempts ceiling that
   transitions a poison outbox event into it instead of looping; a per-row `try/catch` so one
   poison event stops blocking the batch; a metric and an alert entry for depth; and
   `GET/POST` inspect-and-replay routes behind a new permission key, where replay reuses the
   existing idempotency guarantees so a second replay changes nothing.

## Tech stack

TypeScript (ESM, `node >= 22.13`), NestJS, TypeORM + parameterized raw SQL, PostgreSQL 17 with RLS,
BullMQ + `ioredis`, Vitest, `supertest`, zod, `sanitize-html`.

## File structure

**Create:**

| File | Responsibility |
|---|---|
| `packages/architecture-tests/src/cross-tenant-coverage.test.ts` | Rule `ARCH-CROSS-TENANT`: every tenant-owned controller route is named by a cross-tenant negative test. |
| `apps/api/test/security/cross-tenant-matrix.test.ts` | The runtime cross-tenant negatives that fill the gap the rule reports. |
| `apps/api/test/security/secret-exposure.test.ts` | `TC-SEC-001`, `TC-CFG-008`: no plaintext secret in any response, error body or stored column. |
| `apps/api/test/security/tls-policy.test.ts` | `TC-SEC-001`'s TLS half, asserted against the written policy. |
| `apps/api/test/security/injection.test.ts` | `TC-SEC-013`. |
| `apps/api/test/security/stored-xss.test.ts` | `TC-SEC-014`'s recipient/tag/custom-field half. |
| `apps/api/test/security/csrf-session.test.ts` | Session fixation, CSRF rotation, cross-origin CSRF. |
| `apps/api/test/security/pii-payload.test.ts` | `TC-SEC-003`'s API half + export expiry. |
| `database/migrations/035_dead_letter_queue.sql` | `dead_letter_event` table, `outbox_event` attempts ceiling helper, permission seed/grant. |
| `apps/api/src/dead-letter/dead-letter.module.ts` | Nest module. |
| `apps/api/src/dead-letter/dead-letter.controller.ts` | `GET /dead-letter-events`, `GET /dead-letter-events/{id}`, `POST /dead-letter-events/{id}/replay`. |
| `apps/api/src/dead-letter/dead-letter.service.ts` | List/get/replay orchestration. |
| `apps/api/src/dead-letter/dead-letter.repository.ts` | SQL. |
| `apps/api/src/dead-letter/dead-letter-metrics.ts` | `eow_dead_letter_depth`. |
| `apps/api/src/dead-letter/dto/dead-letter.dto.ts` | zod schemas. |
| `apps/api/src/database/entities/dead-letter-event.entity.ts` | TypeORM mapping. |
| `apps/worker/src/outbox-dead-letter.ts` | The attempts-ceiling transition, called by the relay. |
| `apps/worker/src/outbox-dead-letter.integration.test.ts` | Reproduces `D-146`, then proves the fix. |
| `apps/api/test/recovery/dead-letter-replay.test.ts` | `TC-SEC-007`, `TC-SEC-010`. |
| `docs/operations/dlq-runbook.md` | Inspect/replay procedure referenced from `security-baseline.md`. |

**Modify:**

| File | Change |
|---|---|
| `apps/worker/src/outbox-relay.ts` | Per-row `try/catch` (stop aborting the batch) + attempts-ceiling call. |
| `apps/api/src/common/permissions.ts` | Append **one** key (`DLQ_MANAGE`). You are the only node touching this file (protocol §3.6). |
| `apps/api/src/app.module.ts` | Append `DeadLetterModule` (append only). |
| `docs/operations/security-baseline.md` | Add the TLS policy and the DLQ procedure reference. You own this file. |
| `contracts/openapi.yaml` | Append `/dead-letter-events*`. One commit, late. |
| `database/migrations.lock.json` | Append the 035 checksum. |
| `.agents/runs/2026-08-10-eow-master-execplan/inbox/M7-S2-security-hardening.md` | One section per checkpoint. |

**Must NOT touch:** `apps/web/**` (protocol §1.1), `contracts/asyncapi.yaml`, `catalog/**`,
`state.json`, `traceability.csv`, `screen-catalog.yaml`, `EXECPLAN.md`,
`apps/api/src/main.ts` / `apps/worker/src/main.ts` / `apps/scheduler/src/main.ts` (M7-S3/M7-S4's),
`apps/api/src/common/http-exception.filter.ts` (M7-S3's), `docs/operations/runbook.md` (M7-S3's),
`compose.yaml` / `.env.deploy.example` / `.github/workflows/ci.yml` / `Dockerfile` (M7-S4's),
`apps/worker/src/campaign-send/**` (M7-S1's `send.ts`, M7-S3's `run.ts`),
`packages/architecture-tests/src/asyncapi-conformance.test.ts` (M7-S1's),
`packages/architecture-tests/src/rbac-coverage.test.ts` or `tenant-isolation.test.ts`
(existing rules — write siblings, never edit them; AGENTS.md §5: never weaken a rule to make it pass).

---

## Checkpoint 0 — Establish the baseline (no code)

- [ ] **Step 1: Create the worktree and bootstrap it**

From the root clone:

```bash
git fetch origin && git checkout main && git pull --ff-only origin main
git worktree add -b m7-s2-security-hardening ../eow-m7-s2 main
```

In `../eow-m7-s2`: `pnpm install --frozen-lockfile`, copy `.env` from the root clone, then
`pnpm infra:up`.

- [ ] **Step 2: Record the real baseline**

```bash
pnpm --filter @eow/api build
pnpm check
```

Expected: exit 0. Record the per-package file and test counts **as printed**. That is your
baseline, not the protocol's table.

- [ ] **Step 3: Confirm a new test directory is actually collected**

Before building a whole test layer under a new directory, prove Vitest picks it up. Create
`apps/api/test/security/collection-probe.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

describe('M7-S2 CP0: apps/api/test/security is collected by the api vitest project', () => {
  it('runs', () => { expect(true).toBe(true); });
});
```

```bash
pnpm --filter @eow/api test -- test/security/collection-probe.test.ts
```

Expected: PASS, 1 test. Then run the whole package and confirm the count rose by exactly 1:

```bash
pnpm --filter @eow/api test
```

If the probe is **not** collected, read `apps/api/vitest.config.ts` (11 lines) — it applies
`sharedTestExclude` plus the two timeouts and sets no `include`, so Vitest's default
`**/*.{test,spec}.?(c|m)[jt]s?(x)` should apply. **Do not edit `vitest.shared.ts`** (protocol
§3.6); if a config change is genuinely required, record it in the inbox and stop.

Delete the probe once it has served its purpose, in the same commit.

- [ ] **Step 4: Open the inbox and commit**

Create `.agents/runs/2026-08-10-eow-master-execplan/inbox/M7-S2-security-hardening.md` with a
`## Checkpoint 0 — baseline` section: the printed counts, the collection-probe result, and this
`D-146` entry (write it now, while it is fresh, not at the end):

```markdown
- D-146: apps/worker/src/outbox-relay.ts:35-38 and :65-68 increment outbox_event.attempts and
  rethrow immediately, aborting the rest of the relay batch. published_at stays NULL so
  relay_pending_outbox_events() re-selects the row every 60s tick forever; there is no attempts
  ceiling, no dead-letter transition and no alert. A single poison event loops indefinitely AND
  blocks every event behind it in the same batch, silently. Owned by BR-SEC-007; fixed at CP7.
```

```bash
git add .agents/runs/2026-08-10-eow-master-execplan/inbox/M7-S2-security-hardening.md
git commit -m "M7-S2 CP0: baseline recorded; D-146 outbox poison loop disclosed

pnpm check exit 0. Counts: apps/api <F>/<T>, apps/worker <F>/<T>,
apps/web <F>/<T>, packages/architecture-tests <F>/<T>, 0 skipped.
apps/api/test/security/ confirmed collected by the default vitest include
(no config change needed)."
```

---

## Checkpoint 1 — `ARCH-CROSS-TENANT`: make the coverage claim measurable

**Files:**
- Create: `packages/architecture-tests/src/cross-tenant-coverage.test.ts`

Build the rule **before** the tests it demands. Its first run is the specification for CP2.

- [ ] **Step 1: Write the rule**

Model it on `packages/architecture-tests/src/rbac-coverage.test.ts` — read that file first and
reuse its route-scanning approach and its `repo.ts` helpers rather than inventing a second scanner.

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { repoFiles, repoRoot } from './repo.js';

/**
 * ARCH-CROSS-TENANT.
 *
 * traceability-plan.yaml:261 states the rule with no escape hatch: "Every
 * tenant-owned endpoint gets a cross-tenant negative test. No exceptions."
 * M7-S2's own first success condition repeats it. contracts/openapi.yaml
 * declares 95 operations, so a prose claim of coverage over that surface is
 * unverifiable -- and this run has already had a milestone claim `closed`
 * against evidence that did not exist (EXECPLAN D-42).
 *
 * So coverage is mechanical. Every controller route is enumerated the way
 * ARCH-RBAC already enumerates them; each tenant-owned one must be named by
 * at least one test whose name or body marks it as a cross-tenant negative.
 * The ~20 pre-existing ad-hoc negatives count as coverage: this rule
 * recognises existing work, it does not demand it be rewritten.
 *
 * A route that is genuinely not tenant-owned goes in PUBLIC_OR_TENANTLESS
 * with a written reason. That list is the exception mechanism, and it is
 * visible in review -- unlike prose.
 */

// Routes with no tenant-owned resource behind them. Each entry needs a reason.
const PUBLIC_OR_TENANTLESS: Array<{ route: string; reason: string }> = [
  { route: 'GET /health', reason: '@Public() liveness probe; no tenant resource is read.' },
  { route: 'POST /auth/login', reason: 'Pre-session: the caller has no tenant yet. Cross-tenant is meaningless; the tenant-resolution negative is auth-service.test.ts:270.' },
  { route: 'POST /auth/forgot-password', reason: 'Pre-session, same reason as login.' },
  { route: 'POST /auth/reset-password', reason: 'Pre-session; guarded by a single-use token, not a session tenant.' },
  { route: 'POST /webhooks/providers/{provider}', reason: 'Provider-authenticated by HMAC, not by session. Its tenant is derived from the signed payload; forgery negatives are webhooks-http.test.ts:225-284.' },
];

const CROSS_TENANT_MARKERS = [/cross-tenant/i, /other tenant/i, /another tenant/i, /BR-GEN-002/, /TC-SEC-009/];
```

The rule body then, in order:

1. Enumerate controller routes exactly as `rbac-coverage.test.ts` does (files containing
   `@Controller`, each `@Get|@Post|@Patch|@Put|@Delete` decorator, resolving the controller-level
   path prefix if any). Produce a canonical `"<METHOD> /<path>"` string per route.
2. Read every test file under `apps/api/test/**` and `apps/api/src/**/*.test.ts`. For each, if it
   contains any `CROSS_TENANT_MARKERS` match, extract the route paths it mentions (a simple
   `/api/v1/<...>` or `'<path>'` scan, with `{param}` and `:param` and a real UUID all normalised
   to a single placeholder).
3. `expect(uncovered).toEqual([])` where `uncovered` is the enumerated routes minus the covered set
   minus `PUBLIC_OR_TENANTLESS`. **The failure message must list every uncovered route, one per
   line** — that list is CP2's worklist, so make it readable.
4. A second test asserting every `PUBLIC_OR_TENANTLESS` entry has a non-empty `reason` and
   corresponds to a route that actually exists (an entry for a deleted route is stale and must
   fail).

- [ ] **Step 2: Run it and read the failure**

```bash
pnpm --filter @eow/architecture-tests test -- src/cross-tenant-coverage.test.ts
```

Expected: **FAIL**, listing the uncovered routes. Copy that list verbatim into the inbox — it is
the evidence that CP2's scope was measured rather than assumed, and it is the "before" number the
review will compare against.

If it fails with *zero* uncovered routes, your path-matching is too loose (probably normalising
everything to the same placeholder). Tighten it until the count is plausible against the ~20
known negatives and 95 operations, and say in the inbox how you validated the matcher — a coverage
rule that cannot fail is worse than none.

- [ ] **Step 3: Commit the failing rule**

Committing a red rule is deliberate: it records the measured gap, and the next commit closing it
is then a provable delta. Mark it clearly.

```bash
git add packages/architecture-tests/src/cross-tenant-coverage.test.ts \
        .agents/runs/2026-08-10-eow-master-execplan/inbox/M7-S2-security-hardening.md
git commit -m "M7-S2 CP1: ARCH-CROSS-TENANT rule (RED — records the measured gap)

traceability-plan.yaml:261 says 'Every tenant-owned endpoint gets a
cross-tenant negative test. No exceptions.' over 95 declared operations.
A prose claim across that surface is unverifiable, and EXECPLAN D-42 is
this run's own precedent for a claim outliving its evidence.

Enumerates routes the way ARCH-RBAC already does; recognises the ~20
existing ad-hoc negatives as coverage rather than demanding a rewrite;
PUBLIC_OR_TENANTLESS is the visible, reasoned exception list.

Currently RED with <N> uncovered routes -- that list is CP2's worklist.
Deliberately committed red so the closing commit is a provable delta."
```

---

## Checkpoint 2 — Fill the cross-tenant gap until the rule is green

**Files:**
- Create: `apps/api/test/security/cross-tenant-matrix.test.ts`

- [ ] **Step 1: Write the matrix test**

One file, driven by a table so adding a route is one line rather than one `it()` block. Boot the
app the standard way (`sender-config-http.test.ts:34-62`), create **two** real tenants each with
an admin user, and for each uncovered route assert the same three things:

```ts
  // BR-GEN-002 / TC-SEC-009: "Khong lo resource; 404/403 nhat quan; khong
  // thay doi du lieu; security audit ghi attempt."
  //
  // Three assertions per route, because "not 200" is not the requirement:
  //   1. the status is 403 or 404 -- never 200, and never 500 (a 500 means
  //      the tenant check happened after something already touched the row)
  //   2. the response body never contains the other tenant's identifier or
  //      any of its field values -- a 404 that echoes the resource name has
  //      still disclosed it
  //   3. the other tenant's row is byte-identical afterwards
  for (const target of CROSS_TENANT_ROUTES) {
    it(`cross-tenant: ${target.method} ${target.path} does not expose tenant B to tenant A`, async () => {
      const before = await snapshotRow(target);
      const response = await request(app.getHttpServer())
        [target.method.toLowerCase() as 'get'](target.urlFor(tenantBResourceId))
        .set('Cookie', tenantACookie)
        .set('x-csrf-token', tenantACsrf)
        .send(target.body ?? undefined);

      expect([403, 404]).toContain(response.status);
      const serialized = JSON.stringify(response.body ?? {});
      expect(serialized).not.toContain(tenantB.id);
      expect(serialized).not.toContain(target.secretMarker);
      expect(await snapshotRow(target)).toEqual(before);
    }, 30_000);
  }
```

Build `CROSS_TENANT_ROUTES` from the uncovered list CP1 printed. Each entry needs a real
tenant-B fixture row, so create them in `beforeAll` — recipients, lists, tags, custom fields,
templates, campaigns, import/bulk jobs, notifications, sender configs, exports, retention policy.
Use `randomUUID()` in every name so parallel runs on the shared database do not collide, and tear
down in FK order scoped to both tenant ids.

`target.secretMarker` is a distinctive string planted in tenant B's row (e.g.
`` `marker-${randomUUID()}` `` in a name field), which makes assertion 2 meaningful: it fails if
the value leaks even without the tenant id.

- [ ] **Step 2: Run and confirm each route fails for the right reason first**

Add the routes in small groups (5-8 at a time) rather than all at once. For each group:

```bash
pnpm --filter @eow/api test -- test/security/cross-tenant-matrix.test.ts
```

**If a route returns `200`, you have found a real tenant-isolation defect.** Stop, record it as a
`D-*` in the inbox with the exact route and reproduction, fix the guard in the controller/service,
and note it in the commit message. That is the single most valuable outcome this checkpoint can
have. A `500` is also a finding: it means the tenant check runs after something already touched
the row.

- [ ] **Step 3: Run the rule until it is green**

```bash
pnpm --filter @eow/architecture-tests test -- src/cross-tenant-coverage.test.ts
```

Expected: PASS, `uncovered` empty.

- [ ] **Step 4: Commit**

```bash
git add apps/api/test/security/cross-tenant-matrix.test.ts \
        .agents/runs/2026-08-10-eow-master-execplan/inbox/M7-S2-security-hardening.md
git commit -m "M7-S2 CP2: cross-tenant negatives for every tenant-owned route

ARCH-CROSS-TENANT green: <N> routes covered, <M> in the reasoned
PUBLIC_OR_TENANTLESS list, 0 uncovered (was <N> at CP1).

Three assertions per route, because 'not 200' is not the requirement:
status in {403,404} and never 500 (a 500 means the tenant check ran
after something touched the row); the body contains neither tenant B's
id nor a planted marker value (a 404 that echoes a resource name has
still disclosed it); and tenant B's row is byte-identical afterwards.

<findings: real defects found, or 'no route returned 200 or 500'>

<N>/<N> tests."
```

---

## Checkpoint 3 — `BR-SEC-001`: secret-exposure scan and a written TLS policy

**Files:**
- Create: `apps/api/test/security/secret-exposure.test.ts`, `apps/api/test/security/tls-policy.test.ts`
- Modify: `docs/operations/security-baseline.md`

`BR-SEC-001`'s acceptance has two clauses and both need evidence: *"Security scan xác nhận không
có plaintext secret"* and *"TLS policy đạt chuẩn tổ chức."*

- [ ] **Step 1: Write the failing secret-exposure test**

`apps/api/test/security/secret-exposure.test.ts`. This is `TC-SEC-001` and `TC-CFG-008` together.
It plants a known, distinctive secret and then hunts for it everywhere a secret could surface:

```ts
const PLANTED_SECRET = `PLANTED-SMTP-SECRET-${randomUUID()}`;

  it('TC-CFG-008: no sender-config response contains the plaintext secret', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/sender-configs')
      .set('Cookie', cookie).set('x-csrf-token', csrfToken)
      .send({ name: `probe-${randomUUID()}`, fromName: 'P', fromEmail: 'p@example.test',
              provider: 'smtp', host: 'mailpit', port: 1025, username: 'u', secret: PLANTED_SECRET })
      .expect(201);

    expect(JSON.stringify(created.body)).not.toContain(PLANTED_SECRET);
    // Only a masked reference, never a has_secret-plus-value shape.
    expect(created.body.secretRef).toMatch(/••••/);

    for (const url of [`/api/v1/sender-configs`, `/api/v1/sender-configs/${created.body.id}`]) {
      const read = await request(app.getHttpServer()).get(url).set('Cookie', cookie).expect(200);
      expect(JSON.stringify(read.body)).not.toContain(PLANTED_SECRET);
    }
  }, 30_000);

  it('TC-SEC-001: the plaintext secret is in no tenant-visible database column', async () => {
    // A column-by-column scan rather than a hand-picked list: a future
    // migration that adds a text column and stores a secret in it must fail
    // this test, which a fixed list would not catch.
    const columns = await dataSource.query(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND data_type IN ('text','character varying','jsonb')`,
    );
    const hits: string[] = [];
    for (const { table_name, column_name } of columns) {
      const found = await dataSource.query(
        `SELECT 1 FROM "${table_name}" WHERE "${column_name}"::text LIKE $1 LIMIT 1`,
        [`%${PLANTED_SECRET}%`],
      );
      if (found.length > 0) hits.push(`${table_name}.${column_name}`);
    }
    expect(hits).toEqual([]);
  }, 60_000);

  it('TC-SEC-001: an error response from the probe route never echoes the secret', async () => {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/sender-configs/${created.body.id}/test-connection`)
      .set('Cookie', cookie).set('x-csrf-token', csrfToken).set('Idempotency-Key', randomUUID())
      .send({ secret: PLANTED_SECRET });
    expect(JSON.stringify(response.body)).not.toContain(PLANTED_SECRET);
  }, 30_000);

  it('TC-SEC-001: the audit row for the probe records only a classification, never the secret', async () => {
    const audit = await dataSource.query(
      `SELECT metadata FROM audit_log WHERE tenant_id = $1 AND action LIKE 'sender_config%' ORDER BY occurred_at DESC LIMIT 5`,
      [tenant.id],
    );
    expect(JSON.stringify(audit)).not.toContain(PLANTED_SECRET);
  }, 30_000);
```

> The `information_schema` sweep interpolates `table_name`/`column_name` into SQL text. That is the
> one legitimate case for it — they come from the catalog, not from a request — and the *value*
> stays parameterized as `$1`. Add a comment saying so, because `ARCH-TENANT` scans `.query(` call
> sites and a reviewer will ask.

- [ ] **Step 2: Write the failing TLS policy test**

There is no TLS termination in this deployment: `deploy/nginx/default.conf` serves plain HTTP on
`:8080` and `docs/deployment/quick-deploy.md`'s "Production boundary" section already says a
managed edge is expected. So the honest form of *"TLS policy đạt chuẩn tổ chức"* is **a written
policy plus an assertion that the code honours it**, not a fabricated handshake test.

`apps/api/test/security/tls-policy.test.ts`:

```ts
  it('BR-SEC-001: cookies become Secure exactly when the configured origin is https', async () => {
    // apps/api/src/auth/cookies.ts derives Secure from WEB_ORIGIN's scheme,
    // not from NODE_ENV. That is the correct coupling -- the flag must track
    // how the app is actually reached -- but it means the deployment contract
    // and the cookie flag are one decision, so it is asserted here.
    expect(originRequiresSecureCookies('https://app.example.test')).toBe(true);
    expect(originRequiresSecureCookies('http://localhost:8080')).toBe(false);
    expect(originRequiresSecureCookies(undefined)).toBe(false);
  });

  it('BR-SEC-001: the session cookie is HttpOnly and SameSite=Lax on a real login', async () => {
    const response = await request(app.getHttpServer()).post('/api/v1/auth/login')
      .send({ email, password }).expect(204);
    const setCookie = String(response.headers['set-cookie']);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toMatch(/SameSite=Lax/i);
  }, 30_000);

  it('BR-SEC-001: security-baseline.md states the TLS policy this deployment relies on', () => {
    const doc = readFileSync(resolve(repoRoot, 'docs/operations/security-baseline.md'), 'utf8');
    // The policy must name the minimum version and where termination happens,
    // because "encryption in transit" alone is not a checkable policy.
    expect(doc).toMatch(/TLS 1\.2/);
    expect(doc).toMatch(/terminat/i);
  });
```

- [ ] **Step 3: Run both and confirm they fail**

```bash
pnpm --filter @eow/api test -- test/security/secret-exposure.test.ts test/security/tls-policy.test.ts
```

Expected: the TLS document assertion FAILS (`security-baseline.md` has no TLS version and no
termination statement). The secret-exposure cases may already pass — **that is a valid and good
outcome**: they are regression guards over behaviour `M5-S1` got right. If any of them fails, you
have found a real leak; record it as a `D-*` and fix it.

- [ ] **Step 4: Write the TLS policy into `security-baseline.md`**

Extend the file (you own it). Add a section stating, concretely and checkably: the minimum TLS
version; that termination is at the operator's edge/reverse proxy and not inside the containers;
that the `web` container serves plain HTTP on `:8080` **behind** that edge; that `WEB_ORIGIN`'s
scheme is what drives the `Secure` cookie flag, so a production deployment must set an `https://`
origin; and that database, Redis and backup encryption at rest is a managed-infrastructure
responsibility (which is what `BR-SEC-001`'s statement means by "managed encryption at rest", and
what `docs/deployment/quick-deploy.md`'s production boundary already implies).

Write the file as **UTF-8** — `ARCH-ENCODING` scans it (AGENTS.md §2).

- [ ] **Step 5: Run to verify and commit**

```bash
pnpm --filter @eow/api test -- test/security/secret-exposure.test.ts test/security/tls-policy.test.ts
pnpm --filter @eow/architecture-tests test -- src/text-encoding.test.ts
```

Expected: PASS.

```bash
git add apps/api/test/security/ docs/operations/security-baseline.md \
        .agents/runs/2026-08-10-eow-master-execplan/inbox/M7-S2-security-hardening.md
git commit -m "M7-S2 CP3: BR-SEC-001 secret-exposure scan and written TLS policy

The secret scan plants one distinctive value and hunts it in every
sender-config response, every text/varchar/jsonb column in the public
schema (an information_schema sweep, not a hand-picked list, so a future
migration that stores a secret in a new column fails this test), the
probe error body and the audit metadata.

TLS: this deployment terminates at the operator's edge -- nginx serves
plain HTTP on :8080 and quick-deploy.md's production boundary already
says so -- so the honest evidence is a written policy plus assertions
that the code honours it, not a fabricated handshake. security-baseline.md
now names the minimum version and where termination happens, and the test
asserts the document says so, which is what makes 'dat chuan to chuc'
checkable at all.

<N>/<N> tests; ARCH-ENCODING green."
```

---

## Checkpoint 4 — `TC-SEC-013` injection and `TC-SEC-014` stored XSS

**Files:**
- Create: `apps/api/test/security/injection.test.ts`, `apps/api/test/security/stored-xss.test.ts`

- [ ] **Step 1: Write the failing injection test**

`TC-SEC-013`'s expected result: *"Không thực thi injection; response an toàn; log không lộ
stack/secret."* Every raw query inspected is parameterized, so this is a **regression guard**. Say
that in a comment — a test that claims to fix a hole it did not find is a false claim.

`apps/api/test/security/injection.test.ts`:

```ts
const PAYLOADS = [
  `'; DROP TABLE recipient; --`,
  `' OR '1'='1`,
  `\\'; SELECT pg_sleep(5); --`,
  `%' UNION SELECT NULL, current_database(), NULL --`,
  `{"$ne": null}`,          // NoSQL-shaped, per the case's own title
  `1); DELETE FROM tag WHERE 1=1; --`,
];

  // Every raw query in apps/api and apps/worker is parameterized ($1..$n).
  // The two places that interpolate into SQL text (exports.service.ts:69-74,
  // export-processor.ts:86-115) build only placeholder INDICES, never values.
  // So this suite is a regression guard, not a fix: it must keep failing if
  // anyone ever concatenates a value into SQL text.
  for (const payload of PAYLOADS) {
    it(`TC-SEC-013: search and filter endpoints treat ${JSON.stringify(payload).slice(0, 32)} as data`, async () => {
      const searched = await request(app.getHttpServer())
        .get(`/api/v1/recipients?search=${encodeURIComponent(payload)}`)
        .set('Cookie', cookie);
      expect([200, 400]).toContain(searched.status);
      expect(searched.status).not.toBe(500);

      // The tables the payloads try to drop are still there with their rows.
      const stillThere = await dataSource.query(`SELECT count(*)::int AS n FROM recipient WHERE tenant_id = $1`, [tenant.id]);
      expect(stillThere[0].n).toBe(seededRecipientCount);

      // "response an toan" + "log khong lo stack": a 400 must be a Problem
      // body with no SQL fragment and no stack frame in it.
      const body = JSON.stringify(searched.body ?? {});
      expect(body).not.toMatch(/SELECT |FROM |syntax error at or near/i);
      expect(body).not.toMatch(/\bat \w+ \(.*:\d+:\d+\)/);
    }, 30_000);
  }
```

Repeat the same payload table against the other user-controlled filter surfaces: the campaign
history filter, the export status filter (`exports.service.ts` is the interpolating one, so it
matters most), the audience query, tag and list name search, and the custom-field value filter.
Add one `it()` per surface, driven by the same `PAYLOADS` array.

- [ ] **Step 2: Write the failing stored-XSS test**

`TC-SEC-014`'s title is *"XSS stored trong recipient/template"* and its expected result is
*"Payload được escape/sanitize theo ngữ cảnh; không thực thi script."* The **template** half is
`BR-TPL-006` and already closed (`template-html-sanitizer.test.ts`, 3 tests). The
**recipient/tag/custom-field value** half is uncovered — that is yours.

`apps/api/test/security/stored-xss.test.ts`:

```ts
const XSS = `<img src=x onerror="alert(1)">`;
const XSS_SVG = `<svg/onload=alert(1)>`;
const XSS_ATTR = `" onmouseover="alert(1)`;

  it('TC-SEC-014: a script payload stored in a recipient name never reaches a rendered email as active HTML', async () => {
    // The dangerous path is not the API response (the SPA escapes on render)
    // -- it is merge substitution into an email body, where the value is
    // interpolated into HTML that a mail client will execute.
    await createRecipient({ email: `xss-${randomUUID()}@example.test`, name: XSS });
    const rendered = await renderTemplateForRecipient(templateWithNameVariable, recipientId);
    expect(rendered.html).not.toContain('onerror=');
    expect(rendered.html).not.toContain('<img');
    expect(rendered.html).toContain('&lt;img');
  }, 30_000);

  it('TC-SEC-014: the same payload in a custom-field value is escaped in the same place', async () => { /* ... */ }, 30_000);
  it('TC-SEC-014: the same payload in a tag name is escaped where a tag name is rendered', async () => { /* ... */ }, 30_000);

  it('TC-SEC-014: an svg/onload payload in an export cell cannot execute when the CSV is opened', async () => {
    // BR-HIS-003's export renders recipient values into a file a human opens.
    // Formula injection (=, +, -, @ leading a cell) is the spreadsheet
    // equivalent of XSS and belongs to the same case.
    const csv = await downloadExport(exportId);
    for (const cell of cellsOf(csv)) expect(cell).not.toMatch(/^[=+\-@]/);
  }, 30_000);
```

Find the actual merge-render entry point before writing this: search for the variable-substitution
function used by the send path (`grep -rn "renderTemplate\|mergeVariables\|substituteVariables" apps/api/src apps/worker/src --include=*.ts | grep -v test`).
The assertion belongs at the **rendered-output** boundary, not at the API-response boundary.

**If the rendered output does contain active HTML, you have found a real stored-XSS defect.** Stop,
record it as a `D-*`, fix it at the render boundary (escape per context — do not widen the
template sanitizer's allowlist, and do not sanitize on input, which would corrupt a legitimate
recipient name containing `<`), and say so prominently in the commit message. The CSV
formula-injection case is likely to be a genuine finding too.

- [ ] **Step 3: Run both, confirm the failure mode, implement any fix, re-run**

```bash
pnpm --filter @eow/api test -- test/security/injection.test.ts test/security/stored-xss.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add apps/api/test/security/ apps/api/src/ \
        .agents/runs/2026-08-10-eow-master-execplan/inbox/M7-S2-security-hardening.md
git commit -m "M7-S2 CP4: TC-SEC-013 injection and TC-SEC-014 stored XSS

Injection is a regression guard, stated as such: every raw query in
apps/api and apps/worker is already parameterized, and the two files
that interpolate into SQL text build placeholder indices only. The suite
exists so that stops being true loudly rather than quietly. It also
asserts the 400 body carries no SQL fragment and no stack frame, which
is TC-SEC-013's 'log khong lo stack' half.

Stored XSS is asserted at the RENDER boundary, not the API response
boundary: the dangerous path is merge substitution into an email body a
mail client executes, not JSON the SPA escapes anyway. Escaping is per
context and on output -- sanitizing on input would corrupt a legitimate
recipient name containing '<'.

<findings>

<N>/<N> tests."
```

---

## Checkpoint 5 — `TC-SEC-003`: PII in payloads, and export expiry

**Files:**
- Create: `apps/api/test/security/pii-payload.test.ts`

`TC-SEC-003`: *"DLP/log scan không phát hiện secret hoặc body; export có expiry."* The log half is
M7-S3's (Scope, above). The payload half and the export-expiry half are yours.

- [ ] **Step 1: Write the failing test**

```ts
  it('TC-SEC-003: no error payload from any route contains a recipient custom value or an email body', async () => {
    // Drive every route into its error path with a deliberately malformed
    // request, then scan the Problem body for planted PII markers. This is
    // the payload half of BR-SEC-003; the log half is M7-S3's and is
    // deliberately absent here (see this plan's Scope section).
    for (const route of ERROR_PATH_ROUTES) {
      const response = await route.provoke(app, cookie, csrfToken);
      const body = JSON.stringify(response.body ?? {});
      expect(body).not.toContain(PLANTED_CUSTOM_VALUE);
      expect(body).not.toContain(PLANTED_EMAIL_BODY_MARKER);
      expect(body).not.toContain(PLANTED_RECIPIENT_EMAIL);
      // problem.ts collapses non-HttpException to a generic 500 detail
      // exactly so internals cannot reach a client; prove it holds.
      if (response.status >= 500) expect(body).not.toMatch(/\bat \w+ \(.*:\d+:\d+\)/);
    }
  }, 60_000);

  it('BR-HIS-007 / TC-SEC-003: a completed export carries an expiry and is refused after it', async () => {
    // EXPORT_ARTIFACT_TTL_HOURS stamps export_job.expires_at at completion
    // (migration 029), migration 033 purges the bytes afterwards, and
    // exports.service.ts's download() checks expiry BEFORE artifact_bytes so
    // an expired export always reads 410 Gone, never 404 (commit eb5a835).
    const job = await completeExport();
    expect(job.expiresAt).not.toBeNull();
    await dataSource.query(`UPDATE export_job SET expires_at = now() - interval '1 hour' WHERE id = $1`, [job.id]);
    await request(app.getHttpServer())
      .get(`/api/v1/campaigns/${campaignId}/exports/${job.id}/file`)
      .set('Cookie', cookie)
      .expect(410);
  }, 30_000);

  it('BR-SEC-003: a viewer without history:export cannot download recipient-level PII', async () => {
    // BR-HIS-007/DEC-135: CAMPAIGN_READ is deliberately not sufficient.
    await request(app.getHttpServer())
      .get(`/api/v1/campaigns/${campaignId}/exports/${exportId}/file`)
      .set('Cookie', viewerCookie)
      .expect(403);
  }, 30_000);
```

Build `ERROR_PATH_ROUTES` from the controller enumeration — for each route, one deliberately
malformed request (wrong body type, missing required field, non-UUID id, absent
`Idempotency-Key` where one is required). Reuse the route list you already derived in CP1/CP2
rather than maintaining a third copy.

- [ ] **Step 2: Run, fix any finding, re-run, commit**

```bash
pnpm --filter @eow/api test -- test/security/pii-payload.test.ts
```

```bash
git add apps/api/test/security/pii-payload.test.ts \
        .agents/runs/2026-08-10-eow-master-execplan/inbox/M7-S2-security-hardening.md
git commit -m "M7-S2 CP5: TC-SEC-003 payload half and export expiry

Drives every route into its error path with a malformed request and
scans the Problem body for planted PII markers, plus asserts no 5xx body
carries a stack frame -- proving problem.ts's generic-500 collapse holds
in practice, not just in its doc comment.

Export expiry: 410 Gone after expires_at (the ordering exports.service.ts
fixed in eb5a835 so an expired export never reads as 404), and a viewer
holding only CAMPAIGN_READ is still refused the file (BR-HIS-007/DEC-135).

BR-SEC-003's log-redaction half is M7-S3's and is NOT claimed here.

<N>/<N> tests."
```

---

## Checkpoint 6 — CSRF, session fixation and rate-limit negatives

**Files:**
- Create: `apps/api/test/security/csrf-session.test.ts`

`state.json`'s second success condition names *"RBAC negatives, CSRF, session fixation, webhook
signature forgery, template injection and rate limits"*. RBAC negatives
(`rbac-matrix.test.ts`), webhook forgery (17 + 26 tests) and login rate limits
(`auth-service.test.ts`, `TC-SEC-012` closed) already exist and must **not** be rewritten. What is
genuinely missing is session fixation and real cross-origin CSRF.

- [ ] **Step 1: Write the failing tests**

```ts
  it('BR-AUTH-002: a session id observed before login cannot be used after it (no fixation)', async () => {
    // grep 'fixation' across the repo returns zero hits today. The attack:
    // obtain a pre-auth cookie, get the victim to authenticate on it, then
    // reuse it. session.service.ts's create() issues a NEW row rather than
    // adopting one, which is the correct design -- this test is what stops
    // that being changed by accident.
    const preAuth = await request(app.getHttpServer()).get('/api/v1/auth/me');
    const preAuthCookie = String(preAuth.headers['set-cookie'] ?? '');

    const login = await request(app.getHttpServer()).post('/api/v1/auth/login')
      .set('Cookie', preAuthCookie).send({ email, password }).expect(204);
    const postAuthCookie = String(login.headers['set-cookie']);

    const preSessionId = sessionIdFrom(preAuthCookie);
    const postSessionId = sessionIdFrom(postAuthCookie);
    if (preSessionId) expect(postSessionId).not.toBe(preSessionId);

    if (preAuthCookie) {
      await request(app.getHttpServer()).get('/api/v1/auth/me').set('Cookie', preAuthCookie).expect(401);
    }
  }, 30_000);

  it('BR-AUTH-002: the CSRF token is reissued on login, so a pre-login token is not accepted afterwards', async () => {
    const first = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password }).expect(204);
    const second = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password }).expect(204);
    expect(csrfFrom(first.headers['set-cookie'])).not.toBe(csrfFrom(second.headers['set-cookie']));
  }, 30_000);

  it('BR-AUTH-002: rotate() invalidates the previous refresh token', async () => {
    const { cookie: c1 } = await login();
    const refreshed = await request(app.getHttpServer()).post('/api/v1/auth/refresh')
      .set('Cookie', c1).set('x-csrf-token', csrfOf(c1)).expect(200);
    // The pre-rotation cookie must now be dead, not merely stale.
    await request(app.getHttpServer()).post('/api/v1/auth/refresh')
      .set('Cookie', c1).set('x-csrf-token', csrfOf(c1)).expect(401);
    expect(refreshed.headers['set-cookie']).toBeDefined();
  }, 30_000);

  it('BR-SEC-CSRF: a state-changing request with a cookie but a mismatched header token is refused on every mutating route', async () => {
    // rbac-matrix.test.ts:217 covers refresh/logout. This widens it to every
    // mutating route, because CsrfGuard is applied per-controller and a new
    // controller can silently omit it.
    for (const route of MUTATING_ROUTES) {
      const response = await route.call(app, cookie, 'not-the-real-token');
      expect(response.status).toBe(403);
    }
  }, 60_000);
```

`MUTATING_ROUTES` comes from the same controller enumeration as CP1. A route that returns anything
other than `403` is a real missing `CsrfGuard` — record it as a `D-*` and add the guard.

- [ ] **Step 2: Run, fix findings, re-run, commit**

```bash
pnpm --filter @eow/api test -- test/security/csrf-session.test.ts
pnpm --filter @eow/api test -- test/integration/auth-http.test.ts test/integration/rbac-matrix.test.ts test/integration/auth-service.test.ts
```

Expected: the new file PASSes and the three existing files' counts are **unchanged**.

```bash
git add apps/api/test/security/csrf-session.test.ts apps/api/src/ \
        .agents/runs/2026-08-10-eow-master-execplan/inbox/M7-S2-security-hardening.md
git commit -m "M7-S2 CP6: session fixation and per-route CSRF negatives

'fixation' had zero occurrences in the repo before this commit.
session.service.ts's create() already issues a new row rather than
adopting a pre-auth one, and rotate() already revokes the old row -- this
suite is what stops either being changed by accident.

The CSRF negative is widened from rbac-matrix.test.ts's refresh/logout
pair to EVERY mutating route, because CsrfGuard is applied per-controller
and a new controller can silently omit it.

RBAC negatives, webhook forgery (17 unit + 26 HTTP) and login rate
limiting (TC-SEC-012, closed) already existed and were not rewritten;
their counts are unchanged.

<N>/<N> new tests."
```

---

## Checkpoint 7 — Migration 035, the dead-letter table, and fixing `D-146`

**Files:**
- Create: `database/migrations/035_dead_letter_queue.sql`,
  `apps/api/src/database/entities/dead-letter-event.entity.ts`,
  `apps/worker/src/outbox-dead-letter.ts`,
  `apps/worker/src/outbox-dead-letter.integration.test.ts`
- Modify: `apps/worker/src/outbox-relay.ts`, `apps/api/src/common/permissions.ts`,
  `database/migrations.lock.json`

- [ ] **Step 1: Write the failing test that reproduces `D-146`**

`apps/worker/src/outbox-dead-letter.integration.test.ts`. Reproduce the defect **before** fixing
it — the reproduction is the evidence that the fix is real.

```ts
  it('D-146: today a poison outbox event blocks every event behind it in the same batch', async () => {
    // Two unpublished import events; the FIRST is poison (a payload the
    // publisher rejects). Before the fix, relayUnpublishedImportEvents
    // rethrows on the first row and the second is never attempted.
    await seedPoisonEvent();
    await seedHealthyEvent();

    await expect(relayUnpublishedImportEvents(pool, queue, 10)).rejects.toThrow(/Unable to publish/);

    const healthy = await pool.query(
      `SELECT published_at FROM outbox_event WHERE id = $1`, [healthyEventId]);
    // THIS is the defect: the healthy event behind the poison one is still
    // unpublished. Delete this assertion when the fix lands and replace it
    // with the post-fix expectation in step 4.
    expect(healthy.rows[0].published_at).toBeNull();
  }, 30_000);

  it('BR-SEC-007: a poison event exceeding the attempts ceiling moves to dead_letter_event, once', async () => {
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS + 1; i += 1) {
      await relayUnpublishedImportEvents(pool, queue, 10).catch(() => undefined);
    }
    const dead = await pool.query(
      `SELECT event_id, attempts, last_error FROM dead_letter_event WHERE tenant_id = $1`, [tenantId]);
    expect(dead.rows).toHaveLength(1);
    expect(Number(dead.rows[0].attempts)).toBeGreaterThanOrEqual(OUTBOX_MAX_ATTEMPTS);
    expect(dead.rows[0].last_error).toBeTruthy();

    // And it stops being re-selected: the loop is over.
    const pending = await pool.query(
      `SELECT id FROM outbox_event WHERE id = $1 AND published_at IS NULL AND dead_lettered_at IS NULL`,
      [poisonEventId]);
    expect(pending.rows).toHaveLength(0);
  }, 60_000);

  it('BR-SEC-007: a healthy event behind a poison one is published in the same pass', async () => {
    // The fix's other half. One poison row must not cost the batch.
    await relayUnpublishedImportEvents(pool, queue, 10).catch(() => undefined);
    const healthy = await pool.query(`SELECT published_at FROM outbox_event WHERE id = $1`, [healthyEventId]);
    expect(healthy.rows[0].published_at).not.toBeNull();
  }, 30_000);
```

- [ ] **Step 2: Run and confirm the reproduction**

```bash
pnpm --filter @eow/worker test -- src/outbox-dead-letter.integration.test.ts
```

Expected: the first test PASSES (the defect is real and reproduced); the second and third FAIL
(`relation "dead_letter_event" does not exist`).

**Record the first test's pass in the inbox as the `D-146` reproduction evidence.**

- [ ] **Step 3: Write migration 035**

`database/migrations/035_dead_letter_queue.sql`. Plain SQL, no psql meta-commands, no transaction
control. It must:

- `ALTER TABLE outbox_event ADD COLUMN IF NOT EXISTS dead_lettered_at timestamptz` and
  `ADD COLUMN IF NOT EXISTS last_error text`. Both nullable — the running containers execute older
  code against this schema (protocol §5), so no `NOT NULL` without a default.
- `CREATE TABLE dead_letter_event (id, tenant_id REFERENCES tenant(id), source text NOT NULL, event_id uuid, event_type text NOT NULL, aggregate_type text, aggregate_id uuid, payload jsonb NOT NULL, attempts integer NOT NULL, last_error text, dead_lettered_at timestamptz NOT NULL DEFAULT now(), replayed_at timestamptz, replay_count integer NOT NULL DEFAULT 0)`
  with `CONSTRAINT dead_letter_event_source_values CHECK (source IN ('outbox','job'))` and a
  `UNIQUE (tenant_id, source, event_id)` so a second dead-lettering of the same event is a no-op
  rather than a duplicate row.
- RLS `ENABLE` + `FORCE` + a `tenant_id = current_tenant_id()` policy, and
  `GRANT SELECT, INSERT, UPDATE ON dead_letter_event TO eow_app` — copy the exact policy and
  function name from `database/migrations/020_sender_config.sql`.
- Update the partial index that drives relay selection so a dead-lettered row is no longer
  selected. Check what `relay_pending_outbox_events()` (defined in
  `database/migrations/013_outbox_relay_api.sql`) actually filters on, and if it needs the
  `dead_lettered_at IS NULL` predicate, replace the **function** with `CREATE OR REPLACE FUNCTION`
  — that is the established precedent for a locked function in this repo (migrations 023, 030 and
  031 all do exactly that). **Do not edit migration 013.**
- Seed and grant the new permission key: one `permission` row with key `dlq:manage` and
  `role_permission` grants to `admin` only. Copy the shape from
  `database/migrations/029_history_recovery.sql`, which added `history:export` — its comment
  records the reason a later key needs an explicit grant: *"admin's blanket seed-time grant in
  004_rbac.sql does not retroactively cover a key added later."*

- [ ] **Step 4: Fix `outbox-relay.ts` and write the transition**

`apps/worker/src/outbox-dead-letter.ts`:

```ts
/**
 * BR-SEC-007: "Internal event va webhook dung at-least-once; consumer phai
 * idempotent va co dead-letter queue." Acceptance: "DLQ co alert, inspect va
 * replay co kiem soat."
 *
 * D-146: before this module, outbox-relay.ts incremented attempts and
 * rethrew, so a poison event was re-selected every 60s forever AND aborted
 * the rest of its batch. At-least-once without a ceiling is not
 * at-least-once, it is a livelock.
 */
export const OUTBOX_MAX_ATTEMPTS = 5;

export async function deadLetterOutboxEvent(pool: pg.Pool, row: OutboxRow, error: unknown): Promise<boolean> { /* ... */ }
```

In `apps/worker/src/outbox-relay.ts`, both handlers (`relayUnpublishedImportEvents` at `:17` and
`relayUnpublishedBulkEvents` at `:47`):

- Move the `try/catch` **inside** the per-row loop so one failing row no longer aborts the batch.
- In the `catch`: call `relay_mark_outbox_attempt`, then, if the row's `attempts` has reached
  `OUTBOX_MAX_ATTEMPTS`, call `deadLetterOutboxEvent(...)`, log the
  `deadLetterDepthMetric(...)` payload, and **continue** to the next row.
- Only rethrow after the loop, and only if **every** row failed — a pass in which nothing at all
  could be published is an infrastructure fault the job should surface, whereas one poison row is
  not.

Add the metric in `apps/api/src/dead-letter/dead-letter-metrics.ts` following
`apps/worker/src/progress-metrics.ts`'s shape (exported type + pure function returning a flat
`Record` with `metric: 'eow_dead_letter_depth'` and a `value:`). No `prom-client` (protocol §8.2 —
the registry is M7-S3's).

**Deliberate decision to record as `DEC-151`:** the DLQ raises **no realtime event and no
notification**. `project.manifest.yaml` freezes `realtime_events: 20` and
`notification_rules: 16` as reviewed baselines; `ARCH-ASYNCAPI-CONFORMANCE` asserts
`catalog/realtime-events.json` and `contracts/asyncapi.yaml` agree; and `BR-NOT-014`'s trigger
catalogue — asserted at `apps/api/src/notifications/notification-rules.test.ts:32-34` — names no
DLQ trigger. So "DLQ có alert" is satisfied by the metric plus a runbook alert entry, which is
also how `docs/operations/runbook.md` already frames alerting. The rejected alternative
(adding a 21st realtime event) would break a frozen baseline to add a channel nothing consumes.

- [ ] **Step 5: Apply the migration, record the checksum, re-run**

```bash
docker compose --env-file .env up migrate --exit-code-from migrate
sha256sum database/migrations/035_dead_letter_queue.sql
```

Append the hash to `database/migrations.lock.json`, then:

```bash
pnpm --filter @eow/architecture-tests test -- src/migration-immutability.test.ts
```

Now update the first test from step 1: the pre-fix assertion
(`expect(healthy.rows[0].published_at).toBeNull()`) is the **old** behaviour and must be replaced
by the post-fix expectation. Keep the test — rename it to
`'D-146 (fixed): a poison outbox event no longer blocks the batch'` and assert the healthy row
**is** published. Leaving the pre-fix assertion in place would make the suite assert the bug.

```bash
pnpm --filter @eow/worker test -- src/outbox-dead-letter.integration.test.ts src/outbox-relay.integration.test.ts src/outbox-relay.test.ts
```

Expected: all PASS; the two existing outbox-relay files' counts unchanged.

- [ ] **Step 6: Append the permission key**

In `apps/api/src/common/permissions.ts`, **append** (protocol §3.6 — you are the only node
touching this file):

```ts
  /**
   * M7-S2 (BR-SEC-007): "DLQ co alert, inspect va replay co kiem soat."
   * Inspecting a dead-lettered event exposes its raw payload, and replaying
   * one re-runs a side effect -- neither is a settings change nor a campaign
   * action, so no existing key carries the right authority. Seeded and
   * granted to admin only by database/migrations/035_dead_letter_queue.sql
   * (004_rbac.sql's blanket admin seed does not retroactively cover a key
   * added later -- the same reason 029 had to grant history:export
   * explicitly).
   */
  DLQ_MANAGE: 'dlq:manage',
```

- [ ] **Step 7: Commit**

```bash
git add database/migrations/035_dead_letter_queue.sql database/migrations.lock.json \
        apps/api/src/database/entities/dead-letter-event.entity.ts \
        apps/api/src/common/permissions.ts apps/api/src/dead-letter/dead-letter-metrics.ts \
        apps/worker/src/outbox-dead-letter.ts apps/worker/src/outbox-relay.ts \
        apps/worker/src/outbox-dead-letter.integration.test.ts \
        .agents/runs/2026-08-10-eow-master-execplan/inbox/M7-S2-security-hardening.md
git commit -m "M7-S2 CP7: migration 035 dead-letter queue; fixes D-146

D-146 reproduced first, then fixed: outbox-relay.ts incremented attempts
and rethrew on the first failing row, so a poison event was re-selected
every 60s forever AND aborted the rest of its batch. At-least-once
without a ceiling is a livelock, not at-least-once. The try/catch is now
per row, the batch survives one poison event, and attempts >= 5 moves
the row into dead_letter_event with its last_error. The relay only
rethrows if EVERY row failed -- that is an infrastructure fault worth
surfacing; one poison row is not.

relay_pending_outbox_events() replaced via CREATE OR REPLACE, the
established precedent for a locked function here (023/030/031). Migration
013 untouched.

DEC-151: the DLQ raises no realtime event and no notification.
project.manifest.yaml freezes realtime_events:20 and
notification_rules:16 as reviewed baselines, and BR-NOT-014's trigger
catalogue names no DLQ trigger. 'DLQ co alert' is the
eow_dead_letter_depth metric plus a runbook alert entry, which is how
runbook.md already frames alerting. Rejected: a 21st realtime event
breaking a frozen baseline for a channel nothing consumes.

dlq:manage appended to permissions.ts, seeded and granted to admin only
by 035 -- 004_rbac.sql's blanket admin seed does not cover a later key
(029's own recorded reason for history:export).

<N>/<N> tests; ARCH-MIGRATION green; existing outbox-relay counts unchanged."
```

---

## Checkpoint 8 — DLQ inspect and controlled, idempotent replay

**Files:**
- Create: `apps/api/src/dead-letter/*` (module, controller, service, repository, dto)
- Create: `apps/api/test/recovery/dead-letter-replay.test.ts`
- Create: `docs/operations/dlq-runbook.md`
- Modify: `apps/api/src/app.module.ts`

- [ ] **Step 1: Write the failing test**

`apps/api/test/recovery/dead-letter-replay.test.ts` — `TC-SEC-007` and `TC-SEC-010`.

```ts
  it('TC-SEC-007: an admin can list and inspect dead-lettered events for its own tenant only', async () => {
    const list = await request(app.getHttpServer()).get('/api/v1/dead-letter-events')
      .set('Cookie', adminCookie).expect(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].eventType).toBe('import.job.created');

    const other = await request(app.getHttpServer()).get('/api/v1/dead-letter-events')
      .set('Cookie', otherTenantAdminCookie).expect(200);
    expect(other.body.items).toHaveLength(0);
  }, 30_000);

  it('TC-SEC-007: an operator without dlq:manage is refused', async () => {
    await request(app.getHttpServer()).get('/api/v1/dead-letter-events')
      .set('Cookie', operatorCookie).expect(403);
  }, 30_000);

  it('TC-SEC-010: replaying once produces exactly one effect', async () => {
    const before = await countDownstreamEffect();
    await request(app.getHttpServer())
      .post(`/api/v1/dead-letter-events/${deadLetterId}/replay`)
      .set('Cookie', adminCookie).set('x-csrf-token', adminCsrf)
      .set('Idempotency-Key', replayKey).expect(202);
    expect(await countDownstreamEffect()).toBe(before + 1);
  }, 30_000);

  it('TC-SEC-010: replaying a second time changes no state and no count', async () => {
    // "Consumer xu ly dung mot hieu ung; replay lan hai khong thay doi
    // state/count." Two mechanisms hold this, deliberately: the
    // Idempotency-Key path (idempotency.service.ts returns the stored
    // response without calling create()) and the downstream consumer's own
    // ON CONFLICT DO NOTHING. Assert BOTH, because either alone would leave
    // the guarantee resting on the caller remembering to send a key.
    const before = await countDownstreamEffect();
    const state = await snapshotDeadLetterRow(deadLetterId);

    await request(app.getHttpServer()).post(`/api/v1/dead-letter-events/${deadLetterId}/replay`)
      .set('Cookie', adminCookie).set('x-csrf-token', adminCsrf)
      .set('Idempotency-Key', replayKey).expect(202);
    expect(await countDownstreamEffect()).toBe(before);

    // And with a FRESH key, so the HTTP idempotency layer is bypassed and
    // only the consumer's own idempotency is under test.
    await request(app.getHttpServer()).post(`/api/v1/dead-letter-events/${deadLetterId}/replay`)
      .set('Cookie', adminCookie).set('x-csrf-token', adminCsrf)
      .set('Idempotency-Key', randomUUID()).expect(202);
    expect(await countDownstreamEffect()).toBe(before);

    const after = await snapshotDeadLetterRow(deadLetterId);
    expect(after.replayCount).toBeGreaterThan(state.replayCount);  // the audit trail moves
    expect(after.payload).toEqual(state.payload);                   // the payload never does
  }, 60_000);

  it('TC-SEC-007: every replay writes an audit row naming the actor', async () => {
    // "replay co kiem soat" -- a controlled replay is one you can attribute.
    const audit = await dataSource.query(
      `SELECT actor_id, action, entity_id FROM audit_log WHERE tenant_id = $1 AND action = 'dead_letter.replayed'`,
      [tenant.id]);
    expect(audit.length).toBeGreaterThanOrEqual(1);
    expect(audit[0].actor_id).toBe(adminUserId);
  }, 30_000);
```

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm --filter @eow/api test -- test/recovery/dead-letter-replay.test.ts
```

Expected: FAIL — `404` on every route.

- [ ] **Step 3: Implement the module**

- `dead-letter.repository.ts`: tenant-scoped `list` (paged), `get`, and `markReplayed` (which
  increments `replay_count` and sets `replayed_at` — it never mutates `payload`).
- `dead-letter.service.ts`: `replay(tenantId, id, idempotencyKey, actor)` re-enqueues the stored
  payload onto its original queue, wrapped in `this.idempotency.run(...)` with
  `resourceType: 'dead_letter_replay'`, and writes an `audit_log` row with action
  `dead_letter.replayed`. **Idempotency must not rest on the caller sending a key** — the
  downstream consumer's own `ON CONFLICT DO NOTHING` is the second line of defence and the test
  above asserts it with a fresh key.
- `dead-letter.controller.ts`: three routes, all `@RequirePermission(PERMISSIONS.DLQ_MANAGE)`, the
  replay route additionally `@UseGuards(CsrfGuard)` and `@AuditLog({ action: 'dead_letter.replayed', entityType: 'dead_letter_event' })`
  and requiring an `Idempotency-Key`. `ARCH-RBAC` fails any route missing both `@Public()` and
  `@RequirePermission()`.
- Register `DeadLetterModule` by **appending** to `apps/api/src/app.module.ts`.
- Follow `docs/architecture/module-template.md` — its layering and test-placement rules are
  enforced by `ARCH-MODULE`/`ARCH-LAYERING`.

- [ ] **Step 4: Write `docs/operations/dlq-runbook.md`**

The inspect-and-replay procedure: how to list, how to read `last_error`, how to decide between
replay and discard, the `Idempotency-Key` requirement, and the fact that replay is audited. Add a
one-line pointer to it from `docs/operations/security-baseline.md` (which you own). **Do not touch
`docs/operations/runbook.md`** — it is M7-S3's (protocol §3.6); the alert threshold for
`eow_dead_letter_depth` belongs in M7-S3's alert set, so state the metric name and a suggested
threshold in your inbox for M7-S3 to pick up.

- [ ] **Step 5: Run and commit**

```bash
pnpm --filter @eow/api test -- test/recovery/dead-letter-replay.test.ts
pnpm --filter @eow/architecture-tests test
```

```bash
git add apps/api/src/dead-letter/ apps/api/src/app.module.ts apps/api/test/recovery/ \
        docs/operations/dlq-runbook.md docs/operations/security-baseline.md \
        .agents/runs/2026-08-10-eow-master-execplan/inbox/M7-S2-security-hardening.md
git commit -m "M7-S2 CP8: DLQ inspect and controlled idempotent replay

TC-SEC-010 is asserted twice over, deliberately: once through the
Idempotency-Key path (idempotency.service.ts returns the stored response
without entering create()) and once with a FRESH key, so the consumer's
own ON CONFLICT DO NOTHING is under test on its own. Either mechanism
alone would leave the guarantee resting on the caller remembering to
send a key.

replay_count and replayed_at move; payload never does. Every replay
writes an attributable audit row -- that is what 'replay co kiem soat'
means.

Behind dlq:manage, admin only. runbook.md untouched (M7-S3 owns it); the
eow_dead_letter_depth alert threshold is handed to M7-S3 via the inbox.

<N>/<N> tests."
```

---

## Checkpoint 9 — OpenAPI contract (single late commit)

**Files:**
- Modify: `contracts/openapi.yaml`

- [ ] **Step 1: Save a pre-edit copy, append, verify, commit immediately**

```bash
cp contracts/openapi.yaml ../openapi-before-m7-s2.yaml
```

Append **only** your reserved prefix: `/dead-letter-events`,
`/dead-letter-events/{deadLetterEventId}`, `/dead-letter-events/{deadLetterEventId}/replay`, with
operations `listDeadLetterEvents`, `getDeadLetterEvent`, `replayDeadLetterEvent`, and schemas
`DeadLetterEvent`, `DeadLetterEventListResponse`. Follow the single-line flow style the file uses.
The replay operation takes the `IdempotencyKey` parameter `$ref` the file already defines.

```bash
node scripts/openapi-compat-check.mjs ../openapi-before-m7-s2.yaml contracts/openapi.yaml
pnpm contracts:generate
pnpm --filter @eow/api typecheck
```

Expected: all exit 0. Never stage `packages/contracts/src/openapi.d.ts` (generated, gitignored).

```bash
git add contracts/openapi.yaml .agents/runs/2026-08-10-eow-master-execplan/inbox/M7-S2-security-hardening.md
git commit -m "M7-S2 CP9: /dead-letter-events contract, additive only

Reserved prefix per PARALLEL-EXECUTION-PROTOCOL-M7 §3.3. Committed
immediately and alone, not batched: openapi.yaml is the sharpest
contention point between the four concurrent M7 nodes.

openapi-compat-check against the pre-edit copy: additive only."
```

---

## Checkpoint 10 — Full verification and node handoff

- [ ] **Step 1: Full workspace check, twice, in a quiet window**

Protocol §2.3 — no other node running its suite.

```bash
pnpm --filter @eow/api build
pnpm check
pnpm check
```

Expected: exit 0 both times. Compare test **and skip** counts against your CP0 baseline. A count
that fell is a suite that stopped running, not one that got faster. Skips must be 0.

- [ ] **Step 2: Architecture rules**

```bash
pnpm --filter @eow/architecture-tests test
```

Confirm green individually: `ARCH-CROSS-TENANT` (yours), `ARCH-RBAC`, `ARCH-TENANT`,
`ARCH-MIGRATION`, `ARCH-MODULE`, `ARCH-LAYERING`, `ARCH-TEST-HYGIENE`, `ARCH-ENCODING`,
`ARCH-ASYNCAPI-CONFORMANCE`, `ARCH-JOB-WIRING`.

- [ ] **Step 3: Write the final inbox section**

Status **`ready-for-review`**. Traceability rows to propose:

| rule_id | slice | status to propose | why |
|---|---|---|---|
| `BR-SEC-001` | M7-S2-security-hardening | **test_passing** | Both acceptance clauses evidenced: the secret scan and the written+asserted TLS policy. |
| `BR-SEC-003` | M7-S2-security-hardening | **partially_closed** | Payload half, export expiry, injection and stored XSS are done. **The log-redaction half needs a logger that does not exist on `main`** — `traceability-plan.yaml:293`'s named evidence — and building it is `M7-S3-observability`'s success condition. Say this explicitly. Protocol §8.2. |
| `BR-SEC-007` | M7-S2-security-hardening | **test_passing** | DLQ with alert metric, inspect, and doubly-proven idempotent replay; `D-146` fixed. `TC-SEND-018` is cited but authored by `M7-S4` (protocol §8.7) — do not give it a `test_files` path here. |

Fill the full column set for each row: `openapi_operation_ids`, `asyncapi_channels` (empty — you
added none), `migration_files` (`035_dead_letter_queue.sql` for `BR-SEC-007`), `code_paths`,
`test_case_ids`, `test_files`, `log_or_metric_or_audit` (for `BR-SEC-007`:
`metric eow_dead_letter_depth + audit dead_letter.replayed + dead_letter_event table`).

**Propose `test_passing`/`partially_closed`, never `closed`** — closure requires independent
re-verification on the review machine (protocol §6, §7.4).

Also record:

- The `ARCH-CROSS-TENANT` before/after numbers (uncovered at CP1 → 0 at CP2, and the size of
  `PUBLIC_OR_TENANTLESS` with each reason).
- `D-146` (reproduced, then fixed) and every other `D-*` from D-146…D-150 — expect real findings
  from CP2 (a route returning 200/500), CP4 (stored XSS at the render boundary, CSV formula
  injection) and CP6 (a mutating route with no `CsrfGuard`).
- `DEC-151` (no realtime event/notification for the DLQ) and any further decisions.
- The finding from protocol §8.6: `state.json`'s *"TC-SEC-* (17 cases) executing"* names cases
  belonging to five different owners; yours are six plus `TC-CFG-008`. A reviewing session may
  want a `DEC-*` restating the condition, following the M4-GATE/M5-GATE/DEC-143 precedent. **Do
  not edit `state.json` yourself.**
- The `EnvSecretStore` observation (in-process `Map`, per-app instance, not shared with the worker,
  does not survive restart) as a `D-*` if you confirmed it — it is a real production-readiness gap,
  it is out of `BR-SEC-001`'s acceptance scope, and `secret-store.ts:6` already documents it as a
  deliberate local-only seam. Disclose, do not fix.
- The `eow_dead_letter_depth` metric name and your suggested alert threshold, addressed to M7-S3.

- [ ] **Step 4: Commit and push**

```bash
git add .agents/runs/2026-08-10-eow-master-execplan/inbox/M7-S2-security-hardening.md
git commit -m "M7-S2 CP10: verification complete, ready for review

pnpm check twice: apps/api <F>/<T>, apps/worker <F>/<T>, apps/web <F>/<T>,
packages/architecture-tests <F>/<T>, 0 skipped both runs. CP0 baseline
<...>; no count fell.

BR-SEC-001 and BR-SEC-007 proposed test_passing. BR-SEC-003 proposed
PARTIALLY_CLOSED, not closed: its log-redaction half
(traceability-plan.yaml:293) needs a logger that does not exist on main,
and building it is M7-S3's own success condition. Claiming closure here
would misrepresent work this node cannot do.

ARCH-CROSS-TENANT: <N> uncovered at CP1 -> 0, with <M> reasoned entries
in PUBLIC_OR_TENANTLESS."
git push -u origin m7-s2-security-hardening
```

**Do not merge into `main`. Do not rebase onto `main`. Do not delete the worktree.**

---

## DEFERRED UI / VISUAL HANDOFF — not for Codex

Protocol §1.1: this node touches no front-end file and takes no screenshot. What its rules imply
for the UI, recorded for `M7-S5-perf-a11y-visual`:

1. **`TC-SEC-010` and `TC-SEC-014` are catalogued as `API + UI`.** Only the API half is authored
   here. The UI halves — that a stored XSS payload does not execute when rendered in the recipients
   table or a campaign detail view, and that a DLQ replay's outcome is visible to an operator — are
   Playwright/axe work for `M7-S5`.

2. **The DLQ has no screen.** `GET /dead-letter-events` and the replay route exist and are
   contract-documented, but no screen in `design-reference/ui-handoff-v2/source/` owns a
   dead-letter destination and none of the 13 catalogued screens covers it. This is the same
   situation `UI-CF-001` (custom fields) was in — a production-only surface with no handoff
   counterpart, built new from the existing component vocabulary. Whether M7 needs the screen at
   all, or whether `dlq-runbook.md` plus the API is sufficient for an admin-only recovery tool, is
   a scope decision for the reviewing session. **No `screen-catalog.yaml` entry was added.**

3. **The `403` for a non-`dlq:manage` user needs the standard `permission_denied` presentation** if
   a screen is ever added. That state is one of the six every screen must cover
   (`traceability-plan.yaml:53-56`).

4. **`screen-catalog.yaml` was not edited**; no `states_covered` was written and no capture was
   taken.
