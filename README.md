# Email Operations Workspace — Complete A–Z Delivery Kit

Version 3.3 · baseline date 2026-08-10

This package is the implementation entry point for Product, BA, Architecture,
Frontend, Backend, QA, DevOps and coding agents. It combines the reviewed v1/v2
specifications with machine-readable contracts and a runnable monorepo starter.

## Start here

1. Put the approved `email-operations-workspace-ui-handoff-v2` source into
   `design-reference/ui-handoff-v2/source/`, or run
   `python scripts/ui_handoff.py install <folder-or-zip>`.
2. Verify it with `python scripts/ui_handoff.py status`.
3. Humans read `docs/00-start-here.md`.
4. Coding agents read `AGENTS.md`, then `project.manifest.yaml`.
5. Copy `.env.deploy.example` to `.env` and fill required values using
   `docs/deployment/environment-variables.md`.
6. Deploy the complete stack with one command:
   `docker compose --env-file .env up -d --build --wait`.
7. Run `python scripts/smoke_deploy.py` and `python scripts/validate_bundle.py`.

Default deployment endpoints: web `http://localhost:8080`, API through
`http://localhost:8080/api/v1`. Add `--profile dev` to that command to also start the
Mailpit development catcher at `http://localhost:8025`; a production bring-up leaves it
off and sets `EOW_SMTP_HOST`/`EOW_SMTP_FROM`, which Compose requires.

For source development without application containers, use `corepack enable`,
`pnpm install --frozen-lockfile`, `pnpm infra:up`, then `pnpm dev`.

## What is authoritative

- Business behavior: `docs/reference/*.docx` and `catalog/ba-rules.json`.
- Test traceability: `docs/reference/*.xlsx` and `catalog/test-cases.json`.
- Architecture decisions: `docs/adr/`.
- HTTP/events: `contracts/openapi.yaml` and `contracts/asyncapi.yaml`.
- Data baseline: `database/migrations/001_initial.sql`.
- Autonomous agent policy: `AGENTS.md` and `.agents/`.
- Approved UI presentation and interactions: `design-reference/ui-handoff-v2/source/`.
- UI precedence and acceptance: `design-reference/ui-source-contract.yaml` and
  `design-reference/visual-acceptance.md`.
- Deployment contract: `compose.yaml`, `Dockerfile` and `docs/deployment/`.

## Autonomous delivery contract

After a human approves a task, the coding agent owns the complete delivery cycle inside
the approved scope: discover → plan → implement → test → repair → document → report.
Agent LOOP, GRAPH and SCHEDULE are defined only for agent automation. Product runtime
workflows such as campaign sending use separate backend documents and code.

## Important boundary

The source is a production-oriented starter and contract skeleton, not a claim that
all 118 rules and 159 tests are already implemented. Each vertical slice must close
rule → contract → code → test → observability before it is marked done.

The package intentionally ships without the previously delivered UI bytes. Its destination,
validation, agent routing and start prompt are already configured. Copy the handoff into the
prepared location before asking an agent to implement frontend screens.
