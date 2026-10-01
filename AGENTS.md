# AGENTS.md — Email Operations Workspace

This file is the mandatory entry point for every coding agent. Its purpose is to let
an agent finish an approved task end-to-end without asking the human to drive each step.

## 0. Meaning of approval

A human message that clearly approves a task, plan or implementation is the START gate.
From that point, perform discovery, planning, edits, migrations, local infrastructure,
tests, bounded repair, documentation and handoff autonomously inside the approved scope.
Do not ask for routine confirmation between stages. Approval does not authorize production
deployment, destructive data operations, secrets/credentials use outside configured tooling,
paid external actions or a material change of business meaning. Those are STOP gates defined
in `.agents/approval-policy.yaml`.

## 1. Read order

1. `project.manifest.yaml`
2. `docs/00-start-here.md`
3. `design-reference/ui-source-contract.yaml` for any frontend or full-product task
4. `.agents/orchestration-policy.yaml`
5. `.agents/approval-policy.yaml`
6. The selected LOOP, GRAPH or SCHEDULE policy in `.agents/`
7. The role file in `.agents/roles/`
8. Domain documents routed by `docs/index.yaml`
9. Relevant ADRs, OpenAPI/AsyncAPI contracts and rule/test IDs

Do not scan all documents blindly. Use `docs/index.yaml` to select the smallest
authoritative set for the task.

## 2. Mandatory autonomous task protocol

Create `.agents/runs/<run-id>/state.json` from the state schema. Record goal, approval
evidence, scope, affected modules, rule IDs, contracts, risks, test layers, graph/loop
budgets and current checkpoint. Keep this state current so another agent can resume.

Before editing, inspect the smallest authoritative document set, working-tree state and
relevant tests. If a requirement changes tenant isolation, authentication, campaign
snapshot semantics, delivery state, notification durability or public contracts,
create/propose an ADR before implementation.

Before creating or restructuring an API feature, follow
`docs/architecture/module-template.md`; its layering, tenant-transaction and test-placement
rules are mechanically enforced by `packages/architecture-tests`.

Implement one vertical slice at a time. Keep REST/PostgreSQL authoritative; realtime
events are hints that trigger targeted cache updates/refetch. Never make a UI socket
payload the only copy of business state.

After editing, run the narrowest relevant checks, then workspace checks. If verification
fails, enter the bounded repair loop automatically. Update rule/test traceability or state
why no traceability change is needed. Finish with a completion report containing evidence.

Compare the workspace check's *test count and skip count* against the previous node, not just
its exit code. A suite that stops running is not a passing suite: a failed `beforeAll` is
reported as skipped tests under a green-looking summary, which is how a whole milestone's
safety net can disappear silently.

Evidence precedes status. Never mark a rule `closed`, a screen `migrated` or a node
`completed` before the evidence that justifies it exists and has been re-run. Never leave a
node `running` when you stop working; checkpoint it with what is done and what is not, so a
different agent — which may be another model, working concurrently rather than after you —
can resume without re-deriving your state.

Commit to git at every checkpoint you write to `state.json`, not once at the end of a
session. The subject names the node; the body records the workspace check's test count and
skip count. This makes `git log` an independent cross-check on `state.json` rather than a
second copy of it: a node whose traceability says `closed` but whose commit shows no test
files added is visible immediately, which is exactly the class of drift that has already
occurred in this run. Never commit `.env`, credentials, `node_modules/`, `dist/` or
generated coverage output; `.gitignore` covers these, so an override is a signal to stop
and re-read what you are staging. Do not amend or discard another agent's commits.

Write every file as UTF-8 explicitly. On this Windows host the default codepage is
Windows-1252, so a tool that reads UTF-8 and writes it back through the default encoding
corrupts every non-ASCII character — Vietnamese business-rule text worst of all — while
leaving the file structurally valid, and therefore invisible to the workspace check, to
`validate_plan.py` and to a terminal whose console codepage renders the damage back as
something plausible. Pass `-Encoding utf8` to PowerShell's `Out-File`/`Set-Content` and
`encoding='utf-8'` to Python's `open`. `packages/architecture-tests` enforces this
(ARCH-ENCODING) after it happened three times unnoticed.

Git gives recovery and visibility; it does not give mutual exclusion. When two agents may
be active, still do not write the same contract, migration or shared config file
concurrently — both agents share one working tree, so the second write silently wins and
the loss is only recoverable if the first was already committed.

Any change to runtime dependencies, ports, environment variables, migrations, startup,
health/readiness or static assets must preserve the one-command deployment contract.
Update `compose.yaml`, `.env.deploy.example`, Docker targets and deployment docs together;
validate Compose interpolation and run the deployment smoke test when Docker is available.

## 2.1 Approved UI source of truth

The approved UI handoff is installed at `design-reference/ui-handoff-v2/source/`.
For a frontend or full-product run, execute `python scripts/ui_handoff.py status` during
intake. If it reports `pending`, the frontend node is blocked: do not infer or redesign the
approved screens from the starter in `apps/web`. Backend, database and contract nodes may
continue only when they are independently within the approved graph.

After the handoff is present, treat it as the authoritative visual and interaction baseline.
Inventory its routes, screens, components, states, assets, mock data and mock actions before
changing `apps/web`. Reuse code where compatible; migrate incrementally; replace mocks with
the accepted API, realtime, notification, scheduling and RBAC contracts. Business rules
control behavior; the UI handoff controls presentation. Record an irreducible conflict as a
STOP gate. A screen is complete only after visual equivalence and required loading, empty,
error, success, permission-denied, reconnecting and responsive states are verified.

## 3. Agent LOOP vs GRAPH vs SCHEDULE

These terms apply to coding-agent execution only. They do not describe campaign runtime,
queues, email scheduling or recipient processing.

- LOOP: the agent repeatedly observes, edits, verifies and diagnoses until Definition of
  Done passes or an explicit bound/STOP gate is reached. Use `.agents/agent-loop.yaml`.
- GRAPH: the agent decomposes delivery into dependency-aware nodes, runs independent nodes
  concurrently when supported, joins evidence and continues downstream. Use
  `.agents/agent-graph.yaml`.
- SCHEDULE: the agent defers or repeats agent work at a future time/condition, persists a
  resume payload and continues from the saved checkpoint. Use `.agents/agent-schedule.yaml`.
- DIRECT: only for a genuinely atomic task that still requires verification and reporting.

The default for an approved feature is GRAPH containing bounded LOOPs. SCHEDULE composes
with a graph only when continuation genuinely depends on future time/external state.

## 4. Domain invariants

- Every tenant-owned row carries `tenant_id`; authorization is enforced server-side.
- Confirming send/schedule freezes audience, template version, merge data, sender and
  policy result in a campaign snapshot.
- Missing required template variables block send unless an accepted business rule
  explicitly defines fallback/exclusion behavior.
- Provider callbacks are signature-verified and deduplicated.
- Jobs, outbox events, webhooks and realtime envelopes are idempotent.
- Notification center is durable; toast messages are transient presentation only.
- Progress counters never decrease and reconcile to campaign-recipient facts.
- Scheduled timestamps are stored in UTC with the original IANA timezone retained.

## 5. Change and stop gates

Never silently change an Accepted ADR. Add a superseding ADR. Never edit a published
migration; add a forward migration. Never add a dependency without license, security,
maintenance and bundle/runtime impact review. Do not mark work complete with skipped
tests, unresolved type errors, broken contracts or undocumented TODOs in critical paths.

`packages/architecture-tests` mechanically enforces the conventions this file states in
prose — tenant scoping, deny-by-default route permissions, published-migration immutability,
approved-handoff fidelity and test hygiene. Treat a failure there as a design violation, not
a broken test: fix the code, or, if the exception is genuinely correct, add it to that rule's
allowlist with a written reason. Never delete or weaken a rule to make it pass. Extend the
suite whenever a convention proves to have been violated silently — that is the cheapest
point at which the next agent learns it.

Stop only for: missing authority, destructive/production action, required secret or paid
service, irreducible business ambiguity, security/compliance risk requiring ownership, or
exhausted repair budget with evidence. Routine code choices, safe local commands, tests,
formatting, build fixes and documentation are not reasons to ask the human again.

## 6. Definition of done

A change is done only when acceptance criteria pass; relevant unit/integration/E2E tests
pass; OpenAPI/AsyncAPI/database contracts match code; logs/metrics/audit are present;
security and tenant checks pass; documentation and traceability are updated; rollback or
recovery is known; no P0/P1 defect remains; one-command packaging still validates; every
environment variable is documented; and the run state is terminal with evidence.
For frontend scope, Definition of Done additionally requires a registered UI handoff,
screen-level traceability and visual checks at the viewports defined by
`design-reference/visual-acceptance.md`.
