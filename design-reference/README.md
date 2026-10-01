# Approved UI handoff

This directory is the prepared drop-in location for the previously delivered
`email-operations-workspace-ui-handoff-v2`.

## Option A — copy manually

1. Extract the UI handoff package.
2. Copy the UI source contents into `design-reference/ui-handoff-v2/source/`.
3. Keep its original files and structure; do not merge it into `apps/web` manually.
4. Run `python scripts/ui_handoff.py register`.
5. Run `python scripts/ui_handoff.py status`.

## Option B — let the helper copy it

Run either:

```bash
python scripts/ui_handoff.py install /path/to/email-operations-workspace-ui-handoff-v2.zip
python scripts/ui_handoff.py install /path/to/email-operations-workspace-ui-handoff-v2
```

Use `--replace` only when intentionally replacing an earlier installed handoff. The helper
accepts a folder or ZIP, detects a nested `source/` when present, copies it safely and writes
an installation record.

## Ownership

- `design-reference/ui-handoff-v2/source/`: approved visual/interaction baseline.
- `apps/web/`: production frontend target.
- `catalog/ba-rules.json`: behavior source of truth.
- `contracts/openapi.yaml` and `contracts/asyncapi.yaml`: integration source of truth.

The coding agent inventories and migrates the approved UI incrementally. It replaces mocks
with real integrations and verifies visual equivalence; it must not redesign approved screens.
