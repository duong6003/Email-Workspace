# ADR-032: Template-owned variable authoring

Status: Accepted

Supersedes: ADR-031 for variable-management placement and authoring interaction only.
ADR-031 remains authoritative for resolution precedence, published-version immutability
and campaign snapshot freezing.

## Decision

Separate variable management by the object that owns the value:

- Recipient custom fields are managed only in the recipient-data settings surface. They
  describe per-recipient data and are never presented as template configuration.
- Template-owned variables are created, edited and removed inside that template's draft
  editor. Their default value, required behavior and per-campaign override permission are
  authored alongside subject, HTML and text content.
- System variables and existing tenant-global variables are read-only authoring catalogue
  entries. They are loaded when the template editor and campaign composer open, but they
  are not mixed into recipient-field management.

The template draft editor groups the catalogue as system/default values, recipient data
and template-owned variables. Inserting a catalogue entry writes its `{{variable_key}}`
token into the active subject, HTML or text field. Import may save a draft containing an
unknown token; publication remains blocked until the author creates a matching template
variable, selects an existing recipient/default variable, renames the token or removes it.

Template keys are unique within their owning template, not across the tenant. Two templates
may use the same local key with independent labels, defaults and override permissions. A
template-local key still cannot shadow a system variable, tenant-global variable or
recipient custom field, and a single template cannot define the same local key twice.

Campaign compose does not mutate immutable published template content. It shows the same
sources for comprehension and exposes value inputs only for published configured variables
whose schema explicitly permits a campaign override.

## Rationale

Putting global content values and recipient fields in one settings module makes ownership
unclear and encourages accidental coupling. Template-local authoring keeps content defaults
next to the content that consumes them, while recipient schema remains stable for imports,
segmentation and recipient maintenance. Allowing draft import before every token is resolved
also gives authors a repair path instead of rejecting the source before a template identity
exists.

## Compatibility

The global-variable API and stored rows remain supported because published template versions
and existing campaigns may reference them. They become read-only catalogue inputs in the UI;
this decision does not delete data or change resolution precedence. Published versions and
campaign snapshots continue to freeze the same schema and effective values defined by
ADR-031.

## Recovery

The UI can fall back to the previous action overlay without changing stored template,
configured-variable or snapshot data. Template drafts saved with unresolved tokens remain
unpublishable under the existing authoritative publish validation.
