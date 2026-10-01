# M4-S1 Campaign Draft Implementation Plan

Node: `M4-S1-campaign-draft` (run `2026-08-10-eow-master-execplan`)
Depends on: `M3-GATE` (completed 2026-08-13)
Owns rules: **BR-CMP-001**, **BR-CMP-011**, **BR-CMP-012**
Owns test cases: **TC-CMP-001**, **TC-CMP-011**, **TC-CMP-012**
Screens: **UI-EMAIL-001** (`/email/compose`, currently `partially_migrated`),
**UI-EMAIL-002** (`/email/drafts`, currently `not_inventoried`)
Overlays owned here: `draftSaved`, `draftActions`

---

## 1. Outcome, scope, and non-goals

### Required outcomes

The node's `successConditions` in `state.json`, restated so each is independently checkable:

1. `/email/compose` creates and autosaves a **real** campaign draft in PostgreSQL, with
   optimistic concurrency enforced through `If-Match`, so a stale editing session cannot
   overwrite a newer one (BR-CMP-001 acceptance).
2. `/email/drafts` lists **real** drafts from the API with **real** completeness, not the
   handoff's hardcoded `drafts` array (`app/page.tsx` L57-61) and not a hardcoded `85%`.
3. BR-CMP-001, BR-CMP-011, BR-CMP-012 flip to `closed` in `traceability.csv` with real
   `code_paths`, `test_files`, `openapi_operation_ids` and `log_or_metric_or_audit`.

### Hard non-goals

Everything below is another node's; building any of it here would repeat the M3-S3 scoping
mistake in the opposite direction (shipping surface no rule in this node owns):

- **Audience resolution** — list/tag/exclusion resolution, deduplication, eligibility
  filtering and real counts are M4-S2. This node persists an *audience definition* as an
  opaque, schema-validated JSON document and never resolves it.
- **Variable policy / missing-variable matrix** — M4-S3.
- **Campaign snapshot freeze, send and schedule** — M4-S4 and M5. The existing mock
  `schedule`/`send`/`cancel`/`progress` handlers stay exactly as they are; this node must
  not make them look real.
- **Sender configuration** — M5-S1 owns the sender catalogue. The draft stores a sender
  *reference* that M5-S1 will tighten.
- **The `recipientPicker` and `sender` overlays** — they select from surfaces M4-S2/M5-S1
  build. This node ships the two overlays whose data it actually owns: `draftSaved`
  and `draftActions`.

---

## 2. Acceptance criteria

| # | Criterion | Rule | Proof layer |
|---|-----------|------|-------------|
| A1 | A draft persists name, subject, template + version, sender ref, audience definition and settings across a process restart | BR-CMP-001 | integration (real PostgreSQL) |
| A2 | Autosave loses no data: a sequence of PATCHes each land, and the final read returns the last write | BR-CMP-001 | integration |
| A3 | A PATCH carrying a stale `If-Match` is rejected with 412 and does **not** mutate the row | BR-CMP-001 | integration |
| A4 | A PATCH with no `If-Match` is rejected with 428 (never a silent last-writer-wins) | BR-CMP-001 | integration |
| A5 | Editing a campaign in `sending` or `completed` returns 409, at the API **and** at the database | BR-CMP-011 | integration + SQL-level trigger test |
| A6 | Duplicate mints a new id, status `draft`, version reset, and copies **no** progress rows | BR-CMP-011 | integration |
| A7 | Campaign name is mandatory and non-empty, at the API and by CHECK constraint | BR-CMP-012 | integration + SQL |
| A8 | The campaign name never appears in the rendered subject or body | BR-CMP-012 | unit + integration |
| A9 | Name appears in audit rows for every draft mutation | BR-CMP-012 | integration (audit_log) |
| A10 | Cross-tenant read/write of a campaign is impossible | domain invariant | integration |
| A11 | `/email/drafts` renders real drafts with real completeness at 3 viewports, with loading, empty, error, success and permission_denied states | BR-CMP-001/011 | e2e + visual |
| A12 | `/email/compose` autosaves against the real API and surfaces save state and conflict | BR-CMP-001 | e2e |

---

## 3. Planned file structure

```
database/migrations/017_campaign_drafts.sql            new
apps/api/src/database/entities/campaign.entity.ts       new
apps/api/src/campaigns/campaign-completeness.ts         new (pure, shared shape with web)
apps/api/src/campaigns/campaign-completeness.test.ts    new
apps/api/src/campaigns/campaigns.repository.ts          new
apps/api/src/campaigns/dto/campaign.dto.ts              extended (zod schemas)
apps/api/src/campaigns/campaigns.service.ts             rewritten (mock progress/schedule/send/cancel kept verbatim)
apps/api/src/campaigns/campaigns.controller.ts          extended
apps/api/test/integration/campaign-drafts.test.ts       new
apps/api/test/integration/campaign-draft-http.test.ts   new
contracts/openapi.yaml                                  additive
packages/contracts/src/generated.ts                     regenerated
apps/web/src/api/campaigns.ts                           new (+ .test.ts)
apps/web/src/screens/compose/ComposeDraftScreen.tsx     new (absorbs ComposeVariablesScreen's panel)
apps/web/src/screens/compose/draft-autosave.ts          new (+ .test.ts, pure debounce/version reducer)
apps/web/src/screens/drafts/DraftsScreen.tsx            new
apps/web/src/overlays/DraftActionsOverlay.tsx           new
apps/web/e2e/campaign-drafts.spec.ts                    new
```

---

## 4. Locked data contract

### `campaign` draft columns (migration 017, forward-only)

`campaign` already exists in the **published** `001_initial.sql` with
`id, tenant_id, name, status, scheduled_at_utc, scheduled_timezone, version bigint, created_by,
created_at, updated_at`. 001 is never edited. 017 adds:

| Column | Type | Why |
|--------|------|-----|
| `subject` | `text NOT NULL DEFAULT ''` | BR-CMP-001 |
| `template_id` | `uuid REFERENCES email_template(id)` | BR-CMP-001 |
| `template_version_id` | `uuid REFERENCES email_template_version(id)` | BR-CMP-001, consumed by M4-S4 |
| `sender_json` | `jsonb NOT NULL DEFAULT '{}'` | BR-CMP-001; tightened by M5-S1 |
| `audience_json` | `jsonb NOT NULL DEFAULT '{}'` | BR-CMP-001; resolved by M4-S2 |
| `settings_json` | `jsonb NOT NULL DEFAULT '{}'` | BR-CMP-001 (cc, bcc, tracking) |
| `updated_by` | `uuid REFERENCES app_user(id)` | audit |
| `deleted_at` | `timestamptz` | soft delete, matching the recipient/template precedent |

Constraints and objects added by 017:

- `campaign_name_not_blank`: `CHECK (length(btrim(name)) > 0)` — BR-CMP-012 at the database.
- `campaign_status_known`: **originally** `CHECK (status IN ('draft','scheduled','sending','completed','cancelled','failed'))` — 6 values, only the ones this slice itself writes. **Corrected by forward migration `018_campaign_status_values.sql`** (EXECPLAN D-41) to the full 10-value domain BR-SEND-001 actually defines: `'draft','scheduled','queued','validating','sending','paused','completed','partial_failed','failed','cancelled'`. The gap surfaced as a full-workspace regression in a sibling M2 test, not inside this slice — write the complete state machine from the rule text the first time, not just this slice's own writes.
- `idx_campaign_drafts`: `(tenant_id, status, updated_at DESC) WHERE deleted_at IS NULL`.
- Trigger `campaign_no_edit_after_send`: `BEFORE UPDATE`, raises when
  `OLD.status IN ('sending','completed')` and any of
  `subject/template_id/template_version_id/sender_json/audience_json/settings_json/name`
  changed. Status and progress-related updates stay legal, so M5/M6 are not blocked.

RLS: `campaign` already has `campaign_tenant_isolation` from `012_rls.sql`; 017 adds no
table, so no new policy is needed. This is asserted, not assumed, by an integration test.

### Draft request/response shape

```
CampaignDraft {
  id, name, subject,
  templateId | null, templateVersionId | null,
  sender:   { senderConfigId?: uuid|null, fromName?: string, fromEmail?: string },
  audience: { listIds?: uuid[], tagIds?: uuid[], recipientIds?: uuid[],
              excludeListIds?: uuid[], excludeTagIds?: uuid[] },
  settings: { cc?: string[], bcc?: string[] },
  status, version, completeness, createdAt, updatedAt
}
```

`sender` and `audience` are validated as *definitions* only: shape and uuid format, never
existence. Resolution is M4-S2/M5-S1. Recording that boundary here is what stops this node
from silently claiming BR-CMP-002/003.

### Completeness (the "real completeness" the drafts list shows)

Five equally weighted components of send-readiness, 20 points each, deterministic and pure:

1. `name` non-blank, 2. `subject` non-blank, 3. `templateVersionId` set,
4. sender resolved (`senderConfigId` or `fromEmail`), 5. audience non-empty
(at least one of `listIds`, `tagIds`, `recipientIds`).

Defined once in `campaign-completeness.ts` and unit-tested; the web client re-derives
nothing — it renders the server's number, so the list and the API can never disagree.

### HTTP concurrency semantics

| Situation | Status | Reason |
|-----------|--------|--------|
| `If-Match` absent on PATCH/DELETE | **428** | never allow an accidental last-writer-wins |
| `If-Match` present but stale | **412** | BR-CMP-001: block overwriting a newer session |
| Campaign is `sending`/`completed` | **409** | BR-CMP-011's literal acceptance ("PUT trả 409") |
| Campaign not found / other tenant | **404** | cross-tenant existence must not leak |

Order of checks: 428 → 404 → 409 → 412. `ETag` is the campaign's `version` as a strong tag.
`version` is bumped inside the same conditional `UPDATE ... WHERE version = :expected`, so
the check and the write cannot interleave.

---

## 5. Checkpointed TDD implementation plan

### Checkpoint 0 — intake, node start, run-artifact repair

- Flip `M4-S1-campaign-draft` to `running` in `state.json`; write this plan.
- **Repair**: `screen-catalog.yaml` has not parsed as YAML since the M3-GATE commit — an
  unescaped apostrophe in the single-quoted `UI-TPL-001.diff_notes` scalar terminates the
  string early. Fix the quoting.
- **Extend the safety net** (AGENTS.md §5): `validate_plan.py` reads
  `traceability-plan.yaml` and `ui-inventory.yaml` but never parsed `screen-catalog.yaml`,
  which is exactly why the break survived a passing gate. Add a parse + shape check for it.
- Capture the pre-node baseline: workspace test/skip counts, OpenAPI copy, migration list.

### Checkpoint 1 — migration 017 and entity

Write `017_campaign_drafts.sql`, apply forward against real PostgreSQL, re-run to prove
idempotence, then prove the two database-level guards by direct SQL: a blank name is
rejected, and an `UPDATE` of `subject` on a `sending` row raises.

### Checkpoint 2 — pure units, RED first

`campaign-completeness.test.ts`: every component individually, ordering-independence, the
empty draft (name-only, 20) and the complete draft (100). Watch RED (module not found)
before writing the module.

### Checkpoint 3 — draft API, RED first

`campaign-drafts.test.ts` (service, real PostgreSQL) then `campaign-draft-http.test.ts`
(real Nest stack, supertest) covering A1-A10. Then implement repository → service →
controller. Audit actions: `campaign.draft_created`, `campaign.draft_updated`,
`campaign.duplicated`, `campaign.draft_deleted`, each carrying the campaign name (A9).

### Checkpoint 4 — OpenAPI and generated contracts

Add `listCampaigns`, `getCampaign`, `updateCampaignDraft`, `deleteCampaignDraft`,
`duplicateCampaign`; give the already-declared `createCampaignDraft` a real request and
response. Prove additive-only with `scripts/openapi-compat-check.mjs` against a pre-edit
copy, bundle with redocly, regenerate `packages/contracts`.

### Checkpoint 5 — web

`DraftsScreen` ports the handoff's `Drafts` DOM verbatim (`module-card drafts-card`,
`draft-summary`, `draft-list`, `draft-progress`, `row-menu`) with real data, and adds the
four states the handoff lacks. `ComposeDraftScreen` ports the handoff's `Composer`
`compose-grid`/`compose-card`/`compose-fields` DOM, keeps M3-S2's variable panel, and
autosaves.

**Recorded handoff gap:** the handoff's compose form has no campaign-name field
(`Cấu hình gửi`, `Người nhận`, `CC`, `BCC`, `Tiêu đề` only), but BR-CMP-012 makes an
internal name mandatory. Added using the handoff's own `Field` vocabulary (`label.field >
span + input`) rather than inventing a control, and recorded in `screen-catalog.yaml`
`diff_notes` as an addition required by an accepted business rule — not a redesign.

### Checkpoint 6 — traceability and catalogue

Close the three rules; update both screen entries; add progress, surprises and decisions to
EXECPLAN §18-20.

### Checkpoint 7 — verification and node close

Workspace `typecheck`/`test`/`build` with test **and skip** counts compared against the M3
baseline; Playwright e2e + axe; visual capture at 1440x900 / 768x1024 / 390x844;
`docker compose --env-file .env config --quiet`; migrations re-applied twice; then write
node evidence and flip to `completed`.

---

## 6. Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| Autosave races produce a 412 storm in the UI | The client serialises saves: one in-flight PATCH at a time, next save queued with the version returned by the previous response. Unit-tested as a pure reducer, not only observed in a browser. |
| Scope creep into audience resolution | `audience_json` is validated for shape only; no repository join to lists/tags exists in this node. |
| The mock progress/send handlers start looking real | They are untouched, and the node's evidence states so explicitly. |
| `emitDecoratorMetadata` gap under `tsx watch` (D-22) | Live verification uses the compiled `dist/main.js`, per DEC-022. |
| A new jsonb column and `QueryDeepPartialEntity` | Already burned in `arch_contracts`; typecheck with `tsc --noEmit`, not only the looser vitest transform. |

---

## 7. Commit checkpoints

One commit per checkpoint, subject naming the node, body recording the workspace check's
test and skip count, per AGENTS.md §2.

---

## Appendix A — exact mechanics

Written for an executing agent starting cold. Nothing here overrides §1-§7; it removes the
need to re-derive commands, shapes and numbers that are already known.

### A.1 Measured baseline (2026-08-13, HEAD `d14d75f`, before any M4-S1 code)

| Check | Result |
|-------|--------|
| `pnpm -r typecheck` | 6/6 workspaces clean |
| `pnpm -r --workspace-concurrency=1 test` | **71 files / 321 tests / 0 skipped / 0 failed** across 6 workspaces; `apps/api` alone is **38 files / 248 tests** |

**Known intermittent — read before you debug it.** The first run of the baseline failed with
`test/integration/boot.test.ts > ... names DATABASE_URL when it is missing` timing out after
30s; the immediate re-run of the whole workspace was green, and the file alone passes both its
cases in ~9s. The test spawns the compiled `apps/api/dist/main.js` as a real child process, and
under full-suite CPU contention the spawn can take longer than its own 30s budget — the file's
own comment already records that 10s had to be raised to 30s for exactly this reason. It is a
harness starvation problem, not a product defect: nothing about fail-fast env validation is
broken. If it fires during your run, re-run before investigating. If it fires repeatedly, fix
it properly (raise the budget, or take the file out of file-parallelism) and record which you
chose — do not close the node on a suite you had to run twice to see green.

### A.2 Commands

```bash
# migrations, forward apply then idempotent re-run (run twice, expect "already applied")
docker compose --env-file .env run --rm migrate

# api suite only, while iterating
pnpm --filter @eow/api exec vitest run test/integration/campaign-drafts.test.ts

# type errors the vitest transform hides (jsonb columns, decorator metadata)
pnpm --filter @eow/api exec tsc --noEmit

# workspace verification
pnpm -r typecheck; pnpm -r --workspace-concurrency=1 test; pnpm -r build

# OpenAPI: additive-only proof against the pre-edit copy you saved first
node scripts/openapi-compat-check.mjs <before-copy>.yaml contracts/openapi.yaml
pnpm contracts:generate

# browser-level: e2e, a11y and the 3-viewport visual capture
pnpm --filter @eow/web e2e

# demo accounts the e2e specs sign in as (admin + viewer, same tenant)
node apps/api/scripts/seed-demo-user.mjs

# run-artifact validation
python .agents/runs/2026-08-10-eow-master-execplan/validate_plan.py

# deployment contract
docker compose --env-file .env config --quiet
```

Live browser verification must run against the **tsc-compiled** `dist/main.js`, never
`tsx watch` (D-22/DEC-022): `pnpm --filter @eow/api build && node apps/api/dist/main.js`.

### A.3 HTTP surface, exactly

All six operations live on the existing `@Controller('campaigns')`, beside the untouched mock
`progress`/`schedule`/`send`/`cancel` handlers. Permission is `content:manage` throughout —
drafts are content, and BR-AUTH-003 gives a Viewer history and reports only, not drafts.

| Method | Path | operationId | CSRF | Success | Error responses |
|--------|------|-------------|------|---------|-----------------|
| GET | `/campaigns` | `listCampaigns` | no | 200 `CampaignListResponse` | 403 |
| POST | `/campaigns` | `createCampaignDraft` | yes | 201 `Campaign` + `ETag` | 400, 403, 422 |
| GET | `/campaigns/{campaignId}` | `getCampaign` | no | 200 `Campaign` + `ETag` | 403, 404 |
| PATCH | `/campaigns/{campaignId}` | `updateCampaignDraft` | yes | 200 `Campaign` + `ETag` | 400, 403, 404, 409, 412, 428 |
| DELETE | `/campaigns/{campaignId}` | `deleteCampaignDraft` | yes | 204 | 403, 404, 409, 428 |
| POST | `/campaigns/{campaignId}/duplicate` | `duplicateCampaign` | yes | 201 `Campaign` + `ETag` | 403, 404 |

`createCampaignDraft` is already declared in `contracts/openapi.yaml` with only a description
and a 403; giving it a request body, a response schema and more error responses is additive.
Follow the `/templates` block's existing flow-style YAML rather than reformatting the file.

### A.4 Request validation, exactly

`apps/api/src/campaigns/dto/campaign.dto.ts`, in the style of `templates/dto/template.dto.ts`
(`.strict()` everywhere, `ZodValidationPipe` in the controller):

```ts
const campaignName = z.string().trim().min(1).max(200);   // BR-CMP-012
const subject      = z.string().trim().max(998);
const id           = z.string().uuid();

const senderSchema = z.object({
  senderConfigId: id.nullable().optional(),
  fromName:  z.string().trim().max(160).optional(),
  fromEmail: z.string().trim().email().max(320).optional(),
}).strict();

const audienceSchema = z.object({
  listIds:        z.array(id).max(200).optional(),
  tagIds:         z.array(id).max(200).optional(),
  recipientIds:   z.array(id).max(5000).optional(),
  excludeListIds: z.array(id).max(200).optional(),
  excludeTagIds:  z.array(id).max(200).optional(),
}).strict();

const settingsSchema = z.object({
  cc:  z.array(z.string().email()).max(50).optional(),
  bcc: z.array(z.string().email()).max(50).optional(),
}).strict();
```

`createCampaignDraftSchema` requires `name` and defaults everything else;
`updateCampaignDraftSchema` makes every field optional and `.refine()`s that at least one is
present. **Shape only** — these schemas must not check that a list, tag, recipient or sender
actually exists. That resolution is M4-S2/M5-S1, and validating existence here would quietly
claim BR-CMP-002/003.

### A.5 Migration 017 shape

`campaign` already carries `id, tenant_id, name, status, scheduled_at_utc, scheduled_timezone,
version bigint, created_by, created_at, updated_at` from the **published** `001_initial.sql`,
which is never edited. `011_app_role.sql` already grants `eow_app` SELECT/INSERT/UPDATE/DELETE
on `campaign`, and `012_rls.sql` already installs `campaign_tenant_isolation` — added columns
inherit both, so 017 needs no new GRANT and no new policy. Assert that in a test rather than
assuming it.

Every added column needs a `DEFAULT`: the running compose stack serves older code against this
same database (see A.6).

The edit-after-send guard follows `015_template_versions.sql`'s trigger style
(`CREATE OR REPLACE FUNCTION ... LANGUAGE plpgsql ... RAISE EXCEPTION ... USING ERRCODE`), but
unlike that unconditional one it must fire only when a content column actually changed while
`OLD.status IN ('sending','completed')` — status and progress updates have to stay legal or
M5/M6 cannot advance a campaign at all.

### A.6 Shared-database caution

The compose stack for this checkout is running: postgres `127.0.0.1:55432`, redis
`127.0.0.1:56379`, mailpit `8025`, plus live `api`/`web`/`worker`/`scheduler` containers built
from an earlier commit. Your migration lands on the database those containers use. Additive
columns with defaults keep them working; a `NOT NULL` column without a default, or a renamed
column, would not. State in your evidence that you checked this.

### A.7 Visual evidence convention

Extend `apps/web/e2e/visual-capture.spec.ts` with an M4-S1 block, following the M2/M3 blocks
already there, and write PNGs to
`.agents/runs/2026-08-10-eow-master-execplan/evidence/visual/M4-S1-campaign-draft/production/`
at 1440x900, 768x1024 and 390x844. There is no handoff baseline for `loading`, `empty`,
`error` or `permission_denied` — the handoff has none of those states (recorded by `ui_intake`)
— so those are production-only captures, exactly as M1-S2 and M2-S1 did it. Look at, and say
you looked at, the images; a saved file is not evidence that the state rendered.

---

## Appendix B — checkpoint 5-7 plan review (2026-08-13, after checkpoint 4 closed)

A deliberate pass over what checkpoints 5-7 will actually collide with, done in the same
spirit that found D-41: check the plan against the real code and the real handoff, not against
its own prose. Six findings. B.2 is a backend correction; B.4 and B.5 are decisions that must
be recorded, not quietly resolved either way.

### B.1 The existing web API-client helper discards response headers

`apps/web/src/api/templates.ts`'s `request<T>()` returns `response.json()` and drops the
`Response` object, so **copying it verbatim gives you no way to read the `ETag` header.** Do not
work around this by rewriting the shared helper for one screen.

You do not need the header: every `Campaign` response body already carries `version`, and the
API accepts a bare number as well as a quoted tag (`/^"?(\d+)"?$/`). Derive `If-Match` from the
last response body's `version`. The `ETag` header stays correct and useful for HTTP caches and
for the HTTP-level tests, but the browser client should not depend on reading it.

`csrfHeaders()` in the same file **is** the right thing to copy — every mutation needs it.

### B.2 `listDrafts()` is unbounded and does not filter by status — fix it in checkpoint 5

`apps/api/src/campaigns/campaigns.repository.ts`'s `listDrafts()` selects every non-deleted
campaign for the tenant with no `limit` and no `status` predicate. Two real problems:

1. **Unbounded.** Every other list in this repo caps (`templates`: `limit` default 50, max 100).
   A tenant with thousands of campaigns returns all of them in one response.
2. **Wrong rows.** It returns `sending`, `completed` and `cancelled` campaigns too, but the
   screen it feeds is the handoff's **"Bản nháp"** tab — "Bản nháp đang lưu". A completed
   campaign appearing in the drafts list is a correctness bug, not a cosmetic one. Note that
   migration 017's `idx_campaign_drafts` index is `(tenant_id, status, updated_at DESC)` — it was
   designed for exactly the status predicate the query never uses.

Add a `campaignListQuerySchema` (`status?`, `limit` default 50 max 100) matching
`templateListQuerySchema`, filter to `status = 'draft'` by default, add the query parameters to
`listCampaigns` in `contracts/openapi.yaml` (additive), and cover both with a test. This is
backend work inside checkpoint 5 — do not defer it to M4-S2.

### B.3 The handoff's drafts search box has no backend

The handoff's `Drafts` renders `<SearchBox placeholder="Tìm theo tiêu đề, template hoặc người
nhận"/>`, but `listCampaigns` takes no `search` parameter. Given B.2 caps the list at a page,
**filter client-side over the loaded page** and say so in `screen-catalog.yaml` `diff_notes`.
Adding a server-side search parameter is also acceptable if you cover it with a test — but pick
one and record it. What is not acceptable is rendering the handoff's search input and wiring it
to nothing.

### B.4 DECISION REQUIRED — `draftActions` has four buttons and one has no API

The handoff's `draftActions` overlay (`action-overlays.tsx` L156-158) offers: **Nhân bản**,
**Đổi tên**, **Xuất file HTML**, **Xóa bản nháp**.

Three map onto real endpoints built in checkpoint 3: duplicate → `duplicateCampaign`, rename →
`updateCampaignDraft` with `name`, delete → `deleteCampaignDraft`. **"Xuất file HTML" has no
endpoint and no owning rule.** `catalog/ba-rules.json` does contain export rules — `BR-REC-009`
(bulk recipient export), `BR-HIS-003` (download the error list), `BR-HIS-007` (export
history/audience without secrets, respecting field-level permission), `BR-CF-006` (per-row error
file) — but every one of them is about recipients, history or job output. None covers exporting a
campaign *draft* as an HTML file, and none is allocated to M4 in `traceability-plan.yaml`.

Recommended: **omit that one button**, and record the omission the way DEC-052 recorded
`templatePicker`/`templateDetail`/`templateFilter` — a named reason in EXECPLAN §20, not a
silent absence. Shipping a fourth button that toasts "coming soon", or that serialises whatever
HTML happens to be in the draft, is the M3-GATE failure mode in reverse: UI theatre standing in
for substance. Do not invent an export endpoint here either; that is new scope no rule asked for.

### B.5 DECISION REQUIRED — `draftSaved` is a modal, but this slice's save model is autosave

The handoff's `draftSaved` overlay is a full success modal ("Đã lưu vào Bản nháp"). The
handoff's own compose screen also shows an inline `Tự động lưu · vừa xong` in the editor head
and `Đã tự động lưu` in the utility bar. **Firing a modal on every debounced autosave would be
absurd**, and there is no explicit "save" control in the handoff's compose form to hang it on.

Recommended: **do not build `draftSaved` in this slice.** The inline save-state is the real,
ported surface for BR-CMP-001's autosave; the modal belongs to an explicit save/exit action that
this slice does not have. Record it as a numbered decision with that reason. If you disagree and
build it, it must be triggered by a real user action, never by the autosave timer.

### B.6 The shell's save-state indicator is hardcoded

`apps/web/src/app/AppShell.tsx` L129-131 renders `<span className="save-state">` with a literal
`Đã đồng bộ`. The handoff drives that text from the current view (`Đã tự động lưu` on compose,
`Đã đồng bộ` elsewhere — `app/page.tsx` L285). Making it real means the compose screen's autosave
state has to reach the shell, which sits above it in the route tree.

Keep this simple and typed — a small context provider, or lifting save-state into the shell and
passing a setter through `Outlet` context. Do not reach for global mutable state or a store
library for one string. Whatever you choose, the indicator must reflect **real** save status
(idle / saving / saved / conflict), because BR-CMP-001's acceptance is precisely "autosave does
not lose data" and this is the only place a user sees that promise being kept.

### B.7 Confirmed correct, no action needed

- `traceability.csv`'s columns are `rule_id,priority,milestone,slice,acceptance_summary,`
  `openapi_operation_ids,asyncapi_channels,migration_files,code_paths,test_case_ids,test_files,`
  `log_or_metric_or_audit,deploy_case_ids,status`. `BR-CMP-001/011/012` are present, `not_started`,
  already carrying `TC-CMP-001/011/012`. Fill `slice=M4-S1` plus the real columns.
- `apps/web/e2e/visual-capture.spec.ts` already has an M3-S1 block (L560+) using `page.route`
  interception for loading/empty/error states — copy that shape rather than inventing one.
- `apps/web/src/overlays/` uses a flat `XxxOverlay.tsx` naming convention; `DraftActionsOverlay.tsx`
  fits it.
- Each e2e spec defines its own local `signIn` helper rather than sharing one. Follow the local
  convention; consolidating them is not this node's job.
