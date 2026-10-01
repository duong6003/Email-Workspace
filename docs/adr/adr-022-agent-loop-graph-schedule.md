# ADR-022: Agent loop, graph and schedule

Status: Accepted

## Decision

Agent LOOP is bounded observe/act/verify/repair; Agent GRAPH is a persisted dependency DAG for
end-to-end delivery; Agent SCHEDULE is a persisted future/conditional resume of a specific
graph node. The default approved feature uses a graph with bounded node loops. State follows
`.agents/schemas/run-state.schema.json` and survives handoff or interruption.

## Consequences

Cycles, invisible dependencies, sleep-based waits, unbounded repair and completion without
joined evidence are prohibited.
