# Parallel execution protocol — M4-S2, M5-S1, M6-S2

Written 2026-08-13, after `M4-S1-campaign-draft` closed. Governs the three nodes the human
has asked to run concurrently, executed by Codex, reviewed by Claude.

This document exists because AGENTS.md §2 says it plainly:

> Git gives recovery and visibility; it does not give mutual exclusion. When two agents may be
> active, still do not write the same contract, migration or shared config file concurrently —
> both agents share one working tree, so the second write silently wins and the loss is only
> recoverable if the first was already committed.

M4-S1 already produced two real incidents of exactly this class in one session: a working tree
changing underneath a reviewing agent mid-analysis, and a full-suite test run competing for CPU
with an active implementing agent. Three concurrent nodes multiply that risk, so the contention
is designed for here rather than discovered later.

---

## 1. Division of labour (set by the human)

| Who | Owns |
|-----|------|
| **Codex** | All code, migrations, contracts, unit/integration/e2e test *authoring*, and the non-visual parts of verification for its assigned node. |
| **Claude** | All image work — capturing, **looking at**, and judging visual evidence — plus post-run review of each node, and every merge into the four shared run artifacts (§4). |

**Codex does not do image work at all.** This is not a preference; Codex cannot inspect images,
and M4-S1 proved that a passing screenshot test is not evidence the right thing rendered — all
three "drafts success" captures showed a loading spinner under a green test (EXECPLAN D-42).
Any node whose Definition of Done includes visual states therefore **cannot be closed by Codex**.

### The handoff point, stated once and referenced by all three plans

Every plan's checkpoint sequence ends with an explicit **VISUAL HANDOFF** checkpoint. At it,
Codex must:

1. Write the visual-capture spec block (the code), following the M4-S1 block's shape.
2. **Not** run it as evidence, **not** judge its output, and **not** mark any visual state
   covered in `screen-catalog.yaml`.
3. Leave the node `running` in its inbox file (§4), with `nextAction` naming the visual handoff.
4. Stop and report.

Claude then runs the captures, inspects every image individually, fixes any capture that is
racing or mislabelled, fills `states_covered`/`production_render_path`, and closes the node.

---

## 2. Choose the isolation model before starting — this is a real decision, not a formality

Four options. Pick one deliberately; do not drift into (C) by accident.

**(D) Separate machine — SELECTED 2026-08-13.** The human has cloned the repository to a second
machine. This is the strongest option available and strictly better than (B) or (C): two physical
machines cannot share a working tree, so last-writer-wins is structurally impossible, and the CPU
contention that makes `boot.test.ts` flake (D-40) disappears. It does not remove risk, it **moves
it to integration time** — see §7, which exists only because of this choice.

Two conditions make (D) safe, and neither is optional:

1. **One node per clone on the remote machine too.** Running three Codex sessions in one clone on
   machine B recreates exactly the hazard machine B was chosen to avoid. Either three clones (or
   three git worktrees) there, or run them sequentially there.
2. **Work returns as git branches, never as copied files.** One branch per node, with its
   per-checkpoint commits intact. A folder of changed files destroys the history that makes
   review possible and makes the merge order in §7 unenforceable.

**(A) Queued, not concurrent.** Codex runs the three nodes back to back in
one working tree, one at a time, committing between them. Contention drops to zero, the
reservations in §3 still prevent renumbering churn, and total wall-clock time is barely worse
because a single Codex session works on one node at a time regardless. The right default when
only one machine is available.

**(B) Genuinely concurrent via git worktrees.** Each node gets its own worktree and branch under
`.claude/worktrees/`, and Claude merges. This is what worktrees are for and it makes concurrency
actually safe. Cost, measured during M4-S1: a fresh worktree has no `node_modules`
(`pnpm install --frozen-lockfile`, a few minutes) and no `.env` (gitignored; the human must place
it, or approve copying it — they declined once already). All three worktrees share one PostgreSQL,
so §5 still applies.

**(C) Concurrent on one working tree.** Only viable with the §3 reservations *and* the §4 inbox
pattern followed exactly. Even then, two agents editing `contracts/openapi.yaml` minutes apart
lose one edit silently — git cannot merge what was never two versions. If this is chosen, the
OpenAPI window in §3.3 is mandatory, not advisory.

---

## 3. Reservations — allocated up front so nothing has to be renumbered later

### 3.1 Migration numbers

Highest migration on `main` is `018_campaign_status_values.sql`.

| Node | Reserved | Expected use |
|------|----------|--------------|
| `M4-S2-audience` | **019** | Possibly none — audience resolution is a query over existing tables. Leave 019 unused rather than reassigning it. |
| `M5-S1-sender-config` | **020** | `sender_config` (+ `secret_ref`, verification state), likely also a policy table. |
| `M6-S2-notification-center` | **021** | Extends `notification`/`user_notification` (both exist since `001_initial.sql`) — dedup key, action state, message key + params, preferences. |

A node needing a second migration takes `NNN+30` (049, 050, 051) rather than the next free
number, so a late migration in one node can never collide with an early one in another. Gaps in
the sequence are harmless: `database/migrate.sh` iterates `database/migrations/*.sql` in order.

`database/migrations.lock.json` is append-only per node and is the one shared file where a
last-writer-wins loss is *detectable*: `ARCH-MIGRATION` fails if a committed migration's checksum
is missing or wrong. If it fails after a parallel run, re-add the missing entry rather than
regenerating the file.

### 3.2 Decision and discovery numbers

Last used: `DEC-054`, `D-44`.

| Node | `DEC-*` | `D-*` |
|------|---------|-------|
| (this protocol) | DEC-055 | D-45 |
| `M4-S2-audience` | DEC-056 … DEC-060 | D-46 … D-50 |
| `M5-S1-sender-config` | DEC-061 … DEC-065 | D-51 … D-55 |
| `M6-S2-notification-center` | DEC-066 … DEC-070 | D-56 … D-60 |

Exceeding a block is fine; take the next free number *above all three blocks* (071+, 061+) and
say so, rather than reusing a neighbour's reserved number.

### 3.3 `contracts/openapi.yaml`

Every one of the three nodes adds paths and schemas to this single file, so it is the sharpest
contention point after the run artifacts.

- Each node edits it **once**, as late as possible (its contract checkpoint), and **commits
  immediately** — not batched with other work.
- Before editing, save a pre-edit copy outside the repo; after editing, prove additive-only:
  `node scripts/openapi-compat-check.mjs <before> contracts/openapi.yaml`.
- Under model (C), that edit must happen inside an agreed window when no other agent is running.
- Path prefixes are naturally disjoint and must stay so: M4-S2 owns `/campaigns/{campaignId}/audience*`,
  M5-S1 owns `/sender-configs*` and `/sending-policy*`, M6-S2 owns `/notifications*`.
- `packages/contracts/src/openapi.d.ts` is generated and gitignored — regenerate after every
  merge; never hand-edit. `contract-shape.check.ts` is shared: append, never restructure.

### 3.4 Other shared source files

| File | Who touches it | Rule |
|------|----------------|------|
| `apps/api/src/app.module.ts` | M5-S1 (new module), M6-S2 (rewires notifications) | Append the import + module entry only; never reorder existing entries. |
| `apps/api/src/common/permissions.ts` | M5-S1, M6-S2 | Append constants only. New permission keys also need a migration row — take it in your own reserved migration, not a shared one. |
| `apps/web/src/app/{AppRoutes,nav}.tsx/ts` | M5-S1 only | M4-S2 and M6-S2 must not add routes; their surfaces are an overlay and a popover inside existing routes. |
| `apps/web/src/app/AppShell.tsx` | M6-S2 only (notification bell) | M4-S1 already added `Outlet` save-state context here; extend, don't replace. |
| `apps/web/e2e/visual-capture.spec.ts` | **Claude only** | Codex writes its block as a *patch proposal* inside its inbox file; Claude applies it. This file has been edited by three different milestones already and is where a lost write is least visible. |

---

## 4. The four shared run artifacts — inbox pattern, not direct writes

`state.json`, `traceability.csv`, `screen-catalog.yaml` and `EXECPLAN.md` are written by *every*
node at *every* checkpoint. They are also the four files whose corruption is hardest to see:
M4-S1's checkpoint 6 shifted three CSV columns so `status` silently read blank while the commit
claimed `closed`, and nothing caught it because nothing parsed the file (EXECPLAN D-42).

**Codex must not write these four files directly.** Instead, each node appends to its own file:

```
.agents/runs/2026-08-10-eow-master-execplan/inbox/<node-id>.md
```

One section per checkpoint, containing exactly what would have gone into the shared artifacts:

```markdown
## Checkpoint N — <name>
**Status after this checkpoint:** running | blocked | ready-for-visual-handoff
**nextAction:** <one line>

### Evidence (verbatim, for state.json)
- <one bullet per claim, each independently re-runnable by someone else>

### traceability.csv rows to update
| rule_id | slice | openapi_operation_ids | migration_files | code_paths | test_case_ids | test_files | log_or_metric_or_audit | status |
|---|---|---|---|---|---|---|---|---|

### screen-catalog.yaml changes
<screen/overlay id, fields to set — never `states_covered` for a visual state; that is Claude's>

### EXECPLAN entries
- D-NN: <discovery>
- DEC-NNN: <decision | rationale | alternative rejected>
```

Claude merges these into the real artifacts during review, and only then does a rule become
`closed`. This preserves the AGENTS.md requirement that a stopped node is resumable — the inbox
file *is* the committed checkpoint record — while removing three-way write contention on the
files where a silent loss is most expensive.

`inbox/` is committed, not scratch. It is deleted only after its node's evidence has been merged
and the node is terminal.

---

## 5. One database, three nodes

All models (A/B/C) share the single local PostgreSQL on `127.0.0.1:55432` and the running compose
stack. Consequences that are not optional:

- Every added column needs a `DEFAULT`; the running `api`/`worker`/`scheduler` containers execute
  older code against the same schema.
- Integration tests must create and clean their own tenants (the existing suites already do; copy
  their `beforeAll`/`afterAll` shape).
- **Do not run the full workspace suite while another agent is working.** M4-S1 proved this
  concretely: `boot.test.ts` spawns a real compiled process and times out under CPU contention
  (EXECPLAN D-40), so a concurrent full run produces false reds for whoever is unlucky. Targeted
  suites during development; full suite only in a quiet window.

---

## 6. What "done" means for a node under this protocol

A node reaches `completed` only when **Claude** has:

1. Merged its inbox evidence into the four shared artifacts.
2. Re-run the verification independently — not trusted the inbox's claims. M4-S1's two most
   serious defects were both found this way, in work that self-reported as passing.
3. Run and **individually inspected** every visual capture the node's screens require.
4. Confirmed `validate_plan.py` is clean, including the new `traceability.csv` structural checks.
5. Confirmed the full workspace suite twice, comparing test **and skip** counts.

Until then the node stays `running` with an honest `nextAction`. Codex reporting "done" is an
input to that judgement, not the judgement.

---

## 7. Bringing the work back (model D)

Under model (D) the dangerous moment is no longer concurrent writing — it is the merge. Three
branches developed in isolation, each against **its own PostgreSQL instance on a different
machine**, arriving at a `main` that has moved. What follows is the procedure, not a suggestion.

### 7.1 What must come back

One branch per node, named for the node, with its per-checkpoint commits and its
`inbox/<node-id>.md` committed. Delivered as a pushed branch, a `git bundle`, or a set of
`git format-patch` files — anything that preserves history. **Not** a zip of the working tree.

### 7.2 Merge order

Merge **one node at a time**, fully verifying each before starting the next. Never merge two and
verify once: if the suite goes red, the whole point is to know which branch did it.

1. `M4-S2-audience` first — it is on the critical path (`M4-S3` → `M4-S4` → `M4-GATE` all wait on
   it) and it touches campaign code this machine already knows.
2. Then `M5-S1-sender-config` and `M6-S2-notification-center` in either order; they are
   independent of each other and of M4.

### 7.3 Expected conflicts, and how each resolves

The reservations in §3 were written for a shared tree, but they are what makes these merges
tractable. Expect exactly these:

| File | Conflict | Resolution |
|------|----------|-----------|
| `database/migrations/` | None, if the reserved numbers were honoured — 019/020/021 are distinct filenames | If two branches both created the same number, the second to merge **renames its file** to its reserved number and its migration is re-applied; never edit the already-merged one. |
| `database/migrations.lock.json` | Near-certain — three branches each add one key to one JSON object | **Keep every line from every side.** Then re-run `ARCH-MIGRATION`; it recomputes and will say plainly if a checksum is wrong. |
| `contracts/openapi.yaml` | Possible but low — the reserved prefixes land in naturally different regions (`/campaigns/*` near the existing campaigns block, `/sender-configs*` new at the end, `/notifications*` at the existing notifications block) | Keep all three additions. Then re-run `openapi-compat-check` against the pre-merge `main` version and `redocly bundle`; a merge that silently dropped one node's paths shows up as a missing operation, not as a conflict marker. |
| `packages/contracts/src/openapi.d.ts` | None — gitignored | Regenerate (`pnpm contracts:generate`) after every merge. Never hand-resolve. |
| `contract-shape.check.ts`, `app.module.ts`, `permissions.ts` | Append-only collisions | Keep all sides; these are lists. |
| `inbox/*.md` | **None by construction** — each node writes only its own file | This is why the inbox pattern matters more under (D), not less. |
| `state.json`, `traceability.csv`, `screen-catalog.yaml`, `EXECPLAN.md` | **None, if the protocol was followed** — Codex never touched them | Claude merges each node's inbox into them here, after that node's verification passes. |

### 7.4 What must be re-proven on this machine, not trusted from theirs

Their evidence was produced against a **different database and a different host**. Every one of
these claims is therefore unverified here until re-run locally, and this is the whole reason the
work comes back for review rather than being merged on their word:

- **Migrations apply forward and re-run idempotently** — against *this* PostgreSQL, which already
  has 001-018 applied and real M1-M4 data in it. A migration that is clean on an empty database
  can still fail on a populated one; that is the interesting case, and only this machine has it.
- **The full workspace suite**, twice, comparing test **and skip** counts against the current
  baseline (76 files / 342 tests / 0 skipped as of `e5e7c4c`).
- **`validate_plan.py`**, including the `traceability.csv` structural checks added after D-42.
- **Every visual capture**, run and individually inspected here — the visual handoff in §1 means
  their branch contains capture *code* that has never produced a judged image.
- **`docker compose --env-file .env config --quiet`** and the one-command deployment contract, if
  any node touched ports, env vars, migrations, startup or static assets.

A node's rules do not flip to `closed` until its re-verification passes **here**.
