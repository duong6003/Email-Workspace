# Session Handoff: Feature Gap Remediation

## Resume

Start with:

```text
feature-gap-remediation.state.json
FEATURE-GAP-REMEDIATION-PLAN.md
```

The previous project audit is recorded at:

```text
.agents/runs/2026-08-20-project-audit/state.json
```

Baseline:

```text
branch: main
commit: a6c7c74 audit: checkpoint current project findings
worktree: clean before handoff artifacts
UI handoff: ready
```

## Highest-Priority Defects

1. Compose is routed but still behaves like an unfinished intermediate flow.
   The editor contains placeholder content and shell send actions are disabled.
2. The compose sender selector is explicitly disabled. Backend sender selection
   exists but is not wired to the UI.
3. Drafts exist but the list is tenant-wide, not semantically "my drafts".
4. Errors lack a required stable machine code, retryability, field context,
   next action and centralized frontend mapping.
5. Unknown template variables fail too late and without repair guidance.
6. Import flows have no downloadable CSV/XLSX/HTML samples.
7. Template cards open an action form before preview.
8. Sender settings expose create/test/disable but not edit, despite PATCH
   already existing.
9. Notification persistence exists, but the shell does not subscribe to
   notification events. The unread badge has no dedicated CSS contract.

## Existing Capabilities To Reuse

- Campaign draft autosave and version headers exist.
- `senderConfigId` exists in campaign DTOs and snapshots.
- Sender PATCH, test connection and disable APIs exist.
- Template variable parser returns `UNKNOWN_VARIABLE` and `variableKey`.
- Template preview API exists for published versions.
- Durable notifications, unread/read/action-state APIs and realtime user room
  exist.
- Recipient import has durable jobs, preview and error-file download.

Do not rebuild these capabilities. Complete their missing contract and UI
wiring.

## Prior Release Risks

- Root typecheck can fail on a clean checkout because contracts artifacts are
  needed before web typecheck.
- `scripts/validate_bundle.py` expects an absent placeholder although the UI
  handoff is installed.
- Worker test discovery depends on environment setup and previously skipped
  large portions of the suite.
- Architecture migration checks depend on Docker Compose v2.
- `pnpm audit` previously reported dependency vulnerabilities.
- M7-S5 and final completion gates remain incomplete.

Recheck these in the packaging node and preserve exact test/skip counts.

## First Commands

```bash
python scripts/ui_handoff.py status
git status --short --branch
git log --oneline -5
cat feature-gap-remediation.state.json
sed -n '1,260p' FEATURE-GAP-REMEDIATION-PLAN.md
```

Then read the routed documents required by `AGENTS.md` and begin
`architecture_contracts`. Do not start frontend implementation before verifying
UI handoff status and screen inventory.

## Boundary

This session created planning/state artifacts only. It did not change
production code, contracts, migrations or business-gap statuses. The next
session owns implementation, verification, traceability updates and checkpoint
commits.

## Environment Note

The mandated `.agents/runs/2026-08-20-feature-gap-remediation/` directory could
not be created because `.agents` is read-only in this environment. These root
artifacts are the equivalent durable handoff and should be copied/moved into
the mandated run directory when that path becomes writable.
