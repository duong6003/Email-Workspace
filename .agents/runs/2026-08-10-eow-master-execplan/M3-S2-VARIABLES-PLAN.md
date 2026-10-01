# M3-S2 Variables Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:test-driven-development` while implementing each checkpoint and `superpowers:verification-before-completion` before reporting the node complete. Keep this node inside the existing master run; do not create a second run state. Do not capture, open, read, or modify any image or anything under `.agents/runs/2026-08-10-eow-master-execplan/evidence/visual/`.

**Goal:** Replace the temporary template-variable publish fence with bounded strict parsing, persist an immutable required/optional variable schema, and expose a real system/custom variable catalogue in the compose surface without implementing M4 campaign policy.

**Architecture:** Add a dependency-free, linear-time parser and renderer for the accepted `{{variable_key}}` subset. The analyser derives availability and metadata from one system-variable source plus the tenant's `custom_field_definition` rows, and `TemplatesService.publish()` invokes it inside the existing tenant transaction before writing the immutable version and content hash. A pure renderer over the same parsed tokens proves required-missing and optional-default/empty semantics without creating an M3-S3 preview or send surface. The web slice ports only the approved compose variable-panel shell and reads `GET /custom-fields`; the rest of the M4 composer remains an honest placeholder.

**Tech stack:** TypeScript 5.9, NestJS 11, TypeORM/PostgreSQL, Zod 4, React 19/Vite 8, Vitest 4, OpenAPI 3.1, pnpm 11.

---

## 1. Outcome, scope, and non-goals

### Required outcomes

- Publishing a draft containing valid variables succeeds and stores a deterministic `variable_schema_json` on the new immutable `email_template_version`.
- The parser reads subject, HTML, and text together, accepts only the simple key form `{{[a-z][a-z0-9_]*}}`, detects duplicate occurrences, and rejects malformed tags, unknown keys, helpers, partials, blocks, comments, triple braces, paths, prototype-like names, or any other Handlebars expression shape before publish.
- System variables come from one shared source that contains exactly `email`, `first_name`, `last_name`, and `unsubscribe_url`, matching `RESERVED_CUSTOM_FIELD_KEYS` and the published migration-007 constraint.
- Custom variables come from the current tenant's `custom_field_definition` rows. A custom field is required when `required=true` and it has no default; it is optional when `required=false` or a default is configured. The immutable schema preserves the established required/optional key arrays and adds optional defaults for M3-S3/M4 consumers without breaking existing responses.
- `/email/compose` exposes the approved variable-panel vocabulary with real system variables and the current tenant's real custom fields, including loading, empty-custom-catalogue, error/retry, and success states. The panel does not create a campaign, render a preview, or claim audience mapping is complete.
- `BR-TPL-003` closes only after `TC-TPL-003` and `TC-TPL-013` execute. `BR-TPL-004` closes only after `TC-TPL-004` exercises both schema persistence and the shared renderer: a missing required value returns a structured error, while a missing optional value uses its immutable default or an empty string. M3-S3 must reuse this renderer for preview instead of implementing a second merge path.
- `unsubscribe_url` is accepted and persisted as a system variable and recorded as prerequisite evidence for `BR-TPL-008`; `BR-TPL-008` and `TC-TPL-008` remain `not_started` under DEC-049.

### Hard non-goals

- No image/screenshot/visual-evidence work, no Playwright screenshot spec, and no access under `evidence/visual/`.
- No edits to migrations `001`-`015`, `database/migrations.lock.json`, accepted ADRs, or existing published `email_template_version` rows/hashes.
- No campaign draft, audience validation, schedule/send blocking, List-Unsubscribe header, preview endpoint/UI, test-send delivery, derived-variable builder, or arbitrary helper execution. The pure restricted renderer required by `BR-TPL-004` is in scope; orchestration around it belongs to M3-S3/M4/M5.
- No dependency installation. A Handlebars dependency is not required for this restricted grammar. If implementation evidence proves otherwise, stop and request approval with exact package/version and supply-chain analysis.

## 2. Acceptance criteria

1. `publishTemplate` accepts a draft using all four system keys plus a tenant custom field and returns `201` with a deterministic schema whose keys are unique and sorted.
2. A system field is required/optional according to an explicit constant policy; a custom field maps from `required` and `default_value`, and `required_variables` mirrors the required schema keys.
3. The same key repeated across subject/HTML/text is reported as a duplicate and blocks publish with `422 DUPLICATE_VARIABLE` before any version, audit row, or outbox event is created.
4. `{{employee_grade}}` with no matching tenant custom field blocks publish with `422 UNKNOWN_VARIABLE` and a structured `variableKey`/diagnostic body (`TC-TPL-013`).
5. Broken delimiters and every unsupported construct (`{{#if x}}`, `{{/if}}`, `{{> p}}`, `{{helper x}}`, `{{{x}}}`, `{{../x}}`, `{{this.x}}`, comments, prototype-like keys) block publish with stable 422 codes; helpers are never evaluated.
6. Rendering with a missing required key returns a structured `MISSING_REQUIRED_VARIABLE` result and does not emit partially merged content; missing optional keys use the stored default or `''`. Subject, HTML, and text use the same renderer and schema.
7. A stress fixture at the maximum accepted content size completes without recursion/stack overflow and respects a bounded tag/occurrence budget. The implementation performs one bounded scan per content field rather than backtracking over the whole template.
8. The compose variable panel calls real `GET /custom-fields`, renders `email`, `first_name`, `last_name`, `unsubscribe_url` once, and renders each returned custom field once with required/optional/default metadata.
9. `contentHash` changes when the derived schema changes for a newly published version; old version rows remain byte-for-byte immutable and the existing PATCH/DELETE 405 and database trigger tests stay green.
10. `traceability.csv` has real code paths, `publishTemplate`, `TC-TPL-003/004/013`, and real tests before any status transition. DEC-049 evidence is appended without changing `BR-TPL-008` status.
11. Final verification is fresh: exact test/skip counts from `corepack pnpm run check`, live rebuilt-stack endpoint responses, OpenAPI compatibility when applicable, plan validator `0 errors / 0 warnings`, clean diff/UTF-8 checks, and no staged stray `api-m3.err`/`web-m3.err`.

## 3. Planned file structure

| Path | Responsibility |
| --- | --- |
| `apps/api/src/templates/template-variables.ts` | Single system-variable catalogue, immutable schema types, bounded strict parser/analyser, stable diagnostic codes. |
| `apps/api/src/templates/template-variables.test.ts` | Parser RED/GREEN matrix, duplicate/malformed/unsafe/stress tests, `unsubscribe_url` prerequisite proof. |
| `apps/api/src/templates/template-variable-renderer.ts` | Pure strict rendering over analysed tokens and immutable schema; required-missing error and optional default/empty semantics. |
| `apps/api/src/templates/template-variable-renderer.test.ts` | `TC-TPL-004` unit evidence across subject/HTML/text with no preview/send side effects. |
| `apps/api/src/templates/templates.service.ts` | Load tenant custom-field definitions in the existing transaction, analyse subject/HTML/text at publish, persist schema/required keys, retain canonical hashing. |
| `apps/api/test/integration/templates-http.test.ts` | Replace the M3-S1 422 fence assertion with TC-TPL-003/004/013 HTTP persistence and rejection evidence. |
| `apps/api/src/database/entities/email-template-version.entity.ts` | Replace `unknown[]` with the exact immutable schema type; no schema migration. |
| `apps/web/src/screens/compose/ComposeVariablePanel.tsx` | Approved compose context-panel shell backed by the shared catalogue and `GET /custom-fields`. |
| `apps/web/src/screens/compose/variable-catalogue.ts` | Pure mapping/search/grouping functions for system and custom variables. |
| `apps/web/src/screens/compose/variable-catalogue.test.ts` | Deterministic system/custom mapping, dedupe, required/optional/default, loading/error/empty data-model tests. |
| `apps/web/src/screens/compose/ComposeVariablesScreen.tsx` | Narrow compose shell: variable panel plus explicit later-milestone placeholder for editor/campaign behavior. |
| `apps/web/src/app/AppRoutes.tsx` | Replace `/email/compose` `ComingSoon` with the narrow variables screen; retain existing permission guard. |
| `apps/web/src/api/customFields.ts` | Reuse current typed client; only clarify M3 consumer documentation if necessary. |
| `contracts/openapi.yaml` | Add the backward-compatible optional `variableSchema.defaults` map and document publish 422 diagnostics if the response shape becomes public. |
| `packages/contracts/src/openapi.d.ts` | Regenerated by the existing contract script; never hand-edit. |
| `.agents/runs/2026-08-10-eow-master-execplan/{state.json,traceability.csv,screen-catalog.yaml,EXECPLAN.md}` | Checkpoint evidence, honest rule status, UI handoff note for reviewer, and node completion evidence. |

No migration is planned: migration `015_template_versions.sql` already supplies `variable_schema_json` and the legacy `required_variables` array. Recheck the migration directory at intake; if a genuine database invariant is needed, allocate the next free forward migration only after proving it cannot be enforced in existing application/schema boundaries.

## 4. Locked data and parser contract

### System catalogue

Use one exported tuple as the parser/UI/API source and assert equality with `RESERVED_CUSTOM_FIELD_KEYS`:

```ts
export const SYSTEM_TEMPLATE_VARIABLES = [
  { key: 'email', label: 'Email', required: true },
  { key: 'first_name', label: 'Tên', required: false },
  { key: 'last_name', label: 'Họ', required: false },
  { key: 'unsubscribe_url', label: 'Link hủy đăng ký', required: false },
] as const;
```

This keeps `unsubscribe_url` parser-valid without pretending marketing policy already makes it required. M4-S3 may require it conditionally by campaign type under DEC-049.

### Persisted schema

Keep the published key-array contract. Add an optional default-value map so defaults are immutable and reusable without replacing `required` and `optional` with object entries:

```ts
export type TemplateVariableSchema = {
  required: string[];
  optional: string[];
  defaults?: Record<string, unknown>;
};
```

Canonicalization rules: de-duplicate by key for the stored schema, sort both arrays lexicographically, include only optional keys with configured defaults in `defaults`, and derive `required_variables` directly from `schema.required`. Occurrence duplicates remain a publish error even though schema storage is unique.

### Restricted grammar

Accept only an exact ASCII tag after trimming outer tag whitespace:

```text
{{ variable_key }}
variable_key := [a-z][a-z0-9_]{0,63}
```

Scan characters iteratively, never recursively. Every opening `{{` must have exactly one matching `}}`; stray `}}`, nested braces, triple braces, empty expressions, or an occurrence count over the chosen budget produce a structured error. The expression payload must be only the key; any whitespace-separated arguments or prefix/sigil rejects helpers/partials/blocks/comments instead of ignoring them.

## 5. Checkpointed TDD implementation plan

### Checkpoint 0: Intake and state start

**Files:**
- Modify: `.agents/runs/2026-08-10-eow-master-execplan/state.json`

- [ ] Verify `HEAD`/worktree with `git -c safe.directory='C:/Works/Projects/Email operations workspace/email-operations-workspace' status --short --branch`; confirm only locked `api-m3.err` and `web-m3.err` are untracked and leave them untouched.
- [ ] Re-list `database/migrations`; confirm `001`-`015` are published and no migration is needed.
- [ ] Run `python scripts/ui_handoff.py status` with the available UTF-8-capable Python runtime and record the returned ready SHA; do not inspect any images.
- [ ] Update node `M3-S2-variables` to `running`, increment `attempt`, set `nextAction` to the parser RED test, add goal/scope/risk/test-layer evidence, and update `updatedAt` in UTF-8.
- [ ] Commit the checkpoint immediately with the Lore protocol; body records the trusted baseline `API 221, worker 21, web 27, architecture 20, runtime-orchestration 3, api-schematics 1; 0 skipped` and notes that it was supplied/verified at `695488d`, not re-run if no fresh run was performed.

### Checkpoint 1: Strict parser RED → GREEN

**Files:**
- Create: `apps/api/src/templates/template-variables.test.ts`
- Create: `apps/api/src/templates/template-variables.ts`
- Modify: `apps/api/src/custom-fields/dto/custom-field.dto.ts` only if needed to import/re-export the shared key tuple without a dependency cycle

- [ ] Write failing unit tests first for: all four system keys, tenant custom key metadata, subject+HTML+text scanning, sorted schema, duplicate occurrence, unknown variable, unmatched opening/closing braces, empty tag, invalid key, helpers, blocks, partials, comments, triple braces, paths/prototype-like payloads, maximum-size input, occurrence cap, and no recursion.
- [ ] Run:

```powershell
corepack pnpm --filter @eow/api exec vitest run src/templates/template-variables.test.ts
```

Expected RED: module/export not found, followed by assertion-specific failures as the interface is introduced. Record the exact failing test names/output in `state.json` before implementation.

- [ ] Implement the minimal iterative scanner and catalogue resolver. Export stable error objects/codes usable by the HTTP layer; do not add Handlebars.
- [ ] Re-run the same test file. Expected GREEN: all parser cases pass, 0 skipped.
- [ ] Run API typecheck. Assert the system tuple keys equal `RESERVED_CUSTOM_FIELD_KEYS` in a unit test so the two lists cannot drift.
- [ ] Update state evidence and commit with the Lore protocol and exact targeted test/skip count.

### Checkpoint 2: Publish integration and immutable schema RED → GREEN

**Files:**
- Modify: `apps/api/test/integration/templates-http.test.ts:20-141`
- Modify: `apps/api/src/templates/templates.service.ts:15-66,120-141`
- Modify: `apps/api/src/database/entities/email-template-version.entity.ts:27-31`
- Optionally modify: `apps/api/src/templates/templates.module.ts` only if a service import is genuinely required; prefer querying `CustomFieldsRepository` with the existing transaction manager to keep transaction ownership explicit.

- [ ] Rewrite the existing assertion at `templates-http.test.ts:138-141` before production code. Create a tenant custom field fixture and assert:
  - valid required/optional/system/custom variables publish `201`;
  - response and direct DB read contain the canonical schema/default;
  - `required_variables` matches required keys;
  - `unsubscribe_url` is accepted as system prerequisite evidence;
  - duplicate, malformed, unsafe, and unknown templates return the exact stable 422 code;
  - failure creates zero new version/audit/outbox rows;
  - same key is unknown in another tenant without that custom-field definition.
- [ ] Run the targeted integration file before service edits:

```powershell
corepack pnpm --filter @eow/api exec vitest run test/integration/templates-http.test.ts
```

Expected RED: current `TEMPLATE_VARIABLES_NOT_ANALYZED` and empty schema disagree with the new assertions. Record exact failures in state.

- [ ] Remove `containsTemplateExpression` and `TEMPLATE_VARIABLES_NOT_ANALYZED`. In the existing `runInTenantContext` callback, load `custom_field_definition` through the same `EntityManager`, analyse the three draft fields, translate diagnostics to RFC 9457-compatible 422 bodies, then save schema, required keys, and the existing canonical content hash.
- [ ] Keep version creation, template status update, audit, and outbox in the same transaction. Do not update/delete any pre-existing version.
- [ ] Re-run the targeted integration test, `templates.test.ts`, API typecheck, and architecture tests. Expected GREEN with zero skips and unchanged immutability tests.
- [ ] Update state evidence and commit with exact counts.

### Checkpoint 3: Shared strict renderer RED → GREEN

**Files:**
- Create: `apps/api/src/templates/template-variable-renderer.test.ts`
- Create: `apps/api/src/templates/template-variable-renderer.ts`
- Reuse: `apps/api/src/templates/template-variables.ts`

- [ ] Write failing `TC-TPL-004` tests before implementation:
  - all required values present renders subject/HTML/text deterministically;
  - any required value missing returns `MISSING_REQUIRED_VARIABLE` with all missing keys and no partially rendered payload;
  - an optional value uses its persisted typed default converted deterministically to text;
  - an optional value without default renders as `''`;
  - false/zero defaults are preserved rather than treated as absent;
  - unknown context keys are ignored and cannot introduce executable expressions;
  - values containing `{{...}}` are inserted as inert text and are never recursively evaluated;
  - the renderer consumes parsed tokens and respects the same size/occurrence bounds.
- [ ] Run:

```powershell
corepack pnpm --filter @eow/api exec vitest run src/templates/template-variable-renderer.test.ts
```

Expected RED: renderer module/export does not exist. Record exact output in state.

- [ ] Implement one-pass substitution over the parser token stream. HTML escaping policy must follow ADR-015: ordinary `{{key}}` values are escaped for HTML content; subject/text receive deterministic plain text; URL/attribute safety remains enforced by the sanitized template and later rendering integration. Do not support triple-stache or helpers.
- [ ] Re-run renderer and parser tests plus API typecheck. Expected GREEN, zero skipped.
- [ ] Record this as the literal render half of `BR-TPL-004` and as the required shared engine for M3-S3. Commit exact counts with the Lore protocol.

### Checkpoint 4: OpenAPI and generated contract alignment

**Files:**
- Modify: `contracts/openapi.yaml:41-45,734-746`
- Regenerate: `packages/contracts/src/openapi.d.ts`
- Modify: `packages/contracts/src/contract-shape.check.ts` if needed for a compile-time schema assertion

- [ ] Before editing, extract the baseline using Bash as required:

```bash
git show 695488d:contracts/openapi.yaml > /tmp/m3-s2-openapi-baseline.yaml
```

- [ ] Add optional `TemplateVersion.variableSchema.defaults` (`additionalProperties: true`) while preserving required/optional string arrays, and document the structured 422 diagnostic extensions without removing existing responses.
- [ ] Run generation/typecheck and the compatibility check:

```powershell
corepack pnpm --filter @eow/contracts run generate
corepack pnpm --filter @eow/contracts run typecheck
node scripts/openapi-compat-check.mjs /tmp/m3-s2-openapi-baseline.yaml contracts/openapi.yaml
```

Expected: generated types compile and compatibility reports no breaking changes. If tightening existing item types is considered breaking by the checker, preserve the backward-compatible contract representation and expose richer metadata additively instead of overriding the gate.

- [ ] Update state evidence and commit exact results.

### Checkpoint 5: Real compose variable panel RED → GREEN

**Files:**
- Create: `apps/web/src/screens/compose/variable-catalogue.test.ts`
- Create: `apps/web/src/screens/compose/variable-catalogue.ts`
- Create: `apps/web/src/screens/compose/ComposeVariablePanel.tsx`
- Create: `apps/web/src/screens/compose/ComposeVariablesScreen.tsx`
- Modify: `apps/web/src/app/AppRoutes.tsx:39-44`
- Reuse: `apps/web/src/api/customFields.ts:52-56`
- Modify: `apps/web/src/app/globals.css` only for small named state styles not already supplied by the handoff classes

- [ ] Write failing pure web tests first for catalogue assembly: exact four system keys, real custom-field mapping, dedupe, deterministic ordering, required/optional/default labels, search filtering, and empty custom catalogue while system entries remain visible.
- [ ] Run:

```powershell
corepack pnpm --filter @eow/web exec vitest run src/screens/compose/variable-catalogue.test.ts
```

Expected RED: compose catalogue module does not exist. Record exact output in state.

- [ ] Implement `variable-catalogue.ts`, reusing the API `CustomField` shape and keeping the system keys synchronized with the backend contract. Do not copy the handoff's unsupported static fields such as `department`, `company_name`, or `current_date` unless they exist in `GET /custom-fields`.
- [ ] Port the handoff context-panel DOM/class vocabulary from `design-reference/ui-handoff-v2/source/app/page.tsx:134-141`. Load `GET /custom-fields`; render system and custom groups with required/optional/default metadata; add bounded search, loading, empty-custom, error/retry, and success states. Do not implement the `customVariableBuilder` because it is derived-code execution and outside this node.
- [ ] Replace only `/email/compose`'s `ComingSoon` with `ComposeVariablesScreen`. Keep a clearly labelled placeholder in the main compose-card area for M4 campaign/editor work and do not show fake sender/audience/template/preview/mapping data.
- [ ] Re-run targeted web tests, web typecheck, and web build. Expected GREEN and zero skips.
- [ ] Add a non-visual reviewer note to `state.json` describing the variable-panel states that require later reviewer evidence. Do not capture or read them.
- [ ] Update state evidence and commit with exact targeted test/skip count.

### Checkpoint 6: Rule traceability and honesty gate

**Files:**
- Modify: `.agents/runs/2026-08-10-eow-master-execplan/traceability.csv:52-57`
- Modify: `.agents/runs/2026-08-10-eow-master-execplan/state.json:615-630`
- Modify: `.agents/runs/2026-08-10-eow-master-execplan/screen-catalog.yaml:148-154` only with code paths/API/state notes, never visual evidence claims
- Modify: `.agents/runs/2026-08-10-eow-master-execplan/EXECPLAN.md:863-869,1218+`

- [ ] Populate `BR-TPL-003` with `publishTemplate`, parser/service/UI code paths, `TC-TPL-003;TC-TPL-013`, parser and HTTP test files, and its final status only after both literal cases pass.
- [ ] Populate `BR-TPL-004` with analyser/service/renderer code paths and `TC-TPL-004`. Set `closed` only after the real published schema plus required-missing and optional-default/empty renderer tests all pass. Record that M3-S3 must integrate, not duplicate, the shared renderer.
- [ ] Append prerequisite evidence to `BR-TPL-008`/state/ExecPlan: parser accepted and persisted `unsubscribe_url`; leave milestone `M4`, slice `M4-S3-variable-policy`, test `TC-TPL-008`, and status `not_started` unchanged.
- [ ] Update `screen-catalog.yaml` for UI-EMAIL-001 only with real code paths and implemented state notes. Leave `status`/visual evidence to the reviewer if the catalogue contract requires visual proof.
- [ ] Run `python .agents/runs/2026-08-10-eow-master-execplan/validate_plan.py` after each traceability/state edit until it reports `0 errors, 0 warnings`.
- [ ] Commit this checkpoint with the Lore protocol and current test/skip evidence.

### Checkpoint 7: Full verification and live rebuilt-stack probes

**Files:**
- Modify: `.agents/runs/2026-08-10-eow-master-execplan/state.json`
- No visual files

- [ ] Run the full workspace check once without competing CPU-heavy work:

```powershell
corepack pnpm run check
```

Record per-workspace counts and the exact total skipped count. If the documented unrelated `auth-http.test.ts` or `boot.test.ts` contention flake appears, stop competing work, rerun once uncontended, preserve both outputs, and do not edit those tests.

- [ ] Rebuild the live stack because API/web/contracts changed:

```powershell
docker compose --env-file .env up -d --build --wait
```

- [ ] Seed/use the configured local demo account, obtain session and CSRF cookies through the real login endpoint, and probe actual changed behavior at `http://localhost:8080`:
  - `GET /api/v1/custom-fields` returns the real tenant catalogue;
  - create a uniquely named draft containing known system/custom variables;
  - publish returns `201` with structured required/optional schema including `unsubscribe_url`;
  - publish a separate unknown/unsafe draft and capture real `422 UNKNOWN_VARIABLE` / unsafe-expression Problem bodies;
  - `GET /api/v1/template-versions/{id}` returns the same immutable schema;
  - `GET /email/compose` returns the rebuilt web app, and route behavior is exercised without screenshots.
- [ ] Remove only the uniquely prefixed local probe rows through normal recoverable API operations where supported. Never update/delete the published version; archive its template aggregate and retain immutable history as designed.
- [ ] Run, as applicable:

```powershell
python .agents/runs/2026-08-10-eow-master-execplan/validate_plan.py
git -c safe.directory='C:/Works/Projects/Email operations workspace/email-operations-workspace' diff --check
git -c safe.directory='C:/Works/Projects/Email operations workspace/email-operations-workspace' status --short
```

Expected: validator `0/0`, diff check clean, and stray `.err` files still untracked/unmodified.

- [ ] Update node evidence with exact commands, responses, test/skip counts, rules honestly closed/not closed, dependency status (`none added`), and explicit confirmation that zero images were captured/read and `evidence/visual/` was untouched.
- [ ] Set the node to `completed` only if every success condition and literal closure claim is proven; otherwise checkpoint it `blocked`/`running` with the precise outstanding acceptance. Commit the final checkpoint with the Lore protocol and the full workspace count/skip count in the body.

## 6. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Restricted parser is mislabeled as full Handlebars | Name and document the accepted subset; reject every unsupported expression. M3-S3 may reuse it for strict rendering without helper execution. |
| Catastrophic regex/backtracking or stack growth | Iterative index scan, bounded key length and occurrence count, stress test at content limit, no recursion. |
| System key drift | One tuple plus equality test against `RESERVED_CUSTOM_FIELD_KEYS`; UI consumes the contract/export rather than a handwritten second list. |
| Required/optional semantics become ambiguous | Lock the mapping in tests: explicit system policy; custom required iff `required && default absent`; persist defaults on optional entries. Do not conflate campaign-conditional `unsubscribe_url` policy with parser availability. |
| Schema change silently mutates old hashes | Only new publishes derive the richer schema; never backfill/recompute old rows. Existing DB trigger and 405 tests remain mandatory. |
| Compose work expands into M4 | Port only the variable panel and a truthful main-area placeholder. No campaign/editor/preview/audience mutations. |
| Rule closed on partial evidence | Literal acceptance gate at checkpoint 5; partial M3-S2 evidence is recorded without closure if M3-S3 render tests are still required. |
| Stale containers hide runtime defects | Mandatory `docker compose ... up -d --build --wait` and live changed-endpoint probes after final code. |
| Unauthorized visual work | No screenshots, no browser capture, no image reads, no `evidence/visual/` access; state note only for reviewer. |

## 7. Verification matrix

| Layer | Proof |
| --- | --- |
| Unit/API | Exact grammar, diagnostics, duplicate/unknown/unsafe cases, catalogue synchronization, bounded stress, required-missing and optional-default/empty rendering. |
| Integration/API | Real PostgreSQL tenant custom-field lookup, publish transaction, schema/hash persistence, no side effects on rejected publish, cross-tenant unknown key. |
| Contract | Generated OpenAPI types compile; compatibility against `695488d` baseline; no removed/narrowed public operation. |
| Unit/Web | System/custom mapping, deterministic grouping/search, required/optional/default labels. |
| Build | API/web/contracts typecheck and build; whole workspace check. |
| Runtime | Rebuilt Docker stack; authenticated live custom-field/publish/version/error probes via `localhost:8080`. |
| Governance | Plan validator 0/0; real traceability paths/tests/status; Lore commits at every state checkpoint; UTF-8 and diff checks clean. |
| Visual boundary | No agent capture/read; reviewer-only note exists for the variable-panel states. |

## 8. Commit checkpoints

Every state checkpoint is committed immediately; do not amend or squash during node execution. Suggested Lore intent lines:

1. `Ground M3-S2 execution in its verified variable boundaries`
2. `Constrain template expressions to a safe deterministic grammar`
3. `Permit publishing only after tenant-aware variable analysis`
4. `Make missing-value rendering obey the immutable schema`
5. `Keep the published variable contract reusable across later rendering`
6. `Expose real merge variables without pretending campaign compose exists`
7. `Make M3-S2 rule status follow executable evidence`
8. `Close M3-S2 only on rebuilt-runtime and workspace proof`

Each commit body includes `Tested:` with exact test counts and `Not-tested:` for any gap; final commit also reports exact workspace skip count.

## 9. Self-review

- Spec coverage: all four node success conditions map to checkpoints 1-7; `BR-TPL-004`'s literal render clause is proven by the shared renderer rather than deferred; DEC-049 is preserved; no migration/image/dependency/immutable-row constraint is omitted.
- Placeholder scan: implementation steps name exact files, commands, expected RED/GREEN evidence, and decision gates. The only UI placeholder is intentional product behavior that prevents false M4 scope claims.
- Type consistency: `TemplateVariableSchema` is the shared shape used by parser, renderer, entity, service, OpenAPI, generated contract, and web mapping; it preserves the pre-existing key-array contract.
- Stop condition: the node is complete only when parser/publish/panel evidence exists, traceability is honest, workspace and live rebuilt-stack verification pass, and zero images were captured/read.
