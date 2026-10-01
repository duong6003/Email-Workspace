# ADR-036: Variable formatting resolves outside the version snapshot

Status: Accepted

Extends ADR-031/032/033 (configured variables and their ownership) and the immutable
template-version snapshot established at M3-S1. Supersedes nothing. It does narrow what the
snapshot guarantees, which is why it is recorded here rather than settled in a commit
message.

## Context

A recipient custom field of type `date` is stored as `new Date(value).toISOString()`
(`apps/api/src/custom-fields/custom-field-values.ts`) and substituted into templates by
string replacement — `toText()` in `template-variable-renderer.ts` returns a string
unchanged. A customer therefore reads `2026-08-31T00:00:00.000Z` in the body of an email.
A value carrying an offset, `2026-09-01T00:00+07:00`, is stored as `2026-08-31T17:00:00.000Z`
and renders on the previous calendar day.

No timezone exists per tenant. `tenant` holds only `id`, `name`, `created_at`;
`sending_policy` has no timezone column. The only timezone in the system is the api
container's process-wide `TZ`, shared by every tenant.

Formatting will therefore be declared on the variable definition — `dataType`, `format`,
`timezone` — rather than in the `{{...}}` token, because that grammar is parsed
independently in six places and changing it would require revalidating every stored
template (see
`docs/superpowers/specs/2026-08-31-typed-variables-date-formatting-design.md`).

That leaves one question this ADR exists to answer. `TemplateVariableSchema` is persisted
into every published version as `variableSchemaJson`, versions are immutable, and
`contentHash` is computed over subject + html + textBody + variableSchema. If format
metadata were frozen into that snapshot, correcting a format would mean republishing every
affected template, and every version published before this feature would render raw ISO
forever.

## Decision

**Format and timezone resolve at render time from the current variable definitions, not
from the version's frozen `variableSchemaJson`.**

Resolution order: the variable's own `format` and `timezone`, then the tenant's default
timezone, then UTC.

Formatting metadata does **not** enter `contentHash`. The hash continues to cover the
content — subject, html, textBody and the variable schema as it exists today. A tenant that
changes a date format has not changed any template's content, and must not invalidate the
hash of content that did not change.

Formatting is applied server-side inside `renderTemplateVariables`. Preview reaches the
renderer through `POST /template-versions/:id/preview`, so preview and real send agree by
construction. A client-side implementation would reintroduce the divergence the send-preview
work had to consult the server to avoid.

## Consequences

- **The version snapshot no longer fully determines rendered output.** This is the real cost
  and it is deliberate: the same published version renders differently before and after a
  format change. What the snapshot still guarantees is unchanged — the content that was
  approved, the variables it requires, and their defaults. What it no longer guarantees is
  byte-identical presentation of typed values across time.
- Templates published before this feature pick up the new formatting automatically, which is
  the behaviour an operator expects and the reason this option was chosen over freezing.
- A wrong tenant-wide format is corrected in one place and takes effect everywhere, rather
  than requiring a republish of every template that references the variable.
- Anything needing byte-exact reproduction of a past send must capture the rendered output at
  send time rather than re-deriving it from the version. Campaign snapshots already freeze
  the recipient envelope (ADR-029); if reproducing rendered bodies later becomes a
  requirement, that is where it belongs, not in the template version.
- `configured_variable` gains a `dataType`, defaulting existing rows to `text`. Without it
  half the variables in the system could never be formatted, since nothing recorded that
  they were dates.
