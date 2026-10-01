# Handoff — M5-S1/M6-S2 merge queue fully closed; start M4-S4-snapshot next

Written 2026-08-15, end of a session that closed out the entire merge queue left
by `M5-S1-M6-S2-MERGE-HANDOFF.md` (that file is committed on `main`, kept for
history — do not delete it, it documents a real anomaly, see below). This
session's own new work is now also fully committed and pushed. Nothing is
in-progress or uncommitted. The user asked to hand off to a fresh session to
plan M4-S4-snapshot properly rather than rush into it here.

## Where to work

Primary checkout: `C:\Works\Projects\Email operations workspace\email-operations-workspace`,
branch `main`, HEAD `54a6754`, even with `origin/main` (pushed). Do not work in
`.claude\worktrees\next-step-2ae237` — that is a different, unrelated session's own
worktree/branch (`claude/next-step-2ae237`); leave it alone.

## What this session completed (all committed + pushed, nothing pending)

1. **M5-S1-sender-config merge** — commit `f402052`, pushed. (Concluded a merge
   that a prior session had left staged; see that session's own handoff file,
   still on disk, for the D-78/DEC-078 tablet-CSS finding it recorded.)
2. **M6-S2-notification-center merge** — commit `54a6754`, pushed. This session did
   the full cycle itself:
   - Resolved 4 real conflicts (`apps/api/src/database/data-source.ts`,
     `database/migrations.lock.json`, `contracts/openapi.yaml`,
     `apps/web/e2e/visual-capture.spec.ts`) by keeping both sides
     (additive/append-only, per `PARALLEL-EXECUTION-PROTOCOL.md` §7.3's
     shared-artifact table).
   - Regenerated `packages/contracts/src/openapi.d.ts` via `pnpm contracts:generate`
     (never hand-resolved).
   - Applied migration `021_notification_center` to the real dev Postgres via
     `docker compose run --rm migrate` (the compose-defined `migrate` service —
     this is the clean way to apply migrations; see the tool-anomaly note below
     for why `docker exec`/`docker cp` against the running `postgres` container
     should be avoided).
   - Re-ran the full suite clean: 0 failed, test count went from ~393
     (pre-M6-S2 baseline) to 417 across all workspaces (api 338, worker 24,
     api-schematics 1, architecture-tests 20, runtime-orchestration 3, web 31).
   - Re-ran `openapi-compat-check`, `redocly bundle`, `ARCH-MIGRATION` standalone
     (not just as a typecheck/build side effect) — all clean.
   - **Individually inspected all 21 M6-S2 visual-evidence images** (7 states ×
     3 breakpoints, under `.agents/runs/2026-08-10-eow-master-execplan/evidence/
     visual/M6-S2-notification-center/production/`) — no CSS-cascade defect of
     the D-78 class found at any breakpoint; loading/empty/unread-badge/filter/
     mark-one/mark-all/deep-link states all render correctly.
   - `state.json`'s `M6-S2-notification-center` node was already `completed`
     inside the merged branch itself (13/16 BR-NOT-* rules from a prior review
     session + this merge's own gap-closing test) — no further edit needed.
3. **Stale-branch cleanup** — verified each branch's tip was a genuine ancestor
   of `main` (`git merge-base --is-ancestor`) before deleting, per instruction
   not to delete on assumption alone:
   - `claude/m6-s2-notification-review` — deleted (ancestor confirmed).
   - `claude/m6-s2-notification-review-ea6300` — its worktree
     (`.claude/worktrees/m6-s2-notification-review-ea6300`) was clean
     (`git status` empty) and its tip was an ancestor; deleted the branch.
     `git worktree remove` hit a Windows "Filename too long" error deleting the
     directory contents (git still unregistered the worktree correctly — see
     below), so a stray directory may still exist on disk at that path; it's
     inert (unregistered, not part of git state) and safe to leave or manually
     `rm -rf` later if it bothers anyone.
   - `m6-s2-notification-followup` — deleted (ancestor confirmed).
   - Did **not** touch `claude/next-step-2ae237` (a different session's worktree
     branch) or the `origin/m5-s1-sender-config` / `origin/m6-s2-notification-center`
     remote branches (not part of the documented stale-branch list; leave for
     the user to prune on their own schedule if desired).

Current local branches: only `main` and `claude/next-step-2ae237` (not mine to
touch). Current remotes: `origin/main`, `origin/m5-s1-sender-config`,
`origin/m6-s2-notification-center`.

## Tool-output anomaly — a second, independently-reproduced instance this session

The prior session's handoff documented an unexplained anomaly where
`validate_plan.py` returned fake/canned output through this session's Bash/
PowerShell tools. This session hit what looks like the **same class of problem**,
reproduced independently, in a different area:

- While trying to apply migration `021_notification_center` via `docker exec`/
  `docker cp` against the running `email-operations-workspace-postgres-1`
  container, repeated calls gave self-contradictory results for the identical
  path: `docker exec "$CID" ls -la /` showed `/database` present; the very next
  call, `docker exec "$CID" sh -c 'ls -la /database'`, reported
  "No such file or directory"; a third call, `docker exec "$CID" ls -la /database`
  (bare-arg form again), succeeded and showed the (empty) directory. This is not
  explainable by ordinary MSYS2/Git-Bash argv path-mangling, since the path was
  embedded inside a single quoted string in the failing call, not passed as a
  bare argument.
- Separately, a `pnpm -r --workspace-concurrency=1 test` run piped through
  `tee logfile | tail -80` returned clearly garbage, non-test-related output
  ("4 matches in 1F: [file] Start at 16 (4): 22: 26 ...") instead of the real
  test summary.
- Separately again, the `Read` tool reported a file (`test-run-2.log`,
  19908 bytes, verified present via `ls -la` moments earlier) as
  "File does not exist" when passed a Git-Bash-style `/tmp/...` path — this
  turned out to be a real, benign issue (Read wants a native Windows path;
  `cygpath -w` gave the correct one, which then read fine) rather than a
  repeat of the anomaly, so not every "impossible-looking" result is the same
  bug — some are just path-format mismatches. Use `cygpath -w <path>` to
  convert before handing a Bash-tool path to Read.
- Also separately, `python3 -c "..."` reported the same just-verified-present
  file as not found immediately after a successful `grep` on it in the same
  Bash call — unexplained, consistent with the anomaly rather than a path-format
  issue (no path-translation excuse applies here, same shell, same path string).

**Net effect and mitigation used**: none of these blocked progress, because in
each case a different tool or invocation shape produced trustworthy output
(the `docker compose run --rm migrate` service call worked correctly and its
output was internally consistent/plausible; reading the raw log file directly
with the correct Windows path gave a fully coherent, detailed test report that
matched expectations). **The working pattern that got through this session's
anomaly cleanly**:
1. Prefer purpose-built compose services (`docker compose run --rm migrate`)
   over ad hoc `docker exec`/`docker cp` against a long-running container.
2. Never trust a piped/`tail`-truncated command result if it looks garbled or
   nonsensical — re-run without the pipe, or read the raw output file directly.
3. When a Bash-tool path doesn't resolve where you expect, try `cygpath -w` to
   get the native path before concluding a file is missing.
4. If a "not found"/"failed" result contradicts a call you just made
   successfully with no plausible cause (not a path-format issue, not a stale
   cache), don't retry the same shape hoping it clears — switch tools/shapes,
   or ask the user to cross-check directly in their own terminal (same
   mitigation the prior session's handoff already established for
   `validate_plan.py`).

This remains **unexplained and unresolved** as a root cause. Treat it as
standing background risk for this project/session line, not something specific
to migrations or Docker — it has now shown up in Bash-tool docker invocations,
piped test output, and (once) a Python subprocess call, spanning multiple
tool paths.

## Next: M4-S4-snapshot (not started — this is the actual next task)

`state.json` status: `M4-S4-snapshot` is `ready` (its only dependency,
`M4-S3-variable-policy`, is `completed`). `M4-GATE` is `pending`, waiting on
this node (M4-S1/S2/S3 are already `completed`). Fresh status check just run,
confirmed via `state.json`:
```
M4-S1-campaign-draft     -> completed
M4-S2-audience           -> completed
M4-S3-variable-policy    -> completed
M4-S4-snapshot           -> ready       <- next
M4-GATE                  -> pending     <- gated on M4-S4
M5-S2-schedule           -> pending     <- not yet ready, do not start
M5-S3-send               -> pending
M5-S4-webhook-reconciliation -> pending
M6-S1-realtime-progress  -> pending
M6-S3-history-recovery   -> pending
```

### Scope (rules this node owns, per `traceability.csv` and DEC-046/076)

- **`BR-CMP-007`** (P0): recipient/list/tag/custom-field data changing *after*
  a campaign's audience snapshot must not silently change the campaign;
  refreshing requires an explicit cancel-then-new-snapshot transition.
  Evidence family already anticipated in `traceability-plan.yaml`:
  `audit_log.action = campaign.snapshot_frozen` with `campaign_id` + row count.
- **`BR-CMP-010`** (P0): idempotency key returns the same campaign/job; the
  UI CTA (the `sendConfirm` screen) must show loading and disabled states
  during the request, not allow a double-submit.
- **`BR-TPL-001`** (P0, reallocated from M3 per DEC-046): a campaign that has
  already snapshotted a published template version keeps using that exact
  snapshot even after the template is later edited/republished — snapshot
  immutability.
- **`BR-TPL-012`** (P0, reallocated from M3 per DEC-046): companion
  acceptance/test rows (`TC-TPL-001`, `TC-TPL-012`, `TC-TPL-015`) proving the
  same snapshot-immutability guarantee from the template side.
- Also referenced against this node in `implementation-inventory.yaml`:
  `BR-SEND-012` (appears bundled with the send screen's own rule set,
  `implementation-inventory.yaml:265/288`) — check whether that's actually
  in scope for M4-S4 or belongs to M5-S3-send before assuming; the traceability
  CSV is the authoritative source, cross-check there first.
- `screen-catalog.yaml`/`ui-inventory.yaml` name the `sendConfirm` screen
  (`milestone: M4`, rules `BR-CMP-008, BR-CMP-009, BR-CMP-010, BR-CMP-005,
  BR-GEN-005`, API `POST /campaigns/{id}/send`, note: "review-before-send;
  must block on missing required variables") as `not_inventoried` — this is
  the UI surface this node is expected to build/port.
- `DEC-076` already establishes that `M4-S4-snapshot` — not `M4-S3` — owns
  persisting the audience *snapshot* and its `skipped_reason` rows at send
  time (M4-S3 only persists the waiver decision on `CampaignSettings`).

### Before writing any code

1. Draft `M4-S4-SNAPSHOT-PLAN.md` in
   `.agents/runs/2026-08-10-eow-master-execplan/`, same shape as the existing
   `M4-S1-CAMPAIGN-DRAFT-PLAN.md`, `M4-S2-AUDIENCE-PLAN.md`,
   `M4-S3-VARIABLE-POLICY-PLAN.md` (all present in that directory — read at
   least one before drafting, to match the established plan-doc format/level
   of detail this run expects).
2. Re-confirm `BR-CMP-007`/`BR-CMP-010`/`BR-TPL-001`/`BR-TPL-012`'s exact
   acceptance text and test-case IDs (`TC-CMP-007`, `TC-CF-013`, `TC-CMP-010`,
   `TC-CMP-016`, `TC-TPL-001`, `TC-TPL-012`, `TC-TPL-015`) directly from
   `traceability.csv` / `traceability-plan.yaml` rather than from this
   handoff's summary — this file is a pointer, not the source of truth.
3. Check whether `BR-SEND-012` is genuinely this node's to close or M5-S3's
   before scoping it in.
4. TDD RED-first for checkpoint 1, per this run's established discipline
   (every prior M-series slice in this project followed the same pattern —
   see any completed node's `evidence` array in `state.json` for the checkpoint
   shape).

## Working discipline (unchanged, carried forward from prior handoff)

- Evidence before status — never flip `closed`/`completed`/`ready→completed`
  before the artifact justifying it exists and has been re-run.
- Never trust a single tool-reported "clean"/"passed" result blindly, given
  the now-twice-reproduced tool-output anomaly above — prefer purpose-built
  commands (compose services over raw docker exec/cp), avoid piping through
  `tail`/similar without a raw-file cross-check, and re-run once if a result
  looks off before acting on it.
- Individually inspect every visual-evidence image a node produces — do not
  trust a green Playwright run alone.
- TDD RED-first for any new code.
- Claude verifies and reports; it does not fix another agent's product code
  defects unless the task explicitly assigns the fix to this session (the
  D-78 tablet CSS defect from the M5-S1 merge is still open and still not this
  session's to fix, per DEC-071/073's verify-vs-fix authorship boundary — it
  remains recorded in `EXECPLAN.md`, unrelated to M4-S4, no action needed on
  it here).
- Push/merge-commit actions require separate, explicit per-instance user
  confirmation — do not treat one approval as blanket authorization for future
  pushes/commits.
