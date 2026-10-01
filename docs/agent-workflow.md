# Autonomous agent execution guide

This document is about the coding agent that builds the product. Backend campaign execution
is documented separately in `docs/architecture/runtime-orchestration.md`.

## One approval, complete execution

Once the human approves a task, the agent creates a run, selects an execution shape and owns
every routine step through delivery. It reports progress but does not turn implementation
into a sequence of confirmation questions. A new approval is needed only for STOP gates.

For frontend scope, `ui_intake` runs before the frontend node. It verifies
`design-reference/ui-handoff-v2/source/`, captures an inventory and identifies mocks and
missing states. A pending UI handoff blocks visual implementation; it does not authorize the
agent to substitute the starter UI or invent a redesign.

## Agent graph

The standard graph is intake → discovery → plan → architecture/contracts → implementation
→ integration → QA/security → documentation → completion gate. Frontend, backend, database,
contracts and tests may fan out only when their inputs are stable. No node may declare another
node complete; the join node validates all evidence.

## Agent loop

Each implementation or QA node may run observe → hypothesize → act → verify → reflect.
The loop must produce new evidence per iteration and stay within scope. Default repair budget
is five iterations per node and three iterations per identical failure class; policy may lower
the budget for costly checks. On exhaustion, persist diagnostics and stop honestly.

## Agent schedule

Schedule agent work only when a future timestamp, recurrence or external condition prevents
useful progress now. Persist the run ID, graph node, next action, condition, deadline, timezone,
retry/backoff and cancellation rule. Typical uses are dependency/approval polling, a nightly
regression run or a follow-up after a deployment observation window. Never use sleep loops.

## Resume and handoff

`.agents/runs/<run-id>/state.json` is the durable checkpoint. A replacement agent validates
the approval scope, reads completed-node evidence, rechecks workspace state and resumes the
first non-terminal node. It does not restart completed work without contradicting evidence.

## Required evidence

Each run leaves rule IDs, changed contracts/files, commands and tests, evidence, remaining
risks, rollback/recovery notes and open decisions. The final status is `completed`, `blocked`,
`cancelled` or `failed`; “mostly done” is never encoded as completed.
