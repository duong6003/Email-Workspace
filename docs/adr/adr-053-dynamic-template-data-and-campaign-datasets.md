# ADR-053: Dynamic template data — list/table variables, block syntax and campaign datasets

Status: Proposed

Extends ADR-015 (template rendering), ADR-031/032/033 (configured variables) and ADR-036
(formatting outside the version snapshot). Respects ADR-013 (campaign snapshot) unchanged.
Design detail: `docs/superpowers/specs/2026-10-01-template-dynamic-data-design.md`.

## Context

The renderer only substitutes flat `{{key}}` tokens; anything else is rejected as
`UNSAFE_TEMPLATE_EXPRESSION`. Variable types are scalar only. The builder's Table and List
blocks are static. A non-scalar value would reach a customer as `JSON.stringify` output.
Per-send data can only enter through recipient custom fields (durable profile data, which
is the wrong lifecycle) or campaign overrides (one scalar shared by everyone).

Real sends need per-recipient multi-row data (payslips, order lines, statements),
shared tables (schedules, product lists), and the ability to feed the same published
template different data on every send. ADR-015 already names "Handlebars strict/
whitelisted merge" as the decision; the implementation never grew past flat tokens.

## Decision

1. **Data contract and binding are separate.** A template version declares variables
   with a type and a `valueScope` (`campaign` = one value per send, `recipient` = one
   value per recipient). A campaign draft binds each variable to a source (default,
   manual entry, campaign dataset). System variables and recipient custom fields keep
   their existing meaning and are never overridden by a campaign dataset.
2. **New variable types** on template-owned and global configured variables: `list`
   (array of scalars) and `table` (array of rows with declared typed columns). `number`
   gains format/currency/locale resolved like ADR-036. Recipient custom fields stay
   scalar.
3. **Grammar** is a strict Handlebars subset: `{{#each}}…{{else}}…{{/each}}`,
   `{{#if}}…{{else}}…{{/if}}`, `@index/@number/@first/@last/@odd`, helpers `join` and
   `count` only. No triple-stash, partials, arbitrary helpers, deep paths or `../`.
   Output is always HTML-escaped in `html`. `0` is truthy. Nesting depth ≤ 3. In `html`,
   a block must open and close inside one parent element (publish lint).
4. **One shared implementation** in `packages/template-grammar` (tokenizer, AST,
   validator, renderer; no dependencies) used by `apps/api` and `apps/web`. A new
   architecture rule `ARCH-TEMPLATE-GRAMMAR` forbids re-implementing `{{` token regexes
   elsewhere.
5. **Campaign datasets** are campaign-owned imports (CSV/XLSX/paste/manual/copy) in one
   of three shapes: one row per recipient, many rows per recipient (grouped into a
   `table` variable), or shared (no key). Matching uses normalized email or a unique
   custom field. They never write recipient profile data.
6. **Freeze resolves everything.** At send/schedule confirmation, dataset rows are merged
   into each recipient's `merge_data_json`, rendered into `email_snapshot`, and the
   dataset is marked `frozen` with a content hash recorded in the snapshot's policy
   result. The worker is unchanged and still never reads live data (BR-SEND-012).
7. **Missing data follows BR-CMP-005**: required per-recipient data blocks the send
   unless the existing waiver excludes those recipients; an empty table is valid when
   `minItems = 0` and renders the `{{else}}` branch.

## Consequences

- Published versions using only flat tokens render byte-identically; the new grammar is a
  superset. Older versions need no migration.
- `merge_data_json`/`email_snapshot` grow with table data. Row limits, a 1 MB render cap
  and a 102 KB Gmail-clipping warning bound this, and the freeze must be chunked and
  asynchronous first (ADR-054); the current single-INSERT freeze already fails above
  ~5,040 recipients.
- Dataset rows are PII with their own retention, purged by the existing history
  retention scan after the campaign is terminal.
- Six existing ad-hoc token parsers are replaced by the shared package.

## Recovery

All schema changes are additive forward migrations (`configured_variable` type set and
new columns; `campaign_dataset`, `campaign_dataset_row`). Disabling the feature leaves
existing snapshots valid because rendered content is frozen. A version that uses block
syntax cannot be rendered by a rolled-back renderer; rollback therefore requires keeping
the grammar package even if the UI is withdrawn.

## Alternatives

- **Store per-send data in recipient custom fields** — rejected: wrong lifecycle,
  overwrites profile data, breaks BR-CF-008 expectations and leaks one-off PII into
  segmentation.
- **Full Handlebars library** — rejected: arbitrary helpers and prototype access are the
  injection surface ADR-015 excludes; a small owned grammar is auditable and shared with
  the browser bundle.
- **Attribute directives (`<tr data-each=…>`)** — rejected as the only surface: it cannot
  express subject/text bodies and diverges from ADR-015; the builder still emits blocks at
  element boundaries, which gives the same robustness.
- **Resolve datasets in the worker** — rejected by ADR-013.
