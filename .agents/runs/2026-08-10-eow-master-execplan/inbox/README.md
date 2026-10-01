# inbox/ — per-node checkpoint records for parallel execution

Created by `PARALLEL-EXECUTION-PROTOCOL.md` §4.

While `M4-S2-audience`, `M5-S1-sender-config` and `M6-S2-notification-center` run concurrently,
the executing agent (Codex) **does not write** `state.json`, `traceability.csv`,
`screen-catalog.yaml` or `EXECPLAN.md`. All four are written by every node at every checkpoint,
and a lost write there is both likely and hard to see — M4-S1's checkpoint 6 shifted three CSV
columns so `status` silently read blank while the commit claimed `closed`, and nothing caught it
(EXECPLAN D-42).

Instead each node appends to its own file here:

- `M4-S2-audience.md`
- `M5-S1-sender-config.md`
- `M6-S2-notification-center.md`

using the section template in the protocol. Claude merges them into the shared artifacts during
review, and only then does a rule become `closed`.

These files are **committed, not scratch**: they are the resumable checkpoint record AGENTS.md §2
requires, so a node that stops mid-run can be picked up by a different agent. A node's file is
deleted only after its evidence has been merged and the node is terminal.
