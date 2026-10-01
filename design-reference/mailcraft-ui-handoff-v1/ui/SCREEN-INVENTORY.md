# Screen inventory

## User-facing screens

| ID | Screen | Main actions | Important states |
|---|---|---|---|
| UI-01 | Mailcraft template management | Search, filter, create blank, import, open | Empty, loading, error |
| UI-02 | Create template | Blank page, choose existing template | No forced preset |
| UI-03 | Focus editor | Edit tree, save draft, preview, publish | Dirty, saving, conflict |
| UI-04 | HTML import | Upload, analyze, review, import | Unsupported, partial, failed |
| UI-05 | Import report | Native blocks, fallback, blocked content, missing assets | Needs mapping |
| UI-06 | Reusable Block Library | Search, insert, rename, delete | Empty library |
| UI-07 | Asset library | Upload, replace, resolve missing asset | Upload/scan failure |
| UI-08 | Version history | Compare, preview, create draft from version | Published immutable |
| UI-09 | Preview and content review | Desktop/mobile, variables, warnings | Invalid variables |
| UI-10 | Publish handoff | Summary, validation, publish | Publishing, registered, retry |

## EOW administration screens

| ID | Screen | Owner |
|---|---|---|
| ADM-01 | Content providers | EOW administrator |
| ADM-02 | Mailcraft provider details | EOW administrator |
| ADM-03 | Identity providers and OIDC | EOW administrator/security |
| ADM-04 | Tenant membership and Mailcraft permissions | EOW administrator |
| ADM-05 | Connector delivery/retry log | EOW operator |

OIDC settings must not be placed inside the Mailcraft editor. Provider health and template synchronization must not be mixed with user login configuration.

## Publish dialog content

The dialog shows:

- template name and target locale;
- validation summary;
- variable schema summary;
- HTML and plain-text artifact readiness;
- next immutable version number;
- EOW registration destination;
- publish result and correlation ID.

The primary action remains disabled when blocking validation issues exist. Warnings require acknowledgment but do not necessarily block publish.
