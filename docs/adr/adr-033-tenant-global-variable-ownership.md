# ADR-033: Tenant-global variable ownership

Status: Accepted

Supersedes: ADR-032 for the placement of tenant-global variable management only.
ADR-032 remains authoritative for template-owned authoring, catalogue separation and
token insertion. ADR-031 remains authoritative for resolution precedence, published
version immutability and campaign snapshot freezing.

## Context

ADR-032 moved variable management out of the recipient-data settings module and
described tenant-global variables as "read-only catalogue inputs for compatibility".
The implementation removed the only surface that could create, edit or delete them, so
a tenant with existing global variables could no longer maintain them, and a value that
genuinely belongs to the whole tenant — a company name, a support address — had to be
redefined inside every template that used it.

That was a side effect of the move, not a decision anyone recorded.

## Decision

Tenant-global variables keep a first-class management surface, separate from both
recipient-data settings and template authoring:

- `/settings/global-variables` lists, creates, edits and deletes them. It requires
  `settings:manage`, matching the existing API permissions on those routes.
- They remain read-only *inside* the template editor and the campaign composer, exactly
  as ADR-032 specifies. Authoring a template never edits tenant-wide state.
- The key-shadow rule is symmetric: a global key may not be created when a template
  already owns that local key, and a template may not adopt a key an existing global
  owns.
- Deleting a global remains blocked while a published template version froze it.

## Rationale

Separation of ownership was the goal of ADR-032, and it is preserved: three surfaces,
three owners — recipient schema, template content, tenant-wide values. Removing the
third surface altogether was not required by that separation and cost a real capability.

## Compatibility

No API, contract or storage change. The screen consumes the `global-variables` routes
that have existed since ADR-031. Existing rows and published snapshots are untouched.

## Recovery

Removing the nav entry and route restores the previous state without touching data.
