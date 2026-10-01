# Start here

The product manages recipients, lists, tags, custom data, templates, campaigns,
scheduling, asynchronous sending, progress, history and durable notifications.

## Before coding

Install the approved UI handoff at `design-reference/ui-handoff-v2/source/` and run
`python scripts/ui_handoff.py status`. The prepared destination and agent rules are present,
but the UI source itself must be copied by the user. Then use the approval prompt in
`docs/delivery/start-coding-with-agent.md` from the repository root.

## Delivery sequence

1. Foundation: tenant/auth/RBAC, audit, configuration, error model.
2. Recipient data: recipients, lists, tags, custom-field definitions, import and bulk update.
3. Template: versions, required-variable extraction, preview and validation matrix.
4. Campaign: draft, audience query, immutable snapshot, policy validation.
5. Execution: schedule/send, provider adapter, worker retries, webhook reconciliation.
6. Experience: realtime progress, notification center, history and recovery controls.
7. Hardening: quotas, observability, performance, backup/restore and security testing.

Do not start campaign sending before snapshot and missing-variable behavior are accepted.
Do not expose realtime before event authorization, resume/reconciliation and rate limits exist.

## Navigation

Use `docs/index.yaml`. The Word/Excel baselines remain review-friendly; JSON/CSV/YAML
copies are included for agents, code generation and automated traceability.
