# ADR-021: Autonomous agent execution after approval

Status: Accepted

## Decision

Treat explicit human approval as the start gate for autonomous delivery within the approved
scope. The coding agent owns discovery, plan, implementation, verification, bounded repair,
documentation and completion reporting. It does not request routine confirmations between
stages. STOP gates remain for authority, destructive/production actions, secrets/paid actions,
material business ambiguity, compliance ownership and exhausted repair budgets.

## Consequences

Agent work is resumable, auditable and evidence-based. “Approved” is not unlimited authority;
the approval policy records scope and exclusions explicitly.
