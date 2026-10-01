# Handoff — finish merging M5-S1 and M6-S2 into main, then resume M4-S4

Written 2026-08-15, end of a session that got most of the way through
`PARALLEL-EXECUTION-PROTOCOL.md §7` for `M5-S1-sender-config` and hit an unresolved
tool-environment anomaly (see "STOP — read this first"). Nothing has been committed yet.
The user asked to hand off to a fresh session rather than continue investigating live.

---

## STOP — read this first: unresolved tool-output anomaly

Running `validate_plan.py` through this session's Bash/PowerShell tools returned the fake
literal line `clean — nothing to commit` on every attempt — different filenames, different
copies, the WindowsApps `python` shim, and the real full-path Python 3.13 interpreter
(`C:\Users\PC\AppData\Local\Programs\Python\Python313\python.exe`) all produced the same
fake string, which does not appear anywhere in the script's actual source. Unrelated
commands (`echo`, `ls`, `git status`, `python -c "print(...)"`) all returned correct real
output in the same session.

The user then ran the identical command directly in their own terminal (outside Claude
Code) and got genuine output:

```
SCHEMA: PASS
GRAPH: 45 nodes ...
TRACEABILITY: ba-rules.json: 118 ... all 134 rules allocated ...
UI: 13 screens ... screen-catalog.yaml parses: 14 screen entries, 39 overlay entries ...
EXECPLAN: 23/23 required sections present
============================================================
ERRORS: 0   WARNINGS: 0
```

Then, in the same turn, re-running the exact same command through this session's Bash
tool again reproduced the fake line, side-by-side with the user's genuine result. This
rules out: a broken script (content read directly and is genuinely the real validator),
a broken interpreter (bypassed both the WindowsApps shim and used a confirmed real
CPython 3.13 install directly), and a machine-wide block (the user's own terminal is
unaffected). It is scoped specifically to this session's Bash/PowerShell tool execution
path. No `hooks` key was found in `C:/Users/PC/.claude/settings.json`,
`C:/Users/PC/.claude/settings.local.json`, or this project's `.claude/settings.local.json`.

**Before trusting any tool-executed command in a new session that claims to run
`validate_plan.py` (or anything similarly load-bearing), either:**
1. Ask the user to run it directly in their own terminal and compare, the way this
   session did, or
2. Treat a suspiciously terse/canned-looking result from *any* tool call with the same
   skepticism, not just this one script — the underlying cause was never identified.

The genuine, trustworthy `validate_plan.py` result as of this handoff (from the user's
direct terminal run) is: **ERRORS: 0, WARNINGS: 0**, all 134 rules allocated, 159/159 test
cases, 14 screen entries / 39 overlay entries, one expected production-only screen
`UI-CF-001`, 23/23 EXECPLAN sections present. The staged EXECPLAN.md/state.json edits in
this handoff are consistent with that result.

## Where to work

**Primary checkout:** `C:\Works\Projects\Email operations workspace\email-operations-workspace`,
branch `main`, HEAD `1bba5ed` (pre-merge). Do the work there, not in
`.claude\worktrees\next-step-2ae237` (this session's own worktree, on branch
`claude/next-step-2ae237` — unrelated to this merge, do not touch it or its branch).

## Current git state — nothing committed, do not lose this

`git merge --no-commit --no-ff origin/m5-s1-sender-config` (tip `d36bf85`) is in progress
against `main` at `1bba5ed`. All conflicts are resolved and staged — `git diff --name-only
--diff-filter=U` returns empty, 61 files staged (`git diff --cached --name-only`), including
`EXECPLAN.md`, `state.json`, `traceability.csv`, `screen-catalog.yaml`, `apps/web/e2e/
visual-capture.spec.ts`, and all 33 M5-S1 visual-evidence PNGs. **Do not run
`git merge --abort` or any destructive git command** — this represents a full session's
conflict-resolution and verification work. If anything looks wrong, stash or branch it off
before touching it further.

## What's already independently re-verified on this machine (§7.4), all genuinely green

- Migrations: `database/migrate.sh` re-run inside the real running Postgres container
  (`docker cp` + `docker compose exec`, `MSYS2_ARG_CONV_EXCL="*"` needed to stop Git Bash
  mangling the `/database/migrate.sh` path) — all 19 migrations (001-018, 020_sender_config)
  reported already-applied by checksum, zero errors.
- `pnpm typecheck` and `pnpm build` clean across all workspaces.
- Full test suite run twice: **85 files / 393 tests / 0 failed / 0 skipped**, both runs
  identical (no flake), a legitimate +2 files/+4 tests over the pre-merge `main` baseline
  (83/389 at `1bba5ed`).
- `docker compose --env-file .env config --quiet` exits 0.
- `apps/api/src/app.module.ts` confirmed wiring `SenderConfigModule` (lines 21/41).
- `apps/api/src/common/permissions.ts` confirmed needing no changes — all 8 routes in
  `sender-config.controller.ts` reuse the existing `PERMISSIONS.SETTINGS_MANAGE` constant.
- `validate_plan.py`'s real result (via the user's direct terminal run, see above):
  ERRORS: 0, WARNINGS: 0.
- **All 33 M5-S1 visual-evidence images individually inspected**, not just the green
  Playwright run trusted at face value (`.agents/runs/2026-08-10-eow-master-execplan/
  evidence/visual/M5-S1-sender-config/production/`: 13 sender-configs states/breakpoints,
  3 create-overlay, 15 sending-policy). Finding: a real, reproducible tablet-width
  (768×1024) defect on `SenderSettingsScreen.tsx` — recurrence of the D-71/D-72 CSS-cascade
  defect class (`globals.css`'s `@media(max-width:1000px)` outer-frame fixed-height rule,
  ~line 175). Recorded as **D-78/DEC-078** in `EXECPLAN.md` (already staged): disclosed to
  Codex as a known, non-blocking, cosmetic tablet-only gap, not fixed by Claude, per the
  DEC-071/073 verify-vs-fix authorship boundary. Does not block this merge. The
  `sending-policy` screen's own 15 images show zero instances of either symptom (different,
  single-column layout, not `.config-master-detail`) — confirms the defect is scoped to
  `SenderSettingsScreen.tsx` specifically.

## Still not done before committing this merge

1. **Re-run `openapi-compat-check` and `redocly bundle` explicitly** against the pre-merge
   `main` version of `contracts/openapi.yaml`, and re-run `ARCH-MIGRATION`, as standalone
   confirmations — `packages/contracts/src/openapi.d.ts` was only regenerated as a
   typecheck/build side effect so far, not explicitly re-validated.
2. Commit the merge (`git commit`, no `--amend`, normal merge commit message referencing
   `M5-S1-sender-config` and the D-78/DEC-078 finding).
3. Push to `origin/main` (`git@gitam2.altamedia.vn:duong.vuvan/email-operation-workspace.git`)
   — per standing authorization this still needs its own per-instance scope confirmation
   before the push itself, not blanket pre-authorization.

## Then: merge M6-S2-notification-center the same way

`origin/m6-s2-notification-center`, tip `d82ec9e` ("M6-S2 notification center: remove inbox
checkpoint, node terminal"), not yet started. Follow the same §7 sequence: merge with
`--no-commit --no-ff`, resolve conflicts per §7.3's shared-artifact table (same categories:
`database/migrations/`, `migrations.lock.json`, `contracts/openapi.yaml`,
`packages/contracts/src/openapi.d.ts` — regenerate via `pnpm contracts:generate`, never
hand-resolve — `contract-shape.check.ts`/`app.module.ts`/`permissions.ts` append-only), then
the full §7.4 re-verification list above, including individually inspecting every one of
its visual-evidence images before trusting the merge.

## Then: clean up stale branches

Confirmed present as of this handoff (`git branch` / `git branch -r` after
`git fetch --all --prune`):
- **Local:** `claude/m6-s2-notification-review`, `claude/m6-s2-notification-review-ea6300`
  (abandoned worktree/branch), `m6-s2-notification-followup` (duplicate tip of the same
  M6-S2 work already on `origin/m6-s2-notification-center`).
- Do **not** touch `claude/next-step-2ae237` — that is this session's own active worktree
  branch, unrelated to the M5-S1/M6-S2 work.
- Verify each stale branch's tip is genuinely superseded/merged before deleting (`git log
  --oneline <branch> -5`, compare against what actually landed on `main`) — don't delete on
  the assumption alone.

## Then: resume M4-S4-snapshot

Already flipped to `ready` in `state.json` (its only dependency, `M4-S3-variable-policy`,
is terminal-complete), committed at `1bba5ed`. Not yet started. Draft
`M4-S4-SNAPSHOT-PLAN.md` (same shape as `M4-S1-CAMPAIGN-DRAFT-PLAN.md`) and begin checkpoint
1 (TDD RED-first) for the send/schedule-confirmation snapshot — `BR-CMP-007`, `BR-CMP-010`,
`BR-TPL-001`, `BR-TPL-012` (the latter two reallocated into this node per DEC-046). `M4-GATE`
depends on `M4-S1` through `M4-S4` all completing; `M4-S1` and `M4-S3` are already terminal,
`M4-S2-audience` status should be checked fresh in `state.json` before assuming its state.

## Working discipline (unchanged from `AGENTS.md`/this run's established practice)

- Evidence before status; never flip `closed`/`completed` before the artifact that
  justifies it exists and has been re-run.
- Never trust a passing test suite or capture run alone — individually inspect every
  visual-evidence image, the way this session's D-78 finding required.
- TDD RED-first for any new code.
- Claude verifies and reports; it does not fix Codex's product code (D-71/DEC-071/073) —
  the D-78 tablet CSS defect is Codex's to fix in a later checkpoint, not this session's.
- Given the unresolved tool-anomaly above, hold a slightly higher bar than usual before
  trusting any single tool-reported "clean"/"passed" result that isn't cross-checked
  against a second source (a re-run, a direct read of the artifact, or — as with
  `validate_plan.py` here — the user's own terminal).
