# ADR-031: Configured global and template variables

Status: Accepted

## Decision

Keep recipient fields, configured global variables and template-owned variables as
three distinct sources. Recipient fields remain recipient data. Global variables are
tenant-owned values managed in system settings. Template variables are definitions
owned by one template draft and published into that template version's immutable
variable schema.

Configured keys may not shadow system or recipient-field keys. Template rendering
uses this precedence for configured keys: an allowed campaign override, then the
published template default, then the current tenant-global value. Recipient/system
data is merged separately and remains authoritative for its own keys.

Campaign drafts persist only explicit overrides. Confirmation resolves the current
global values, validates override permission, renders every recipient, and freezes the
effective configured values in the campaign snapshot together with the published
variable schema. Later edits to a global value, template draft or campaign draft do not
change an existing snapshot.

## Rationale

Recipient attributes and reusable constants have different ownership and lifecycle.
Separating them prevents a company-wide footer value from being copied to every
recipient while preserving BR-TPL-004 defaults and ADR-013 reproducibility. Resolving
global values at confirmation lets a published template reuse the latest approved
tenant setting without making worker rendering depend on live mutable state.

## Recovery

The new tables and JSON properties are additive. Older template versions without
configured-variable metadata continue to render exactly as before. Removing the new UI
does not invalidate existing snapshots because effective values are frozen in snapshot
metadata and rendered email content.

## Alternatives

Using custom-field defaults as global values was rejected because custom fields model
recipient data. Resolving global values in the worker was rejected because it violates
ADR-013. Requiring every configured value to be entered per send was rejected because it
creates avoidable repetitive work and makes template defaults ineffective.
