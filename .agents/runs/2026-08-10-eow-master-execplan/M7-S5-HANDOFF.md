# Handoff — M7-S1…S4 merged and closed; `M7-S5-perf-a11y-visual` is next

Written 2026-08-19 by the review session that merged the four parallel M7 branches.
Everything below is committed and pushed: `origin/main` is at `796e167`.

`M7-S5` is the **only** node blocking `M7-GATE`. It is also the first node in a while that
**cannot be delegated to Codex** — see [Why this node is different](#why-this-node-is-different).

---

## Where to work

Primary working tree, on `main`, clean and in sync with `origin/main`:

```
C:\Works\Projects\Email operations workspace\email-operations-workspace
```

Do **not** create a worktree for this node. The four M7 branches
(`m7-s1-quota`, `m7-s2-security-hardening`, `m7-s3-observability`, `m7-s4-deployment-backup`)
are merged; they still exist on `origin` and can be deleted once you are satisfied nothing is
missing from them. The four Codex worktrees live on the *other* machine and are that machine's to
clean up.

---

## Mandatory read order (per `AGENTS.md` §1 — do not skip)

1. `AGENTS.md`
2. `project.manifest.yaml`, `docs/00-start-here.md`
3. **`design-reference/ui-source-contract.yaml`** and `design-reference/visual-acceptance.md` —
   this node is frontend scope, so §2.1 applies in full and these are not optional.
4. `.agents/orchestration-policy.yaml`, `.agents/approval-policy.yaml`, `.agents/agent-graph.yaml`
5. `state.json` — specifically `M7-S5-perf-a11y-visual`'s four `successConditions`, and the
   `evidence` arrays on the four completed M7 nodes (they contain the measured numbers this
   session produced; do not re-derive them)
6. `traceability.csv` — read the `BR-SEC-006` row **directly**, plus `BR-SEC-005` (still
   `partially_closed`) and `BR-SEND-004` (still `partially_closed`)
7. `screen-catalog.yaml` — the 13 screens and 39 overlays, and what each already claims
8. `PARALLEL-EXECUTION-PROTOCOL-M7.md` §1.1 and §6 — §6 defines what "done" means for a visual node
9. `EXECPLAN.md` Decision Log: **DEC-146…DEC-169**, and Discoveries **D-141…D-172**. These are
   this batch's record. D-166, D-170, D-171, D-172 matter most to you.
10. `docs/index.yaml` → routes for `ui_design`, `frontend`, `qa`

---

## What the previous session completed

Four branches merged one at a time, each independently re-verified here rather than trusted from
the execution host. Full detail is in each node's `state.json` `evidence` array; the short version:

| Node | Rules | Status |
|---|---|---|
| `M7-S1-quota` | `BR-CFG-006` | completed, rule **closed** |
| `M7-S2-security-hardening` | `BR-SEC-001`, `BR-SEC-003`, `BR-SEC-007` | completed, all three **closed** |
| `M7-S3-observability` | `BR-SEND-013` + `BR-SEC-003` log half | completed, **closed** |
| `M7-S4-deployment-backup` | `BR-SEC-004`, `BR-SEC-005` | completed; `BR-SEC-004` **closed**, `BR-SEC-005` **partially_closed** |

**Measured on the merged tree, all 0 skipped, all exit 0:**

```
apps/api                     113 files /  826 tests
apps/worker                   35 files /  151 tests   (with --no-file-parallelism)
apps/web                      23 files /   73 tests
packages/architecture-tests   18 files /  125 tests
```

Pre-merge baseline was 89/649, 31/144, 23/73, 16/119. **Every count rose; none fell.** That is
your comparison point — a count that drops is a suite that stopped running, not one that got
faster (`AGENTS.md` §2).

Migrations 034, 035, 036 and 066 all apply forward against the populated database.
`validate_plan.py`: ERRORS 0, WARNINGS 1 (the known D-133 baseline warning over 34 pre-M7 rows).
`docker compose --env-file .env config --quiet` and `python scripts/smoke_deploy.py` both exit 0.

Six real defects were found **at merge**, none visible to any single node: D-167 (cross-tenant
coverage gap), D-168 (`smoke_deploy.py` could never pass on Compose v2), D-169 (three architecture
rules), D-170 (over-redaction broke 10 test files), D-171 (a real send-path performance
regression), plus migration 066. All fixed and recorded.

---

## Why this node is different

`PARALLEL-EXECUTION-PROTOCOL-M7.md` §1.1: **Codex does no image work at all.** Every previous M7
node was backend and could be handed out. This one is 13 screens × 3 viewports × 6 required
states, plus focus traps on 39 overlays. It must be done by a Claude session.

§6 is explicit about the standard, and it exists because of a real incident:

> Run and **individually inspect** every visual capture the node's screens require.

`EXECPLAN` D-42: all three M4-S1 "drafts success" captures showed a loading spinner underneath a
green screenshot test. **A passing visual test is not evidence the right thing rendered.** Open
every image and look at it.

---

## The scope decision you must make first

The four merged plans each ended with a `DEFERRED UI / VISUAL HANDOFF` section. Collected:

| From | Deferred UI work |
|---|---|
| M7-S1 | Quota limit/period control and usage indicator on `UI-CFG-002` (`/settings/policy`); a client subscriber for `quota.threshold_reached` on the `org:{tenantId}` room; presentation for the `429 QUOTA_EXCEEDED` Problem body + `Retry-After` |
| M7-S2 | Whether a DLQ screen exists at all — no screen in the approved handoff owns that destination; also the UI halves of `TC-SEC-010` and `TC-SEC-014` (both catalogued `API + UI`) |
| M7-S3 | Whether `traceId` gets a copyable affordance on error states for support hand-off |
| M7-S4 | UI half of `TC-SEND-018` — a campaign observed through a worker restart shows coherent, non-regressing progress |

**The previous session recommended, and the human approved, option (a): `M7-S5` is verification
only.** Rationale: none of `M7-S5`'s or `M7-GATE`'s success conditions require those surfaces,
and folding feature work into a verification node is the surest way to make it slip. Record the
deferral as a `DEC-*` rather than silently dropping it.

Consequence worth knowing: `UI-CFG-002` is already `status: migrated` with all five states
captured at three viewports from M5-S1. **Adding a quota surface would invalidate those captures**
— which is precisely why M7-S1 refused to touch it.

---

## Known risk on `BR-SEC-006` — flag it early, do not discover it late

`BR-SEC-006`'s acceptance is *"Load test với dữ liệu mục tiêu đạt ngưỡng, không vi phạm rate
limit/provider quota"*, and its cases are `TC-SEC-006` and `TC-SEC-011` ("Load campaign 100k":
100,000 recipients/campaign, throughput at configured rate, list API p95 < 500 ms, progress p95
< 5 s).

Measured on this host after the D-171 fix: the send path runs at roughly **36 ms/recipient**
(600 recipients in ~22 s). Extrapolated, 100,000 recipients is on the order of **an hour of
continuous running**. That is feasible but not casual, and it is the same family of problem as
`TC-SEC-016`, which had to stay unrun for lack of staging infrastructure (`DEC-143`).

There is a real possibility `BR-SEC-006` ends `partially_closed` with a written variance report
rather than `closed`. That is an acceptable outcome — `BR-SEC-004` set the precedent this batch
(`DEC-167`), and `BR-SEC-004`'s own acceptance text explicitly allows *"hoặc có biên bản chênh
lệch"*. What is **not** acceptable is a fabricated number. Decide the disposition consciously and
record it.

Note also that `M7-GATE`'s first success condition reads *"All 8 M7 rules closed"*. If
`BR-SEC-005` and `BR-SEC-006` both end `partially_closed`, that condition needs the same
correct-the-stale-text treatment `DEC-143`, `M4-GATE` and `M5-GATE` all used. Do not force-close a
row to satisfy it.

---

## Environment state you are inheriting — read before measuring anything

### The development database is polluted, and it matters

The previous session ran the 600-recipient `A7` case repeatedly while diagnosing D-171. Current
state:

```
tenant             3104
campaign_recipient 6462
message_attempt    4091
campaign_execution  121   (11 sending, 108 finished within 7 days)
quota_reservation   171
```

`reconcilable_campaign_executions()` performs a **bounded** cross-tenant scan. That bound is
exactly what `EXECPLAN` D-127 documents and what migration 031 fixed the ordering of. At 119
recent candidates the suite is close enough to the cap that `progress-reconcile.integration.test.ts`
A14–A17 and `progress-reconcile-scan-order.integration.test.ts` begin failing under load.

**Clean up accumulated test data before you take any performance measurement**, or you will
measure the pollution rather than the code. A verified backup/restore path now exists if you want
a safety net first: `python scripts/backup_db.py --env-file .env --out <path>`.

### Flake taxonomy on this host — do not re-diagnose these

| Test | Behaviour | Verdict |
|---|---|---|
| `apps/api test/integration/boot.test.ts` | times out at 30 s under concurrent CPU load; passes alone in ~9 s | `EXECPLAN` D-40, pre-existing |
| `apps/worker src/campaign-send/run.integration.test.ts` "safe no-op" | fails under full-suite contention; passes alone | D-166, **fails on clean `main` too** |
| `apps/worker src/progress-reconcile.integration.test.ts` A14–A17 | fails once the DB nears the scan cap | D-172, environmental |
| `apps/worker src/import-processor.integration.test.ts` | same contention family | D-172 |
| `packages/architecture-tests src/migration-runner-behavior.test.ts` | fails when the Docker daemon is busy; it starts real containers | D-132 |
| `apps/api test/integration/{auth-http,webhooks-http}.test.ts` | failed once under load, green alone and on a second full run | D-172 |

One full worker run produced **10 failures**; the same four files run alone produced **12/12
pass**. The suite has a genuine parallel-isolation weakness. **Take deterministic counts with
`--no-file-parallelism`.**

### `D-142` — corrected, do not inherit the wrong version

All four Codex nodes recorded `send.integration.test.ts`'s 600-recipient assertion as a
pre-existing `main` defect. The M7-S1 merge commit initially said it "does not reproduce here" and
blamed the execution host's timing. **Both framings were incomplete.** It is data-volume and load
dependent: green on clean `main` early in the review, then deterministic 3/3 once the database had
grown, and cured by the D-171 fix. The corrected version is in `EXECPLAN` D-142 and D-171.

### How to run things on this host

- **Never pipe a test command through `tail`/`grep` and read `$?`** — you get the pipe's exit
  code, not the command's. This masked two real failures in the previous session. Redirect to a
  file, or capture `${PIPESTATUS[0]}`.
- **The Bash tool caps at 10 minutes.** The architecture suite takes ~7.5 min and the full api
  suite ~2.5 min; a busy daemon pushes the former over. Use `run_in_background: true` writing to a
  log file for anything long.
- **`MSYS_NO_PATHCONV=1`** is required for `git show <ref>:<path>` — otherwise Git Bash mangles
  the ref into a Windows path.
- `pnpm --filter @eow/api build` once before the api suite: `boot.test.ts` spawns the real
  compiled process.
- `pnpm infra:up` must be running. The full stack is currently up and healthy.

### Observability stack

`M7-S3` added Prometheus and Grafana behind an **opt-in** Compose profile (`DEC-158`); the default
one-command deployment is unchanged. Verified working during review — both scrape targets `up`,
real `eow_queue_lag_seconds` per queue. To bring it up:

```bash
EOW_GRAFANA_ADMIN_PASSWORD=<something> docker compose --env-file .env --profile observability up -d --wait
```

It was stopped and removed after verification; the default stack is what is running now. This may
be genuinely useful to you: the dashboard has a list-API latency panel, which is one of
`TC-SEC-011`'s own assertions.

---

## Suggested first steps

1. Read the mandatory set above. Do not skip `visual-acceptance.md` — it defines the viewports and
   the rule that every material difference needs a written explanation in `screen-catalog.yaml`.
2. Run `python scripts/ui_handoff.py status`. `AGENTS.md` §2.1: if it reports `pending`, this node
   is **blocked** and you must not infer or redesign the approved screens.
3. Clean the accumulated test data (above), then establish your own baseline with
   `pnpm check` — do not trust this document's numbers, verify them.
4. Record the scope decision (a) as a `DEC-*` before capturing anything, so the deferred UI is
   explicitly deferred rather than quietly missing.
5. Take the captures, then **look at every single one**.

---

## Working discipline (carried forward, unchanged)

- Commit at every checkpoint you write to `state.json`; the subject names the node, the body
  records test **and skip** counts. `git log` is the independent cross-check on `state.json`.
- Evidence precedes status. Never mark a rule `closed`, a screen `migrated` or a node `completed`
  before the evidence exists and has been re-run.
- Never leave a node `running` when you stop. Checkpoint it honestly.
- Write every file as UTF-8 explicitly (`ARCH-ENCODING` enforces it; this repo has been silently
  corrupted three times).
- Never weaken an architecture rule to make it pass. Use its documented exception mechanism with a
  written reason, or fix the code. This batch used that path three times (D-169) and it worked.
- Do not edit a published migration. Highest is now **066**; note 019 and 037 are intentional
  gaps, and 034/035/036 are the M7 batch.

## Follow-ups recorded but not blocking `M7-GATE`

- **D-172** — test-suite parallel isolation and data hygiene. The most valuable of these; it is
  currently costing every session real diagnosis time.
- **D-161** — `eow_send_retry_total` conflates transient provider failures with rate/quota
  deferrals, because `send.ts` folds `overBudget.length` into the same `retrying` outcome.
- **D-155** — `NotificationsService.markAllRead()` emits no read metric.
- **D-144** — `sending_policy.batch_size`/`max_attempts`/`tenant_rate_limit_per_minute` exist in
  the database since 026 but are unmapped in the API entity.
- **D-148** — `EnvSecretStore` is an in-process `Map`, per app instance, not shared with the worker
  and not durable across restart. Documented as a deliberate local-only seam.
- `TC-SEC-016` — needs staging infrastructure neither host has (`DEC-143`).
