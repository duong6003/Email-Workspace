# Test strategy

The baseline contains 159 traceable cases. Automation layers:

- Unit: policies, state transitions, variable resolution, idempotency and progress math.
- Integration: PostgreSQL constraints, outbox, queues, Redis, provider/webhook adapters.
- Contract: OpenAPI and AsyncAPI schema compatibility plus generated-client checks.
- E2E: recipient → template → snapshot → schedule/send → progress → notification/history.
- Security: tenant isolation, RBAC, CSRF/session, webhook signatures, injection and rate limits.
- Recovery: retry, duplicate webhook/job, Redis reconnect, worker crash, misfire and reconciliation.
- UX/a11y: keyboard, focus, complete selected-state highlight, responsive and dark/light modes.

Release gate: all P0 automated tests pass, no open critical vulnerability, migrations tested
both forward and restore-path rehearsed, and progress counters reconcile to recipient facts.
