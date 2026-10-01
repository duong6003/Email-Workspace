# M3-S1 Templates Implementation Plan

> **Execution note:** Run this plan one checkpoint at a time. Use the repository's TDD,
> tenant-transaction, evidence-before-status, and Lore commit protocols. Do not start
> `M3-S2-variables` until this node is terminal-complete.

**Goal:** Replace the `/templates` mock with a tenant-scoped template library that safely
imports HTML, preserves a mutable draft, publishes immutable content-addressed versions,
archives templates without deleting history, and provides enough contract/runtime evidence
to close `BR-TPL-002`, `BR-TPL-006`, `BR-TPL-009`, and `BR-TPL-010`.

**Architecture:** `email_template` is the mutable aggregate and draft workspace;
`email_template_version` contains publish-time snapshots that are immutable at both service
and PostgreSQL layers. HTML crosses one trust boundary in `apps/api/src/templates/`: validate
size and resource policy, structurally sanitize, inline CSS without network access, then
sanitize again before storage. REST/PostgreSQL remain authoritative; an outbox event is a
post-commit hint only.

**Tech stack:** NestJS 11, TypeORM/PostgreSQL RLS, Zod 4, OpenAPI-generated types, React 19,
TanStack Query, Vitest, Playwright, and exact pins `sanitize-html@2.17.6` plus
`juice@12.1.2`; the user's 2026-08-12 execution authorization is the dependency approval.

---

## 1. Outcome, boundaries, and stop condition

### In scope

- Real template list, search, status filter, create/import, rename/content edit, detail,
  archive, version history, publish, and immutable-version read APIs.
- A forward migration that extends the existing baseline tables; tenant RLS remains enforced.
- HTML import up to 5 MiB, deterministic sanitation report, CSS inlining without remote fetch,
  and an HTTPS-only image policy.
- Publish-time SHA-256 content hash, monotonically increasing version number, same-transaction
  audit and transactional outbox record.
- `/templates` UI ported from the registered handoff, with real data and the S1-owned
  `importHtml`, `templateActions`, and `templateFilter` overlays.
- Template-specific unit, integration, HTTP/security, contract, web, E2E, accessibility, and
  visual evidence.
- The template instance of the cross-milestone `BR-GEN-006` soft-delete control.

### Explicitly out of scope

- Variable extraction, required/optional policy, Handlebars evaluation, helper allowlists,
  and the compose variable panel: `M3-S2-variables`.
- Server-side merged preview, deterministic generated text fallback, test send, and Mailpit:
  `M3-S3-preview`.
- Campaign snapshot proof: `M4-S4-snapshot`. This plan preserves the version ID/content needed
  for that proof but does not manufacture a fake campaign.
- Managed asset upload/storage/deletion/malware scanning. `GAP-TPL-003` remains open. S1 accepts
  only HTTPS image URLs and rejects embedded or insecure image resources.
- GrapesJS or another visual editor. ADR-019 is Proposed; DEC-005 keeps the handoff's HTML/code
  workflow for MVP.
- Production deployment, destructive data operations, external credentials, and paid services.

### Node stop condition

`M3-S1-templates` may become `completed` only when:

1. `/templates` is real and tenant-scoped; imported HTML stored in draft fields is the final
   sanitized/inlined result and retains a machine-readable sanitation report.
2. Every publish creates a new immutable row with stable SHA-256 hash; old versions remain
   readable; direct database mutation is rejected; no version mutation route exists.
3. `BR-TPL-002`, `BR-TPL-006`, `BR-TPL-009`, and `BR-TPL-010` have all seven traceability links
   and executing tests. `BR-TPL-001`/`BR-TPL-012` remain truthfully open in M4.
4. Template soft delete is evidenced for `BR-GEN-006`; archived rows and their versions remain
   in PostgreSQL and are hidden from default list results.
5. Targeted checks, `pnpm check`, plan validation, migration idempotence, OpenAPI compatibility,
   Compose validation, template E2E, a11y, and visual inspection pass with zero skipped tests.
6. The workspace test count is greater than the M2-GATE baseline of **284 passed, 0 failed,
   0 skipped**; a lower count is investigated even if the command exits zero.

The user's 2026-08-12 authorization to execute this plan includes the reviewed local runtime
dependencies. All checkpoints are within the approved local implementation scope.

---

## 2. Authoritative anchors and planning repairs

| Concern | Source of truth | Decision for this node |
| --- | --- | --- |
| Node acceptance | `state.json` node `M3-S1-templates` | Real library, safe HTML, immutable publish, four directly closable S1 rules |
| Business rules | `catalog/ba-rules.json` | S1 closes 002/006/009/010; builds lifecycle prerequisite for 001 |
| Catalog tests | `catalog/test-cases.json` | S1 executes TC-TPL-002/006/009/010/014 and focused TC-SEC-014 evidence |
| Rendering | Accepted ADR-015 | Sanitize and inline CSS now; Handlebars/text fallback are deferred to their owning slices |
| Module shape | `docs/architecture/module-template.md` | Thin permissioned controller, explicit trusted tenant ID, tenant transaction, repository data boundary |
| UI | Registered `design-reference/ui-handoff-v2/source/` | Port the approved templates DOM/classes before adding required states |
| API intent | `catalog/api-baseline.json`, `contracts/openapi.yaml` | Additive CRUD/publish/version reads; keep future preview/test-send operations out of S1 |
| Runtime event | `contracts/asyncapi.yaml` `template.published` | Write an outbox row in publish transaction; REST data remains canonical |
| Audit | `traceability-plan.yaml` | `audit_log.action=template.published`, metadata contains `template_version_id`; never log content |

### DEC-046 — repair the campaign-snapshot allocation before execution

Move `BR-TPL-001`, `BR-TPL-012`, `TC-TPL-001`, `TC-TPL-012`, and `TC-TPL-015` to
`M4-S4-snapshot`.

- The literal acceptance/test precondition requires a persisted campaign snapshot and an old
  campaign send. Campaign persistence does not exist until M4, which depends on `M3-GATE`.
- M3 still implements and tests template lifecycle/version immutability. That provenance stays
  on the reallocated rows, but M4 owns final closure against a real campaign.
- Resulting gate arithmetic is exact: M3 = 10 rules / 12 tests; M4 = 18 rules / 22 tests;
  repository totals remain 118 BA rules / 159 catalog tests.
- Rejected: closing from version-table evidence alone, because it would not exercise the
  campaign acceptance. Rejected: synthetic campaign fixtures without the M4 aggregate.

### DEC-047 — use the next forward migration number

Use `database/migrations/015_template_versions.sql`, after re-checking that 015 is still free
at node start. The older plan's `008_template_versions.sql` name is invalid because migrations
008–014 are published and locked. Never edit or renumber a published migration.

### DEC-048 — draft-on-aggregate, published rows immutable

Store current mutable subject/HTML/text/report on `email_template`; copy them into
`email_template_version` on publish. Do not model draft rows as mutable version rows.

- This keeps one blanket version immutability trigger correct.
- A published template can receive later draft edits without mutating its latest published
  version. `status=published` means at least one publish exists; draft fields remain the next
  candidate version.
- `DELETE /templates/{id}` archives by setting `status=archived` and `deleted_at`; it never
  deletes the aggregate or its versions.

---

## 3. Locked data and API design

### 3.1 Forward schema (`015_template_versions.sql`)

Extend `email_template` with:

- `draft_subject text NOT NULL DEFAULT ''`
- `draft_html text NOT NULL DEFAULT ''`
- `draft_text_body text NOT NULL DEFAULT ''`
- `draft_validation_json jsonb NOT NULL DEFAULT '{"warnings":[],"errors":[],"changes":[]}'`
- `updated_at timestamptz NOT NULL DEFAULT now()`
- `deleted_at timestamptz NULL`
- lifecycle `CHECK (status IN ('draft','published','archived'))`
- partial unique index on `(tenant_id, lower(btrim(name))) WHERE deleted_at IS NULL`

Extend `email_template_version` with:

- `variable_schema_json jsonb NOT NULL DEFAULT '{"required":[],"optional":[]}'`
- `content_hash text`
- `published_at timestamptz`
- unique `(tenant_id, template_id, version)`; retain existing physical names `version`,
  `text_body`, and `required_variables`.
- add `UNIQUE (tenant_id, id)` on `email_template` and a composite
  `FOREIGN KEY (tenant_id, template_id) REFERENCES email_template(tenant_id, id)` on versions,
  so a version cannot name a parent from another tenant even through owner-level SQL.

Because the baseline `campaign_snapshot.template_version_id` foreign key already references
`email_template_version(id)`, the immutable-version `DELETE` trigger also protects existing and
future campaign references; no draft field or mutable aggregate ID is ever snapshotted.

Migration order:

1. Add nullable/defaulted columns.
2. Backfill existing aggregates/versions. For a version hash, compute the same canonical byte
   representation used by application code with the already-installed `pgcrypto`; set
   `published_at = created_at` for every baseline version.
3. Add `NOT NULL` constraints after backfill.
4. Replace the baseline uniqueness rule with the active normalized-name index.
5. Add an `email_template_version_immutable()` trigger rejecting `UPDATE` and `DELETE`.
6. Preserve current RLS/grants; tests prove they still cover both tables and new columns.
7. Let the architecture migration test add the new checksum to `migrations.lock.json`; inspect
   the resulting diff before staging it.

`001_initial.sql` already installs `pgcrypto`. The migration builds the exact compact text
document `{"format":<json-string>,"subject":<json-string>,"html":<json-string>,
"textBody":<json-string>,"variableSchema":{"required":[],"optional":[]}}`, using `to_json`
for every scalar string so escaping matches `JSON.stringify`, converts it to UTF-8, and stores
`encode(digest(..., 'sha256'), 'hex')`. The TypeScript canonical serializer emits that exact
key order and compact form; a migration integration test compares SQL and TypeScript hashes for
one fixture. Do not leave a nullable hash or introduce a second legacy hash format.

### 3.2 Lifecycle

```text
create/import -> draft
draft --publish(v1)--> published
published --edit draft--> published with unchanged v1 and a new draft candidate
published --publish--> published with vN+1
draft|published --DELETE--> archived + deleted_at
archived --all writes/publish--> 409 TEMPLATE_ARCHIVED
```

Default listing excludes archived rows. `status=archived` may be explicitly filtered by users
with `content:manage`. Versions remain readable by ID after archive for historical references.

### 3.3 Content hash

Create `apps/api/src/templates/template-content-hash.ts` with one exported function:

```ts
type PublishedTemplateContent = {
  subject: string;
  html: string;
  textBody: string;
  variableSchema: { required: unknown[]; optional: unknown[] };
};

export function computeTemplateContentHash(content: PublishedTemplateContent): string;
```

Hash `sha256` over UTF-8 bytes of a versioned canonical JSON document whose keys are emitted in
the fixed order `format,subject,html,textBody,variableSchema`. The `format` value is
`eow-template-content/v1`. Array order is preserved; object keys inside schema values are
recursively sorted. Return lowercase 64-character hex. Tests lock whitespace, Unicode, key
order, and a known vector.

### 3.4 Additive HTTP surface

All routes use server-derived `request.auth.tenantId`, `@RequirePermission(PERMISSIONS.CONTENT_MANAGE)`,
Zod DTOs, CSRF on cookie mutations, and RFC 9457 errors.

| Method/path | Operation | Important outcomes |
| --- | --- | --- |
| `GET /api/v1/templates` | list/search/filter/cursor | 200 page; excludes archived by default |
| `POST /api/v1/templates` | create/import sanitized draft | 201 with report; 409 duplicate; 413 >5 MiB; 422 unsafe resource |
| `GET /api/v1/templates/{templateId}` | aggregate + latest version summary | 200/404; never cross-tenant leak |
| `PATCH /api/v1/templates/{templateId}` | rename and/or replace draft content | 200; 409 duplicate/archived; re-sanitizes HTML |
| `DELETE /api/v1/templates/{templateId}` | archive | 204; versions preserved |
| `POST /api/v1/templates/{templateId}/publish` | publish current draft | 201 immutable version; 409 archived; 422 invalid/empty/unanalysed content |
| `GET /api/v1/templates/{templateId}/versions` | version history | 200 newest first |
| `GET /api/v1/template-versions/{versionId}` | immutable snapshot read | 200/404 |
| `PATCH|DELETE /api/v1/template-versions/{versionId}` | explicit immutable rejection | 405 `TEMPLATE_VERSION_IMMUTABLE`; never mutates data |

Add explicit rejecting handlers for `PATCH` and `DELETE` because Nest's undefined-method
default is 404, not 405. The handlers run normal auth/RBAC/CSRF coverage and always return an
RFC 9457 405 `TEMPLATE_VERSION_IMMUTABLE`; the database trigger separately rejects bypass SQL.

Request rules:

- name: trim, 1–160 characters; subject: max 998 characters;
- request HTML: maximum 5,242,880 UTF-8 bytes, measured server-side with
  `Buffer.byteLength`; the stored sanitized/inlined result is also bounded to 5,242,880 bytes
  so CSS expansion cannot bypass the persistence limit;
- text body: optional in S1, max 1 MiB; empty is stored as `''` and M3-S3 owns generation/send
  readiness;
- create/import returns the stored sanitized HTML plus `sanitizationReport`; UI must not imply
  the raw uploaded file was retained;
- until M3-S2 installs the real variable parser/schema extractor, S1 publish returns 422
  `TEMPLATE_VARIABLES_NOT_ANALYZED` whenever subject, HTML, or text contains a `{{...}}`
  placeholder. Placeholder-bearing drafts remain storable and editable; variable-free S1
  versions legitimately store `{required:[],optional:[]}`. M3-S2 removes this temporary publish
  guard only after it writes the real immutable schema;
- a publish in a row lock allocates `max(version)+1`, inserts version, audit, and outbox in the
  same tenant transaction; the unique constraint remains the race backstop.

### 3.5 Sanitizer/resource policy

Propose exact runtime pins for `apps/api/package.json`:

- `sanitize-html@2.17.6` (MIT, Node `>=22.12.0`)
- `juice@12.1.2` (MIT, Node `>=22.12.0`, built-in types)
- compatible exact `@types/sanitize-html` as an API dev dependency only if TypeScript requires
  it; record its exact resolved version in the dependency review.

Workspace Node `>=22.13.0` and CI Node `22.13.0` satisfy both. Before install, save registry and
upstream evidence for license, maintenance, Node support, package footprint, and advisory
review in the node evidence. The user authorized the reviewed pins by requesting execution on
2026-08-12. Defer Handlebars and `html-to-text` to S2/S3.

Processing order:

1. Reject body over 5 MiB and malformed/non-document HTML.
2. Pre-validate all image/resource and CSS URLs. Images must be absolute `https:`; reject
   `http:`, `data:`, `blob:`, `file:`, `javascript:`, protocol-relative, relative, and `cid:` in
   S1. Validate `srcset` candidate-by-candidate.
3. First structural sanitize with explicit email-safe tags/attributes. Ban scripts, iframe,
   form, object, embed, SVG, MathML, custom elements, `on*`, `@import`, CSS `expression`,
   `behavior`, and `-moz-binding`. Links may use `https`, `mailto`, `tel`, or `#`; unsafe hrefs
   are removed and reported.
4. Run synchronous `juice(html)`. Never call `juiceResources` or `juiceFile`; S1 performs no
   network fetch.
5. Final sanitize the transformed output. Allow only approved inline CSS properties and values;
   every `url(...)` must be parsed/validated as absolute HTTPS. Remove ordinary `<style>` after
   inlining; preserve only explicitly tested responsive media rules if the final policy can
   validate them safely.
6. Preserve `{{...}}` text exactly as opaque source for M3-S2. Never enable a template-syntax
   stripping mode.
7. Return deterministic arrays sorted by DOM encounter order:
   `warnings`, blocking `errors`, and `changes`, each containing `{code,path,message}`.

Blocking resource errors (`IMAGE_URL_NOT_HTTPS`, `DATA_IMAGE_NOT_ALLOWED`, invalid `srcset`,
unsafe CSS URL) return 422 and do not store the draft. Removed executable markup/attributes and
neutralized unsafe anchor hrefs are non-blocking changes/warnings because the stored result is
safe. Both paths have tests and stable problem codes.

---

## 4. File ownership map

### Create

- `database/migrations/015_template_versions.sql`
- `apps/api/src/database/entities/email-template.entity.ts`
- `apps/api/src/database/entities/email-template-version.entity.ts`
- `apps/api/src/templates/templates.module.ts`
- `apps/api/src/templates/templates.controller.ts`
- `apps/api/src/templates/templates.service.ts`
- `apps/api/src/templates/templates.repository.ts`
- `apps/api/src/templates/dto/template.dto.ts`
- `apps/api/src/templates/template-html-policy.ts`
- `apps/api/src/templates/template-content-hash.ts`
- co-located unit tests for DTO, hash, sanitizer, service policy
- `apps/api/test/integration/templates.test.ts`
- `apps/api/test/integration/templates-http.test.ts`
- `apps/api/test/security/templates-security.test.ts`
- `apps/web/src/api/templates.ts`
- `apps/web/src/screens/templates/TemplatesScreen.tsx`
- `apps/web/src/screens/templates/TemplatesScreen.test.tsx`
- `apps/web/src/overlays/ImportHtmlOverlay.tsx`
- `apps/web/src/overlays/TemplateActionsOverlay.tsx`
- `apps/web/src/overlays/TemplateFilterOverlay.tsx`
- `apps/web/e2e/templates.spec.ts`

### Modify

- `apps/api/package.json`, `pnpm-lock.yaml`,
  `.agents/runs/2026-08-10-eow-master-execplan/evidence/M3-S1-templates/dependency-review.md`
- `apps/api/src/database/data-source.ts`, `apps/api/src/app.module.ts`
- `contracts/openapi.yaml`, generated `packages/contracts` outputs
- `apps/api/test/integration/rbac-matrix.test.ts`
- `apps/web/src/app/AppRoutes.tsx`, append-only handoff-compatible CSS additions if required
- `apps/web/e2e/visual-capture.spec.ts`
- run traceability, screen catalog, state, and `EXECPLAN.md`
- `database/migrations.lock.json` through the architecture-test workflow

Do not edit `001_initial.sql`, migrations 002–014, accepted ADR-015, the registered handoff
source, or the user-owned `.claude/settings.local.json`.

---

## 5. Execution plan by checkpoint

Each checkpoint starts by setting the node to `running`/incrementing its attempt when actual
implementation begins, and ends with fresh evidence in `state.json` plus a git commit. Never
leave the node `running` at a session boundary: record truthful `nextAction` and evidence.

### Checkpoint 0 — intake and repair the plan arithmetic

1. Re-read `state.json`, `git status --short`, migration directory, registered handoff status,
   M2-GATE test/skip baseline, and relevant TPL traceability rows.
2. Verify 015 is still the next migration number; if another agent has claimed it, use the next
   free number and update this plan/state before code.
3. Apply DEC-046 allocation: M3 10 rules/12 tests; M4 18 rules/22 tests. Keep all moved rows
   `not_started` and record that M3 will contribute prerequisite code evidence.
4. Treat `HEAD:contracts/openapi.yaml` at node start as the immutable pre-M3 contract baseline;
   use `git show HEAD:contracts/openapi.yaml` to materialize a temporary comparison input only
   when the compatibility checker requires a file. The run evidence directory is ACL-protected
   against direct writes in this workspace.
5. Run fresh `corepack pnpm run check`, record every package's test count and skipped count, and
   stop/diagnose if it differs unexpectedly from 284/0.
6. Transition `M3-S1-templates` to `running`, `attempt: 1`, with its next concrete action.

**Checkpoint commit subject:** `M3-S1: make template delivery evidence-closable`

### Checkpoint 1 — schema and immutable persistence foundation (TDD)

1. Add failing migration/integration tests for backfill, normalized active-name uniqueness,
   lifecycle check, RLS/cross-tenant isolation, soft archive preservation, monotonically unique
   versions, and version update/delete trigger rejection.
2. Add `015_template_versions.sql`; run it forward against local PostgreSQL, then run migration
   again and require every migration 001–015 to report already applied.
3. Add both TypeORM entities using existing column names; register them in `data-source.ts`.
4. Implement repository methods only inside `runInTenantContext`; repository extends or follows
   `TenantScopedRepository` and never accepts caller-supplied tenant scope.
5. Run the focused integration tests, API typecheck/build, architecture tests, and inspect the
   deliberate `migrations.lock.json` addition.

**Checkpoint commit subject:** `M3-S1: preserve template history at the database boundary`

### Checkpoint 2 — sanitizer and safe draft import (TDD)

1. Record the dependency review and exact pins; execution authorization is already recorded,
   then install only `sanitize-html`, `juice`, and required typings.
2. Write failing pure tests covering script/iframe/form/SVG removal, all `on*` handlers,
   javascript/data/http/file/blob/protocol-relative URLs, `srcset`, CSS `url()`, `@import`, CSS
   expression/behavior, deeply nested markup, 5 MiB boundary, malformed HTML, Unicode,
   placeholder preservation, deterministic report ordering, and no remote fetch.
3. Implement the double-sanitize + `juice()` pipeline and stable warning/error/change codes.
4. Add DTO byte limits and map 413/422 to RFC 9457 problem bodies.
5. Add create/update draft service methods; prove only sanitized HTML/report are stored and raw
   dangerous input never appears in DB, logs, audit metadata, or errors.
6. Run focused unit/integration/security tests and API typecheck/build.

**Checkpoint commit subject:** `M3-S1: make imported template HTML safe before persistence`

### Checkpoint 3 — tenant library CRUD and lifecycle (vertical API slice)

1. Generate the module skeleton if useful, then replace every placeholder and keep controller,
   service, repository, and DTO boundaries compliant with the canonical module template.
2. Implement list/search/status/cursor, create/import, detail, draft update/rename, archive, and
   version-history read routes.
3. Map the partial normalized unique index to stable 409 `TEMPLATE_NAME_CONFLICT` for both
   create and rename. Cross-tenant IDs return 404.
4. Add service-level archive audit; preserve rows/versions and block all archived writes with
   409 `TEMPLATE_ARCHIVED`.
5. Add HTTP tests for authentication, `content:manage`, operator success, viewer 403, CSRF,
   Zod validation, duplicate normalization, cross-tenant read/write, archive, and 404 privacy.
6. Extend the RBAC matrix; run API tests/typecheck/build and architecture fitness tests.

**Checkpoint commit subject:** `M3-S1: expose a tenant-safe template library`

### Checkpoint 4 — publish transaction, immutable read, audit, and event (TDD)

1. Add failing tests for v1 publish, edit draft, v2 publish, v1 byte-for-byte stability, stable
   hash known vector, concurrent publish allocation, archived publish rejection, direct SQL
   mutation rejection, and absence of version mutation routes.
2. Implement publish under a row lock in one tenant transaction: load active aggregate, validate
   publishable draft, allocate version, compute canonical hash, insert version, update aggregate
   status/timestamp, append audit, append outbox.
3. Audit action is `template.published`; entity ID is the template ID; metadata contains only
   `template_version_id`, version number, and content hash. It must not contain subject/body.
4. Outbox event type/channel is `template.published`; aggregate is the template; payload carries
   tenant-safe identifiers/version/hash only. Prove no event remains if the transaction rolls
   back. Do not make UI correctness depend on event delivery.
5. Implement immutable version GET and version-list responses.
6. Run publish unit/integration/HTTP/security tests plus API typecheck/build.

**Checkpoint commit subject:** `M3-S1: make every template publication reproducible`

### Checkpoint 5 — OpenAPI and generated contract consumers

1. Add request/response/page/version/report schemas and all S1 operations to OpenAPI with stable
   operation IDs, permission descriptions, and 400/401/403/404/409/413/422 problem responses.
2. Keep the existing future `validate-audience` path additive; do not add preview/test-send now.
3. Run contract generation and compile API/web against generated types.
4. Run OpenAPI compatibility against the pre-M3 snapshot and the first committed baseline; the
   diff must be additive.
5. Add/extend contract tests for every operation's successful and problem response shape.

**Checkpoint commit subject:** `M3-S1: publish the template library contract before UI wiring`

### Checkpoint 6 — approved `/templates` UI with real data

1. Port the handoff template toolbar, pill filters, grid/card markup, drop zone, labels, and class
   names into `TemplatesScreen`; replace `ComingSoon` in `AppRoutes.tsx`.
2. Add TanStack Query hooks/API client using generated contract types, credentials, CSRF, and
   the shared Problem parser. REST refetch is canonical after mutations.
3. Port `ImportHtmlOverlay`: `.html` file selection, client 5 MiB precheck, filename-derived
   initial name, `<title>`-derived initial subject when present, editable name/subject, submit,
   and a sanitation-results panel. The server remains authoritative for size/safety.
4. Port `TemplateActionsOverlay` for rename/archive/publish and `TemplateFilterOverlay` for
   status/search. Add a version-history/detail shell without claiming the M3-S3 merged preview.
5. Implement loading, empty, error/retry, success, and permission-denied at all three viewports,
   plus upload-too-large and sanitizer-rejected overlay states. Do not display a fake variable
   count; use `—`/“Chưa phân tích” until M3-S2 supplies real schema data.
6. Add unit tests for query lifecycle, import, warnings/errors, duplicate rename, archive,
   publish/refetch, and permission denial. Add keyboard/focus-return/axe coverage for overlays.
7. Run web test/typecheck/build.

**Checkpoint commit subject:** `M3-S1: replace the template mock with the approved real workflow`

### Checkpoint 7 — E2E, visual evidence, traceability, and node closure

1. Run a real-PostgreSQL E2E: operator imports safe HTML → sees sanitation changes → searches →
   renames → publishes v1 → edits draft → publishes v2 → reads unchanged v1 → archives; viewer
   receives 403 and cross-tenant IDs return 404.
2. Add adversarial browser/API cases for stored XSS and unsafe resources; verify no script runs
   in the screen/detail shell and raw dangerous content is absent from storage.
3. Capture UI-TPL-001 loading/empty/error/success/permission-denied at 1440×900, 768×1024, and
   390×844 (15 production PNGs). Capture S1-owned import/actions/filter overlays at the same
   viewports for relevant success/rejection/keyboard states.
4. Open and inspect at least one capture for every state and every viewport; record material
   differences. Keep UI-TPL-001/other shared overlays `in_progress` if S2/S3 functionality is
   still required for final M3 equivalence.
5. Update traceability only after tests execute: close 002/006/009/010, add prerequisite evidence
   to moved 001/012 without closing them, and record template soft-delete evidence for GEN-006.
6. Run the final verification matrix below. Compare test/skip counts with M2-GATE and Checkpoint
   0. Any decreased suite is a failure until explained and repaired.
7. Set node terminal-complete with full evidence, `nextAction: null`, and advance currentNode to
   `M3-S2-variables` only after the checkpoint commit is ready.

**Checkpoint commit subject:** `M3-S1: close safe immutable template delivery with evidence`

Every commit body records the fresh workspace test/skip count and relevant targeted checks,
then includes the Lore trailers `Constraint`, `Rejected`, `Confidence`, `Scope-risk`,
`Directive`, `Tested`, and `Not-tested` where they add decision context.

---

## 6. Verification matrix

Run dependent checks sequentially and preserve their output under the node's evidence directory.

```powershell
corepack pnpm --filter @eow/api test -- src/templates
corepack pnpm --filter @eow/api test -- test/integration/templates.test.ts
corepack pnpm --filter @eow/api test -- test/integration/templates-http.test.ts
corepack pnpm --filter @eow/api test -- test/security/templates-security.test.ts
corepack pnpm --filter @eow/api typecheck
corepack pnpm --filter @eow/api build
corepack pnpm --filter @eow/architecture-tests test

corepack pnpm contracts:generate
corepack pnpm --filter @eow/contracts typecheck
# materialize `git show HEAD:contracts/openapi.yaml` to a temporary file, then:
node scripts/openapi-compat-check.mjs <temporary-pre-M3-openapi.yaml> contracts/openapi.yaml
node --test scripts/openapi-compat-check.test.mjs

corepack pnpm --filter @eow/web test
corepack pnpm --filter @eow/web typecheck
corepack pnpm --filter @eow/web build
corepack pnpm --filter @eow/web run e2e -- --grep "M3-S1|templates"

docker compose --env-file .env run --rm migrate
docker compose --env-file .env run --rm migrate
docker compose --env-file .env config --quiet

corepack pnpm run check
py -3.12 .agents/runs/2026-08-10-eow-master-execplan/validate_plan.py
git diff --check
git -c safe.directory="C:/Works/Projects/Email operations workspace/email-operations-workspace" status --short
```

Evidence assertions:

- all targeted and workspace suites: 0 failed, 0 skipped;
- workspace count >284, never lower without a documented expected suite change;
- second migration run reports 001–015 already applied;
- OpenAPI compatibility reports no breaking change;
- audit/outbox integration tests prove same-transaction behavior and body redaction;
- direct `UPDATE` and `DELETE` against a published version fail at PostgreSQL;
- 15 required screen-state PNGs plus owned overlay captures exist and have been inspected;
- no new environment variable, port, migration rewrite, remote fetch, public asset storage, or
  production side effect was introduced.

---

## 7. Risk controls and recovery

| Risk | Control | Recovery |
| --- | --- | --- |
| Sanitizer bypass or CSS URL escape | explicit double-sanitize policy, hostile corpus, final sanitizer is trust boundary | disable import/update route locally, patch policy/tests, forward-only code fix |
| Remote resource fetch/SSRF | use only synchronous `juice(html)`; test that fetch is never called | remove the dependency call path; stored content remains sanitized |
| Publish race | row lock + tenant/template/version unique constraint | retry transaction only for serialization/unique race; never overwrite a row |
| Hash drift | versioned canonical format and known vectors | introduce `v2` format explicitly; never reinterpret old `v1` hashes |
| Cross-tenant leak | RLS, explicit tenant context, 404 negative tests | treat as P0; stop node closure and repair before further slices |
| Archive loses history | soft delete only; immutability FK/trigger tests | forward migration/code repair; never hard-delete as rollback |
| UI overclaims S2/S3 | “Chưa phân tích” variable state; no merged preview/test-send claims | keep shared screen/overlays in progress until owning slices close |
| Dependency regression | exact pins, lockfile, license/security/maintenance evidence | revert checkpoint commit before data migration if dependency cannot pass review |

No accepted ADR is changed by this plan. If safe asset handling later requires managed storage,
retention, authorization, or malware-scanning semantics, stop at `GAP-TPL-003` and obtain the
necessary product/security ownership before broadening scope.
