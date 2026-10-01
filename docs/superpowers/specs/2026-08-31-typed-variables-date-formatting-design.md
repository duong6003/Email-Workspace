# Typed variables, date formatting and timezone — design

**Status:** implemented 2026-08-31. Formatting lives on the variable definition rather than
in the token syntax, and resolves at render time (ADR-036).

Where it landed:

| Scope item | Implementation |
| --- | --- |
| 1. `dataType` on `configured_variable` | `database/migrations/074_typed_variables_and_formatting.sql` (forward only; existing rows default to `text`) |
| 2. `format`/`timezone` on both definitions | same migration; DTO validation in `apps/api/src/custom-fields/dto/custom-field.dto.ts` |
| 3. Tenant default timezone | `sending_policy.default_timezone`, surfaced through `PUT /sending-policy` |
| 4. Render-time resolution | `apps/api/src/templates/variable-value-format.ts` + `variable-formatting.ts`, applied inside `renderTemplateVariables` |
| 5. Management screens and catalogue | `apps/web/src/components/VariableFormattingFields.tsx`; the catalogue carries a server-rendered `example` |
| 6. The asymmetry | `enumOptions` closed; `sensitive` deliberately not -- see below |

Acceptance is pinned by `apps/api/test/integration/variable-formatting.test.ts` (real send vs
preview, against PostgreSQL) and `apps/api/src/templates/variable-value-format.test.ts` (the
`+07:00` off-by-one day).

On item 6: `enumOptions` carries over because it constrains what an operator may type.
`sensitive` does not, and the asymmetry turns out not to be arbitrary. BR-CF-009 masks a
*recipient-level* value in `audit_log`; a configured variable has no recipient-level value —
its value is the definition itself, visible to everyone who can open the settings screen —
so the flag would have had nothing to mask.

---

## What happens today

A recipient custom field declared as `date` is stored by
`apps/api/src/custom-fields/custom-field-values.ts` as `new Date(value).toISOString()`.
`renderTemplateVariables` substitutes by pure string replacement — `toText()` returns a
string unchanged — so a template containing `{{ngay_het_han}}` reaches the recipient as:

```
Hạn dùng: 2026-08-31T00:00:00.000Z
```

Raw ISO, with the `T` separator and the `Z` suffix visible in a customer-facing email.

This is not only cosmetic. Input carrying an offset, e.g. `2026-09-01T00:00+07:00`, is
stored as `2026-08-31T17:00:00.000Z`. Rendered against UTC that reads as **the previous
day**. A wrong date in a bulk send is far more expensive to correct than an ugly one.

There is no timezone anywhere in the product. `tenant` holds only `id`, `name`,
`created_at`; `sending_policy` has no timezone column. The sole timezone is the `TZ`
environment variable on the api container (`EOW_TIMEZONE`, default `Etc/UTC`) — one
process-wide value shared by every tenant.

### The two variable systems have drifted apart

| | Recipient custom field | Configured variable |
| --- | --- | --- |
| Table | `custom_field_definition` | `configured_variable` |
| Columns | `fieldKey, label, dataType, required, defaultValue, enumOptions, sensitive` | `scope, templateId, variableKey, label, defaultValue, required, allowCampaignOverride` |
| Has a data type | yes — `text / number / boolean / date / enum` | **no** |

A configured variable is untyped free text. `{{ngay_khai_truong}}` declared tenant-wide
cannot be validated on entry and cannot be formatted later, because nothing records that it
is a date. Giving configured variables a `dataType` is a precondition for this work, not an
optional extra. `enumOptions` and `sensitive` are likewise custom-field-only, with no
evident reason for the asymmetry.

## Direction (agreed)

Formatting is a property of the **variable definition**, not of the token. `{{ngay_het_han}}`
stays as it is; its definition carries `dataType`, `format` and `timezone`.

The alternative — filters in the token, `{{ngay_het_han | date:dd/MM/yyyy}}` — was rejected.
The `{{...}}` grammar is parsed independently in six places: `parseTemplateVariableTokens`,
`VARIABLE_KEY_PATTERN`, `template-analysis.ts`, `template-content-lint.ts`, the editor's
`lint-positions.ts`, and the OpenAPI contract. Changing it means changing all six plus
revalidating every stored template, for a flexibility (the same date shown two ways in one
email) that has no known demand.

Accepted cost of the chosen direction: one variable renders one way per email.

## Format must be applied server-side

Apply it inside `renderTemplateVariables`, not in any client. Preview already routes through
`POST /template-versions/:id/preview`, so a server-side implementation makes preview and real
send agree automatically. A client-side implementation would recreate exactly the trap the
preview work had to research the server to avoid: a preview that resolves differently from
the send it is meant to predict.

## The decision, now settled

**Resolved 2026-08-31: Option 1.** Recorded as
`docs/adr/adr-036-variable-formatting-outside-the-version-snapshot.md`. Format and timezone
resolve at render time from the current definitions and stay out of `contentHash`. The two
options are kept below because the ADR's consequences only make sense against the
alternative that was rejected.

`TemplateVariableSchema` is persisted into each published version as `variableSchemaJson`,
versions are immutable, and `contentHash` is computed over subject + html + textBody +
variableSchema. So where format metadata lives determines whether a format change is
retroactive:

**Option 1 — resolve at render time from the current definitions.** Fixing "we write
dd/MM/yyyy, not MM/dd/yyyy" applies everywhere at once. Formatting is treated as presentation
configuration that sits outside the content snapshot, so it must **not** enter `contentHash`
— otherwise every format change invalidates the hash of content that did not change.
Consequence: the same published version renders differently before and after the change,
which is a real weakening of the reproducibility the version snapshot exists to provide.

**Option 2 — freeze format into the version schema at publish.** The snapshot stays fully
reproducible. Consequence: correcting a format means republishing every affected template,
and templates published before this feature keep rendering raw ISO forever.

Chosen: **Option 1**, on the grounds that a date format is presentation, not content, and an
operator who corrects a tenant-wide format will not expect to republish forty templates to
make it take effect. It trades away part of the snapshot guarantee, which is why ADR-036
states plainly what the snapshot does and no longer does guarantee.

## Scope

1. Add `dataType` to `configured_variable` (forward migration; existing rows default to
   `text` so nothing changes for them).
2. Add `format` and `timezone` to both variable definitions, both nullable.
3. Add a tenant-level default timezone. `sending_policy` is the existing per-tenant settings
   row and is the natural home; adding a column there avoids a new table.
4. Resolve in `renderTemplateVariables`: variable's own format → variable's own timezone →
   tenant timezone → UTC.
5. Surface the fields in both management screens, and in the template editor's variable
   catalogue so an author can see how a date will render.
6. Consider closing the asymmetry: `enumOptions` and `sensitive` on configured variables too.

## Acceptance

- A `date` variable renders as a human-readable local date, never as an ISO string with a
  `T` and a `Z`.
- A value stored with a `+07:00` offset renders on the intended calendar day for a tenant in
  that timezone — this is the off-by-one-day case that motivated the work; pin it with a test.
- Preview and real send produce identical output for the same variable, by construction
  rather than by duplicated client logic.
- Templates published before the change keep rendering (behaviour under Option 1: they pick
  up the new formatting; under Option 2: they keep the old output). State which in the ADR.
