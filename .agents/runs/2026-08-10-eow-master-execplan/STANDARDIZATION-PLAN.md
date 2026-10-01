# Standardization Plan — tenant isolation at the database + generated-code control

**Status:** approved by the human 2026-08-11, not yet executed.
**Author:** review session (orchestrating agent). **Executor:** a different coding agent.
**Reviewer:** the orchestrating agent, after execution.

Read `AGENTS.md` first, then this file in full **before** editing anything. This plan is
written to be executed cold, without the conversation that produced it.

---

## 0. Why this exists

Two milestones of agent-generated code (M1, M2 partial) revealed that project conventions
stated in prose are not actually holding:

- `apps/api/src/segments/segments.service.ts` accesses data with
  `this.dataSource.getRepository(...)` and hand-passed `tenantId`, **bypassing
  `TenantScopedRepository`** — the documented BR-GEN-002 enforcement point that
  `recipients` and `custom-fields` do use. The P0 tenant-isolation invariant is therefore
  enforced *differently per module*, depending on which agent wrote it.
- The architecture tests added in `packages/architecture-tests` did **not** catch it:
  `ARCH-TENANT` only inspects raw SQL (`.query(`), not ORM calls that bypass the tenant
  repository.
- Module shape drifts: `recipients`/`custom-fields` follow controller+module+repository+
  service+dto; `segments` has no repository; `jobs` has 2 controllers + 3 services.
- Test placement is split 16 files in `src/` vs 15 in `test/` with no stated rule.

The goal is **not** to adopt a third-party boilerplate. Evaluated and rejected: Brocoders
NestJS Boilerplate is single-tenant and JWT/passport-based, conflicting with ADR-006
(Secure HttpOnly cookie sessions); adopting it would require retrofitting multi-tenancy —
the highest-risk refactor available — while discarding working, tested M1 code.

The goal is to make the invariant **unbypassable** (database-enforced), and to make new
module code **generated correctly by default** and **mechanically prevented from drifting**.

---

## 1. CRITICAL FINDINGS — read before designing anything

These were verified live against the running database. Getting any of them wrong makes the
work worthless or breaks the product.

### 1.1 The app's database role bypasses RLS entirely

```
SELECT current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user;
-> eow | t | t
```

`eow` is **superuser** and **BYPASSRLS**. PostgreSQL RLS policies are ignored for such a
role. `compose.yaml` gives the *same* `eow` credential to `migrate`, `api`, `worker` and
`scheduler` (lines 55, 75, 104, 133).

**Consequence:** enabling RLS without role separation produces a system that looks
protected, passes a naive "RLS is enabled" check, and blocks nothing. `FORCE ROW LEVEL
SECURITY` does **not** fix this — it forces RLS for the table *owner*, but a superuser /
BYPASSRLS role still bypasses.

**Therefore role separation is mandatory, not optional (task A1).**

### 1.2 The authentication tables cannot be naively RLS-scoped

RLS policies here key on `current_setting('app.tenant_id')`. But the login path must find
the tenant *before* a tenant context can exist:

- `app_user` — login looks the user up **by email** to discover which tenant they belong to.
  With RLS on and no tenant set, that query returns zero rows and **login breaks entirely**.
- `login_attempt` — by deliberate design (DEC-019, migration `003`), an unknown-email
  attempt is recorded with `tenant_id = NULL` so unregistered addresses are still throttled.
  A `tenant_id = current_setting(...)` policy can never match a NULL row.
- `user_session` — validated on every request *before* the tenant is known.
- `password_reset_token` — consumed from an emailed link with no session at all.

**Therefore phase 1 must exclude the auth bootstrap tables**, with the reason recorded. They
are the *least* risky tables to leave out: they are touched only by `apps/api/src/auth/**`,
a module that is already complete, closed and covered by 30 integration tests, and is not
where new agent-written code keeps landing. The business tables — where `segments` already
went wrong — are the actual exposure.

### 1.3 `SET LOCAL` must be transaction-scoped, and the worker spans tenants

- Connection pooling makes a plain `SET` dangerous: the setting leaks to whoever gets that
  pooled connection next. Only `SET LOCAL` inside an explicit transaction is safe.
- `apps/worker` legitimately processes jobs for **every** tenant and has no caller token. It
  must not simply be given a BYPASSRLS role by default, or the largest body of data-mutating
  code in the system keeps the exact hole this plan closes.

### 1.4 Do not reintroduce the known NestJS DI hazard

`apps/api/src/auth/tenant-context.ts` carries a documented hazard (found at M2-S1):
constructor-injecting the REQUEST-scoped `TenantContext` into *another* REQUEST-scoped
provider resolves before the global `AuthGuard` has run, producing false 401s on valid
sessions. The working pattern is: read `request.auth.tenantId` in the controller and pass
it down explicitly. Any tenant-context wiring added by this plan must not violate that.

---

## 2. Workstreams

Execute in the order given. **A** is the largest and highest-value; **B/C** are small and
protect it; **D/E** control future generated code. Checkpoint `state.json` after each task.

---

### Workstream A — Database-enforced tenant isolation (PostgreSQL RLS)

**Outcome:** a cross-tenant read is refused by PostgreSQL itself, even when application code
does exactly what `segments` does today.

#### A1. Role separation *(blocking prerequisite — see 1.1)*

- Add a migration `database/migrations/011_app_role.sql` that creates a login role
  `eow_app` with `NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`, and grants it
  `USAGE` on schema `public`, `SELECT, INSERT, UPDATE, DELETE` on the tenant-owned tables,
  and `USAGE, SELECT` on sequences. `eow` remains the owner and the migration role.
- The role password must come from a new environment variable
  `EOW_POSTGRES_APP_PASSWORD`, generated locally, never hardcoded. Because a role password
  cannot be parameterised in plain DDL, the migration must read it from a psql variable that
  `database/migrate.sh` passes through (`migrate.sh` already pipes SQL via stdin — see the
  D-16 fix — so `:'var'` interpolation works there).
- Update **together** (AGENTS.md §2 one-command deployment contract):
  `compose.yaml` (`api`, `scheduler`, and `worker` `DATABASE_URL` switch to `eow_app`;
  `migrate` keeps `eow`), `.env.deploy.example`, `.env` (local), and
  `docs/deployment/environment-variables.md`.
- **Acceptance:** `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname='eow_app'`
  returns `f | f`.

#### A2. Enable RLS on business tables

Scope for phase 1 — the 24 tables carrying `tenant_id`, **minus** the four auth bootstrap
tables excluded per 1.2:

Included: `recipient`, `recipient_list`, `recipient_list_member`, `recipient_tag`, `tag`,
`recipient_custom_value`, `custom_field_definition`, `campaign`, `campaign_recipient`,
`campaign_snapshot`, `email_template`, `email_template_version`, `import_job`, `bulk_job`,
`notification`, `user_notification`, `audit_log`, `outbox_event`, `idempotency_key`,
`user_role`.

Excluded in phase 1, with the reason written into the migration header:
`app_user`, `user_session`, `login_attempt`, `password_reset_token` (see 1.2).

Note `import_job_row` / `bulk_job_row` have no `tenant_id` of their own — confirm against
`008_import_bulk_jobs.sql` and either scope them through their parent job or add them to a
documented exclusion list; do not silently skip them.

For each included table, in `database/migrations/012_rls.sql`:

```sql
ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <t> FORCE ROW LEVEL SECURITY;
CREATE POLICY <t>_tenant_isolation ON <t>
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
```

- `current_setting(..., true)` returns NULL when unset, so the predicate is false and the
  query returns nothing. **Fail-closed is intended** — an unset context must never mean
  "see everything".
- `WITH CHECK` is required, not optional: without it a caller can *write* a row belonging to
  another tenant even though it cannot read one.
- Must be idempotent on re-run (`DROP POLICY IF EXISTS` first, or a guard block) —
  `migrate.sh` re-applies and DEPLOY-004 asserts idempotency.
- `audit_log` already has a BEFORE UPDATE/DELETE immutability trigger from
  `005_audit_log_immutability.sql`; verify RLS and that trigger coexist.

#### A3. Tenant context propagation in `apps/api`

Every request must run its queries inside a transaction that has executed
`SET LOCAL app.tenant_id = $1`.

- Recommended shape: a Nest interceptor (or an explicit helper used by services) that opens
  a TypeORM transaction, sets the GUC from `request.auth.tenantId`, and exposes that
  transaction's `EntityManager` for the request's data access.
- **Constraint:** must not constructor-inject `TenantContext` into a REQUEST-scoped provider
  (see 1.4). Read `request.auth.tenantId` in the controller, as `recipients` already does.
- `TenantScopedRepository` should continue to apply its application-level `tenantId` filter.
  RLS is defence in depth *beneath* it, not a replacement — keep both, so a failure of either
  layer alone is not a leak.

#### A4. Worker tenant context *(design decision — state the choice and why)*

The worker claims jobs across tenants, then processes rows belonging to exactly one tenant.
Recommended: after claiming a job, set `app.tenant_id` to **that job's** `tenant_id` for the
row-processing transactions, so the bulk of worker data mutation is RLS-protected. The
narrow claim/poll query is the only part that needs to see across tenants — give it either a
dedicated role with `BYPASSRLS`, or a policy exception scoped to the claim statement only.

Whichever is chosen, record it as a numbered Decision Log entry in `EXECPLAN.md` §20 with
the rejected alternative. Do **not** give the whole worker BYPASSRLS silently.

#### A5. Proof (this is the acceptance evidence, not optional)

Add `apps/api/test/integration/rls-tenant-isolation.test.ts`:

1. Seed two tenants, each with one recipient.
2. Connect as `eow_app`, set `app.tenant_id` to tenant A, and run the **exact bypass pattern
   `segments` uses today** — `dataSource.getRepository(RecipientEntity).find()` with no
   tenant filter whatsoever. Assert only tenant A's rows come back.
3. Assert an attempted cross-tenant `INSERT`/`UPDATE` (tenant A context, tenant B
   `tenant_id`) is refused by the `WITH CHECK` clause.
4. Assert that with **no** `app.tenant_id` set, the query returns zero rows (fail-closed).
5. Assert the same queries as `eow` (superuser) still bypass — documenting *why* the
   application must never connect as `eow`.

**A is complete only when test 2 passes**, because that is the literal defect this
workstream exists to make impossible.

#### A6. Rollback

RLS is reversible forward-only: a later migration issuing `DISABLE ROW LEVEL SECURITY` per
table restores previous behaviour. Never edit `011`/`012` after they are applied
(AGENTS.md §5; `packages/architecture-tests` `ARCH-MIGRATION` pins their checksums, and
`database/migrations.lock.json` must be updated as part of adding them).

---

### Workstream B — Bring `segments` onto the standard layering

- Add `apps/api/src/segments/segments.repository.ts` extending `TenantScopedRepository`,
  mirroring `apps/api/src/recipients/recipients.repository.ts`.
- Move `segments.service.ts`'s `this.dataSource.getRepository(...)` calls onto it.
- Behaviour must not change: `apps/api/test/integration/segments-http.test.ts` and the
  M2-S2 rules already marked `closed` must still pass unmodified.
- **Do not** treat RLS as a reason to skip this. RLS stops the leak; consistent layering is
  what stops the next agent from re-deriving a third pattern.

---

### Workstream C — Close the hole in the architecture tests

`packages/architecture-tests/src/tenant-isolation.test.ts` currently inspects only raw SQL.

- Extend it: outside `apps/api/src/database/**` and a documented allowlist, application code
  must not call `dataSource.getRepository(` / `manager.getRepository(` on a **tenant-owned
  entity** — it must go through a `TenantScopedRepository` subclass.
- **Verify the rule by deliberately breaking it**, as the existing five rules were: confirm
  it fails on `segments` *before* Workstream B fixes it, and passes after. A rule that was
  never seen to fail is not evidence.
- Add `ARCH-MODULE`: every directory under `apps/api/src/<module>/` that contains a
  `*.controller.ts` must also contain `*.module.ts`, `*.service.ts` and a `dto/` directory;
  a module touching a tenant-owned entity must also have `*.repository.ts`. Allowlist
  `auth` (legitimately special) and `jobs` with written reasons, or refactor them.

---

### Workstream D — Make new modules generated correctly by default

This is the part that actually controls future agent output.

- Write `docs/architecture/module-template.md`: the canonical module shape, derived from
  `apps/api/src/recipients/**` (the module that follows every convention), covering file
  layout, layering, where validation lives (zod DTO + pipe), permission decorators, the
  `@AuditLog` convention, and **where tests go** (state the rule and apply it — the current
  16/15 split is undocumented drift).
- Add a NestJS custom schematic (`@nestjs/schematics` supports custom collections) so
  `nest g` scaffolds that exact shape, including the repository extending
  `TenantScopedRepository` and a placeholder integration test.
- Reference the template from `AGENTS.md` §2 so the next agent reads it before creating a
  module.

---

### Workstream E — ArchUnitTS *(optional; do last, only if A–D are green)*

`ArchUnitTS` (MIT, ~453 stars, works with Vitest) provides layer/dependency rules, naming
conventions and cycle detection far better than hand-rolled scanning. Candidate uses: no
cycles under `apps/api/src/**`, controllers must not import `database/entities` directly,
naming conventions per the module template.

Keep the five existing project-specific rules as they are — they encode business rules
(handoff CSS fidelity, migration immutability, tenant scoping) no generic library ships.
Adopt ArchUnitTS **in addition**, not as a replacement, and only if it does not fight the
existing suite. Requires `globals: true` in the vitest config.

---

## 3. Sequencing and dependencies

```
A1 (role separation) ──> A2 (RLS policies) ──> A3 (API context) ──> A5 (proof)
                                             └─> A4 (worker context) ──┘
                                                        │
C-tenant (ORM-bypass rule) ──catches──> B (fix segments) │
                                                        v
                          F1/F2/F3 (restructure + delete dead code)
                                                        │
                                                        v
                          C2/F4 (ARCH rules, written against the POST-F shape)
                                                        │
                                                        v
                          D (template + schematic generating the POST-F shape)
                                                        │
                                                        v
                          E (ArchUnitTS, optional)
```

Gates, in order of importance:

1. **`A5` gates workstream A** — specifically its test 2, the `segments`-style raw bypass.
2. **`B` must not be merged before `C-tenant` has demonstrably failed on it.** A rule never
   seen failing is not evidence.
3. **`D` must not start before `F` is complete.** This corrects the original draft, which had
   D running "in parallel with A": generating a schematic from today's structure would bake
   the current drift into every future module — the opposite of this plan's purpose.
4. `C2`/`F4` encode the **post-F** shape, so they must follow F as well.

---

## 4. Risks

| Risk | Mitigation |
|---|---|
| RLS enabled while app still connects as `eow` → protection is theater | A1 is a blocking prerequisite; A5 test 5 explicitly documents the superuser bypass |
| Login breaks because `app_user` is RLS-scoped | Auth bootstrap tables excluded in phase 1 (1.2), with the reason in the migration header |
| `SET` leaks across pooled connections | `SET LOCAL` inside an explicit transaction only (1.3) |
| Worker silently given BYPASSRLS, keeping the hole open where most writes happen | A4 requires a written Decision Log entry naming the rejected alternative |
| Wide breakage of the existing 230 tests | Run the full suite after **each** of A1, A2, A3; do not batch |
| False 401s from the DI hazard | 1.4 — do not inject `TenantContext` into a REQUEST-scoped provider |

---

## 5. Definition of done

- `pnpm run check` exits 0 with **0 failed and 0 skipped**, and a test count strictly
  higher than the current baseline of **230** (api 190 + web 15 + worker 13 + arch 9 +
  runtime-orchestration 3). Report the count, not just the exit code (AGENTS.md §2).
- `docker compose --env-file .env run --rm migrate` applies cleanly and re-runs idempotently
  for all migrations including the new ones.
- `docker compose --env-file .env config --quiet` exits 0; every new environment variable is
  in **both** `.env.deploy.example` and `docs/deployment/environment-variables.md`.
- `python .agents/runs/2026-08-10-eow-master-execplan/validate_plan.py` → 0 errors.
- `database/migrations.lock.json` updated for the new migrations.
- `packages/architecture-tests` all green, **and** every new rule in C **and F4** was
  observed failing on a real violation before being made to pass (paste the failing output).
- Structure is actually clean, not merely ruled: `find apps/api/src -maxdepth 1 -name '*.ts'`
  returns only `main.ts` and `app.module.ts`; `grep -rn "campaign.progress.updated"
  apps/web/src` returns nothing (DRIFT-01 gone with the dead `App.tsx`).
- Visual evidence at the three viewports still matches M1/M2 after deleting `styles.css` —
  a design-system regression must not ride along with the cleanup.
- `EXECPLAN.md` §18/§19/§20 updated: a Progress entry, any new `D-nn` discoveries, and
  numbered Decision Log entries for **(a)** the A4 worker context choice, **(b)** the §1.2
  auth-table exclusion, **(c)** the `jobs/` split-or-keep decision (F1), and **(d)** any
  refactor-register item acted on.
- `state.json` checkpointed after every task, never left `running` (AGENTS.md §2).
- Refactor register (§7) triaged: R1–R3 either done or explicitly deferred with a reason;
  R4–R5 either left alone or carried through a superseding ADR — never silently changed.

## 6. Out of scope

Do not finish `M2-S4-import-bulk`, do not run `M2-GATE`, do not capture the missing M2-S2
visual evidence. Those remain separate, already-tracked items.

---

## 7. Refactor register — older choices now superseded

Compiled by a final review pass with the explicit instruction *not* to defer to earlier
decisions: where a better approach now exists, the earlier one is listed here as a refactor
candidate rather than being grandfathered. Each row states the evidence, so a future agent
can re-judge instead of trusting this table.

| # | Legacy thing | Why it is now the wrong choice | Replace with | Evidence |
|---|---|---|---|---|
| **R1** | `tsx watch` as the `dev` script in **all three** backend apps (`api`, `worker`, `scheduler`) | esbuild does not emit `emitDecoratorMetadata`, so NestJS constructor DI is silently broken: Nest boots, maps every route, prints "successfully started", then 500s on the first handler that touches an injected service. `pnpm dev` is unusable for any controller with a dependency. Deferred at DEC-022 as "out of proportion for a sign-in slice" — that justification has expired: it has since cost debugging cycles in M1 and M2 and every future node inherits it. | Nest CLI's SWC builder (`@swc/core`), or `tsc --watch` + `node --watch dist/main.js` | D-20, D-22, DEC-022 |
| **R2** | `pnpm check` ordered `typecheck → test → build` | `boot.test.ts` spawns the compiled `dist/main.js`, so tests run against a **stale build**. Produced a false failure **twice** — once during the M1-S3 recovery, once during this review — each time costing a debugging cycle to rediscover. | Reorder to `typecheck → build → test`, or make `boot.test.ts` build on demand | This session, twice |
| **R3** | **No skipped-test detection** | The D-33 regression hid **30 skipped tests** behind a green-looking "158 passed" summary. This was mechanism #1 of the original enforcement proposal and was **dropped when this plan was first drafted** — recorded here so it is not lost again. AGENTS.md §5 forbids skipped tests but nothing measures them. | Fail the workspace check when `skipped > 0`; re-examine `--passWithNoTests` on the five packages that now have real tests | D-33 |
| **R4** | `@refinedev/core` declared as a dependency, imported **nowhere** | ADR-002 calls Refine the "production architecture foundation", but reality diverged: `apps/web` runs on TanStack Query + types generated from `openapi.yaml`, and that has worked across two milestones. The declaration now misleads every new agent about which data layer to use. | Decide explicitly: remove + write a superseding ADR (recommended — it matches the architecture actually running), or genuinely adopt it | DRIFT-06, open since discovery |
| **R5** | `openapi.yaml` hand-maintained with no cross-check against the code | Contract drift is this project's most repeated defect class (6 found at discovery; DRIFT-01 still lives in dead code today). Nothing detects a route whose implementation and spec disagree. | Keep contract-first per ADR-005, but add `@nestjs/swagger` purely as a **validator**: generate a spec from code and diff it against the hand-written one in CI | DRIFT-01…06 |
| **R6** | `TenantContext` (REQUEST-scoped provider) | Carries a documented DI hazard whose root cause was never bisected, and is already worked around everywhere by passing `tenantId` explicitly from the controller. After A3 introduces `runInTenantContext`, it is likely fully redundant. | Re-evaluate after A3; delete if nothing needs it | `tenant-context.ts` header comment |
| **R7** | Worker integration tests build connection strings inline (3 files) | Same duplication class that caused D-33. They currently pass `ARCH-TEST-HYGIENE` only because they interpolate `process.env`; the moment one drifts, the D-33 failure mode returns. | Extract to shared helpers alongside `testDatabaseUrl` / `testRedisUrl` | This session |
| **R8** | `audit_log` immutability trigger vs. test teardown | A test tenant that owns even one audit row can no longer be deleted, so fixture rows accumulate in the dev database on **every run**. Correct behaviour per BR-SEC-002, wrong outcome for tests. | A deliberate teardown strategy (elevated-role truncate in test setup, or a per-run schema) | D-32 |
| **R9** | Hand-rolled file scanning inside `packages/architecture-tests` | Fine for the five business-rule tests, but weak for structural rules — and it already produced a false-positive cascade (37 phantom RBAC violations from a one-directional decorator scan) that had to be debugged. | Move *structural* rules (cycles, layering, naming, orphans) to ArchUnitTS / dependency-cruiser; keep the business-rule tests hand-written | Workstreams E, F4 |

**How to treat this register:** R1–R3 are cheap, self-contained, and remove recurring pain
for every future node — do them opportunistically inside this plan's execution. R4–R5 change
an accepted ADR's practical meaning and therefore need a **superseding ADR** (AGENTS.md §5),
not a silent edit. R6–R9 are follow-ups that become clearly decidable only *after* the
corresponding workstream lands; re-judge each then rather than pre-committing now.

---

# APPENDIX — executable detail

Everything below was verified live against the running database on 2026-08-11. Use these
lists directly; do not re-derive them, and do not guess.

## A. Authoritative table classification (31 tables)

Queried from `information_schema`. **Do not add or drop tables from these groups without
saying why in the migration header.**

### Group 1 — RLS in phase 1, direct `tenant_id` policy (20 tables)

```
audit_log            campaign             campaign_recipient   campaign_snapshot
custom_field_definition                   email_template       email_template_version
idempotency_key      import_job           bulk_job             notification
outbox_event         recipient            recipient_custom_value
recipient_list       recipient_list_member                     recipient_tag
tag                  user_notification    user_role
```

Policy body for each:

```sql
USING       (tenant_id = current_setting('app.tenant_id', true)::uuid)
WITH CHECK  (tenant_id = current_setting('app.tenant_id', true)::uuid)
```

Note several of these (`campaign*`, `email_template*`, `notification`, `user_notification`)
are created by `001_initial.sql` but not yet used by any milestone. Cover them now anyway —
M3–M6 will land on tables that are already protected, instead of needing a retrofit.

### Group 2 — RLS via parent join, no own `tenant_id` (2 tables)

`import_job_row` and `bulk_job_row` both key to their parent by **`job_id`** (verified —
the column is `job_id`, not `import_job_id`):

```sql
CREATE POLICY import_job_row_tenant_isolation ON import_job_row
  USING (EXISTS (SELECT 1 FROM import_job j
                 WHERE j.id = import_job_row.job_id
                   AND j.tenant_id = current_setting('app.tenant_id', true)::uuid));
```

Same shape for `bulk_job_row` against `bulk_job`. Add the matching `WITH CHECK`. Confirm
the join column against `008_import_bulk_jobs.sql` before writing the migration.

### Group 3 — deliberately excluded, auth bootstrap (4 tables)

`app_user`, `user_session`, `login_attempt`, `password_reset_token` — see §1.2. Write the
reason into the migration header so a later agent does not "fix the omission" and break login.

### Group 4 — no RLS, not tenant-owned (5 tables)

`role`, `permission`, `role_permission` (global catalogues seeded by `004_rbac.sql`),
`schema_migrations` (migration infrastructure), `tenant` (the tenant registry itself —
a tenant row cannot be scoped by its own id without breaking login's tenant lookup).

## B. Concrete design for A3 — tenant context propagation

This is the hardest task and the one most likely to be done wrong. Required properties:

1. `app.tenant_id` must be set with `SET LOCAL`, **inside** the transaction that runs the
   query (a bare `SET` leaks to the next user of that pooled connection).
2. It must be derived from `request.auth.tenantId`, read **in the controller** — never by
   constructor-injecting `TenantContext` into a REQUEST-scoped provider (§1.4).
3. It must fail closed: no authenticated tenant ⇒ no context set ⇒ policies match nothing.

Recommended implementation, in order of preference:

**Option 1 (preferred): an explicit `runInTenantContext` helper.**

```ts
// apps/api/src/database/tenant-transaction.ts
export async function runInTenantContext<T>(
  dataSource: DataSource,
  tenantId: string,
  work: (manager: EntityManager) => Promise<T>,
): Promise<T> {
  return dataSource.transaction(async (manager) => {
    await manager.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    return work(manager);
  });
}
```

`set_config(..., true)` is the function form of `SET LOCAL` and accepts a bind parameter —
important, because `SET LOCAL app.tenant_id = $1` is **not** parameterisable and would force
string interpolation into SQL. Services take the `manager` and use it for all access in that
unit of work. This is explicit, testable in isolation, and does not fight NestJS DI.

**Option 2: a global interceptor** that opens the transaction and stashes the manager on the
request. Less code at call sites, but every service must then be careful to use the request's
manager rather than `dataSource.manager`, and a missed call site silently escapes the
transaction — and therefore the tenant context. If chosen, workstream C must add a rule that
no service reads `dataSource.manager` directly.

Whichever is chosen, record it as a Decision Log entry with the rejected option.

`TenantScopedRepository` keeps its application-level `tenantId` filter — RLS sits beneath it
as defence in depth, so a failure of either layer alone is not a leak.

## C. Task checklist with verification commands

Tick these in order. Run the stated command and record its real output as evidence.

| # | Task | Verification |
|---|---|---|
| A1.1 | `011_app_role.sql` creates `eow_app` (NOSUPERUSER NOBYPASSRLS) + grants | `psql -tAc "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname='eow_app'"` → `f\|f` |
| A1.2 | `EOW_POSTGRES_APP_PASSWORD` added to `.env`, `.env.deploy.example`, `docs/deployment/environment-variables.md`; `compose.yaml` api/worker/scheduler switched, `migrate` left as `eow` | `docker compose --env-file .env config --quiet` → exit 0 |
| A1.3 | Full suite still green **before** touching RLS | `pnpm run check` → 0 failed, 0 skipped, ≥230 tests |
| A2.1 | `012_rls.sql` — Groups 1 + 2, idempotent (`DROP POLICY IF EXISTS` first) | `docker compose --env-file .env run --rm migrate` twice → second run says "already applied" |
| A2.2 | RLS actually on | `psql -tAc "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND rowsecurity"` → 22 |
| A2.3 | Full suite after RLS | `pnpm run check` → report count; triage every new failure, do not mass-skip |
| A3.1 | `runInTenantContext` (or chosen option) implemented | unit test proving the GUC is set and rolled back with the transaction |
| A3.2 | Business modules routed through it | `pnpm run check` green |
| A4.1 | Worker context decision + implementation | worker integration tests still pass against real PG/Redis |
| A4.2 | Decision Log entry written | `EXECPLAN.md` §20 has a new numbered `DEC-nnn` |
| A5 | `rls-tenant-isolation.test.ts`, all 5 assertions of §A5 | **test 2 (the `segments` bypass pattern) must pass** |
| C1 | ARCH rule extended, observed **failing** on `segments` | paste the failing output into evidence |
| B1 | `segments.repository.ts` added, service routed through it | `segments-http.test.ts` passes unmodified; ARCH rule now green |
| C2 | `ARCH-MODULE` added | `pnpm --filter @eow/architecture-tests test` green |
| F1 | Loose api features moved into module dirs (`campaigns/`, `notifications/`, `health/`, `realtime/`); `jobs/` decision recorded | `find apps/api/src -maxdepth 1 -name '*.ts'` → only `main.ts`, `app.module.ts` |
| F2 | `App.tsx` + root `api.ts` deleted after confirming zero importers; `realtime.ts` relocated | `pnpm run check` green; `grep -rn "campaign.progress.updated" apps/web/src` → no hits (DRIFT-01 gone) |
| F3 | Test-placement rule written into the module template; outliers fixed | rule stated in `docs/architecture/module-template.md` |
| F4 | `ARCH-NO-LOOSE-FEATURES`, `ARCH-LAYERING`, `ARCH-WEB-STRUCTURE`, `ARCH-NO-ORPHANS` added | each observed failing on a real violation first; then `pnpm --filter @eow/architecture-tests test` green |
| C2 | `ARCH-MODULE` added, written against the **post-F** shape | `pnpm --filter @eow/architecture-tests test` green |
| D1 | `docs/architecture/module-template.md` written | referenced from `AGENTS.md` §2 |
| D2 | Custom schematic scaffolds the **post-F** template shape | generate a throwaway module, confirm shape, delete it |
| E | ArchUnitTS (optional) | only if A–D green |

## D. Expected breakage — triage guide, not a surprise

Enabling RLS will break tests that assume unrestricted reads. Anticipated:

- Any integration test that seeds data as one tenant and reads without setting
  `app.tenant_id` will now legitimately see **zero rows**. Fix by setting the context, not by
  weakening the policy.
- `apps/api/test/integration/tenant-scoped-repository.test.ts` deliberately attempts
  cross-tenant access; its expectations may now be satisfied one layer lower. Keep the test
  and confirm *which* layer refuses.
- Worker integration tests claim jobs across tenants — the A4 decision determines whether
  they need a context or a bypass role.
- Fixture cleanup in `afterAll` may fail to delete rows it can no longer see.

**Rule: never make a test pass by disabling a policy or adding `.skip`.** AGENTS.md §5, and
`ARCH-TEST-HYGIENE` will fail the build on a committed `.skip` anyway.

## E1. Workstream F — directory restructuring *(added after review: the original plan had the
enforcement rule but no restructuring task, and omitted `apps/web` entirely)*

`ARCH-MODULE` in workstream C enforces a shape, but nothing currently **moves the code into
that shape**, and several features do not follow it at all. Verified live:

### F1. `apps/api/src` — features living loose at the root, outside any module

```
campaigns.controller.ts  campaigns.service.ts        -> campaigns/
notifications.controller.ts  notifications.service.ts -> notifications/
health.controller.ts                                  -> health/
realtime.gateway.ts  realtime-job-rooms.ts(+test)     -> realtime/
```

Five features (`auth`, `recipients`, `segments`, `custom-fields`, `jobs`) are proper module
directories; these four are loose files at `src/` root. That is the same "each agent
re-derives the structure" drift as the `segments` repository omission. Move each into a
module directory with its own `*.module.ts`, and update `app.module.ts` imports.

`jobs/` must also be resolved rather than allowlisted forever: it holds 2 controllers
(`jobs.controller.ts`, `bulk-jobs.controller.ts`) and 3 services. Either split into
`import-jobs/` and `bulk-jobs/`, or keep it as one module with a written justification in the
module template doc. **Decide and record it — do not leave it as an open allowlist entry.**

### F2. `apps/web/src` — dead code, one piece carrying a known contract bug

Verified by import analysis:

| File | Status | Action |
|---|---|---|
| `App.tsx` | **dead** — nothing imports it (`main.tsx` renders `AppRoutes`; the only "App" match is the unrelated `AppShell`) | **Delete.** It still subscribes to `campaign.progress.updated` — the non-existent event name recorded as **DRIFT-01** in discovery. Deleting it removes that drift from the codebase ahead of M6-S1. |
| `api.ts` (root) | **dead** — imported only by the dead `App.tsx`; live code uses `api/auth.js`, `api/segments.js`, … | **Delete.** It duplicates the `api/` directory and is a trap for the next agent. |
| `realtime.ts` (root) | **alive** — imported by `screens/recipients/RecipientsScreen.tsx` | Move under a directory (e.g. `api/realtime.ts` or `realtime/`) so the root holds only `main.tsx` + entry assets. |
| `styles.css` | **legacy starter CSS — resolved, delete with `App.tsx`** | It *is* imported (`main.tsx:8`) but only exists to style the dead `App.tsx`: `.shell` is referenced nowhere else. Its `:root` rules hardcode `font-family: Inter`, `color:#172033`, `background:#f4f7fb` — non-token values that contradict the approved design system. `globals.css` sets the same properties on `body`, which wins for the body element, so the visible damage is limited to the html-level background (overscroll colour); but this is legacy config fighting the approved tokens and must not survive. Delete the file and its import together with `App.tsx`, then confirm the three viewports still match the M1/M2 visual evidence. |

Do **not** delete anything without first confirming zero importers; record the check.

### F3. Test file placement — decide the rule, then enforce it

Currently split with no stated rule: **16** `*.test.ts` under `apps/api/src/`, **15** under
`apps/api/test/`. Pick one convention and apply it, e.g. co-located unit tests in `src/`
next to their subject, and integration/e2e (anything needing real PostgreSQL/Redis) under
`test/integration/`. That happens to describe the current split fairly well — if so, write it
down as the rule and fix the outliers rather than moving everything.

### F4. Tests that enforce the structure *(this is the part that keeps it from drifting back)*

Add to `packages/architecture-tests`:

- **`ARCH-NO-LOOSE-FEATURES`** — no `*.controller.ts` / `*.service.ts` / `*.gateway.ts`
  directly under `apps/api/src/`; features live in module directories. Allowlist only
  `main.ts` and `app.module.ts`.
- **`ARCH-MODULE`** (from C) — written against the **post-F1 shape**, so it encodes the real
  target rather than today's drift.
- **`ARCH-LAYERING`** — controllers must not import `database/entities/**` directly; data
  access goes through a service/repository. Catches the layering shortcut before it spreads.
- **`ARCH-WEB-STRUCTURE`** — `apps/web/src` root contains only entry files; screens live in
  `screens/`, overlays in `overlays/`, API clients in `api/`. The frontend currently has
  **no architectural rule at all**, which is why dead files accumulated there unnoticed.
- **`ARCH-NO-ORPHANS`** — no unreachable module. `dependency-cruiser` has built-in orphan
  detection and is the right tool here; a hand-rolled importer scan is acceptable if adding
  the dependency is not wanted. This is what would have caught `App.tsx` automatically.

Each rule must be **observed failing on a real violation before being made to pass**, same
as the existing five.

### F5. Sequencing note — F changes the target that C and D encode

Revised order: **A → B → F1/F2/F3 → C (ARCH rules, written against the post-F shape) →
D (template + schematic generating the post-F shape) → E**.

Writing the schematic (D) before the restructure (F) would bake today's drift into every
future generated module — the exact opposite of this plan's purpose.

## E. Reviewer's checklist (what this session will verify independently)

The reviewing session will **not** accept the executing agent's report at face value — the
last handover reported success while 30 tests were silently skipped. It will:

1. Re-run `pnpm run check` itself and compare **test count and skip count**, not exit code.
2. Re-run the deliberate-break checks: confirm each new ARCH rule fails on a real violation.
3. Independently prove RLS by connecting as `eow_app`, setting tenant A, and running the raw
   `segments`-style query — and by connecting with **no** context and confirming zero rows.
4. Confirm `rolbypassrls = f` for the role the app actually uses in `compose.yaml`.
5. Check `traceability.csv` / `screen-catalog.yaml` were not marked closed ahead of evidence.
6. Re-run `validate_plan.py` and `docker compose config --quiet`.
