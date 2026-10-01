# Campaigns Section Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `Email` and `Lịch sử gửi` sidebar entries with a single `Chiến dịch` section at `/campaigns` — one list covering every campaign status with multi-select bulk actions, and per-campaign send history at `/campaigns/:id` — per `docs/superpowers/specs/2026-08-25-campaigns-section-restructure-design.md`.

**Architecture:** The backend already stores one campaign entity split across two list queries (`status = 'draft'` vs `status <> 'draft'`). Tasks 1–3 make the existing history query able to return both, gated on permission and ownership. Tasks 5–8 add a synchronous `POST /campaigns/bulk` that processes each campaign in its own transaction and reports per-row outcomes. Tasks 9–14 extract the web logic into pure, unit-tested modules (this codebase has no React component-testing library — component wiring is verified by typecheck, `ARCH-NO-ORPHANS` and a manual browser pass). Tasks 15–23 rewire routing and screens on top of those units.

**Tech Stack:** NestJS + TypeORM + raw SQL (api), Zod DTOs, React + react-router-dom (web), Vitest for unit tests, Playwright for e2e.

---

## Investigation notes (read before starting)

1. **`cancel` is three different service methods, not one.** `campaigns.service.ts` has `cancelCampaignSchedule` (status `scheduled`), `cancelCampaign` (status `queued`) and `cancelCampaignSend` (status `sending`). The bulk `cancel` action must dispatch by the campaign's current status. `cancelCampaignSend` also requires an idempotency key — the bulk service generates one per campaign with `randomUUID()`, which is correct because each row is a distinct operation.

2. **`deleteDraft` takes an `expectedVersion` and throws 412.** Bulk cannot carry N versions, so the bulk path reads the version inside its own transaction and passes it through. The 412 path still exists for a row whose version moved between the list render and the transaction — that becomes `outcome: 'failed'`, `code: 'CAMPAIGN_VERSION_CONFLICT'`.

3. **`historyListQuerySchema` deliberately rejects `status: 'draft'`** (`history-query.test.ts:37`). That test stays true for the default path; the new `includeDrafts` flag is what widens the status vocabulary, so the enum gains `draft` and the existing test is updated to assert the flag-gated behaviour rather than deleted.

4. **`assertDraftAccess` / `canManageAllDrafts` already encode the ownership rule** (`campaigns.service.ts:468-475`): admin **with `settings:manage`** sees all drafts, everyone else only their own. The SQL predicate in Task 2 must match that exact rule, not a looser "role === admin".

5. **`.recipient-bulk-bar` and the `is-selected` row class already exist** and are used by `RecipientsScreen.tsx:431,479`. Task 20 generalises the class name rather than adding a campaign-specific copy.

## File structure

**Create (api)**
- `apps/api/src/campaigns/dto/bulk.dto.ts` — Zod schema + types for the bulk request
- `apps/api/src/campaigns/campaign-bulk.ts` — pure per-action precondition logic
- `apps/api/src/campaigns/campaign-bulk.test.ts`
- `docs/adr/adr-034-campaign-list-draft-visibility.md`

**Create (web)**
- `apps/web/src/app/page-meta.ts` + `page-meta.test.ts`
- `apps/web/src/screens/campaigns/campaign-row-target.ts` + `.test.ts`
- `apps/web/src/screens/campaigns/campaign-selection.ts` + `.test.ts`
- `apps/web/src/screens/campaigns/bulk-outcome.ts` + `.test.ts`
- `apps/web/src/screens/campaigns/active-filters.ts` + `.test.ts`
- `apps/web/src/app/LegacyRedirects.tsx`

**Move**
- `apps/web/src/screens/history/*` → `apps/web/src/screens/campaigns/*`
- `HistoryScreen.tsx` → `CampaignListScreen.tsx` (renamed in Task 2, grown into the campaign list in Task 19)
- `CampaignProgressDrawer.tsx` → `CampaignDetailScreen.tsx`
- `apps/web/src/api/history.ts` → `apps/web/src/api/campaign-list.ts`

**Delete**
- `apps/web/src/screens/drafts/DraftsScreen.tsx`

**Modify** — `history-query.ts`, `dto/history.dto.ts`, `campaigns.service.ts`, `campaigns.controller.ts`, `contracts/openapi.yaml`, `nav.ts`, `AppRoutes.tsx`, `AppShell.tsx`, `ComposeDraftScreen.tsx`, `HistoryFilterDialog.tsx`, `globals.css`, `auth.spec.ts`, `rbac.spec.ts`, `visual-capture.spec.ts`.

⚠️ `packages/architecture-tests` (`ARCH-NO-ORPHANS`) requires every production web module to be reachable from `apps/web/src/main.tsx`. All new web modules are imported by screens that are themselves routed, so they are reachable — but re-run that test after Task 21.

⚠️ **The build stays green between every task.** Task 2 renames the history screens in place and repoints the existing `/history` routes at the renamed components, so nothing is deleted before its replacement exists. A task that leaves `pnpm --filter @eow/web typecheck` failing is an execution mistake, not an expected intermediate state — the single documented exception is Task 16, which Task 17 completes.

---

## Phase 1 — Foundations: ADR, directory move, client rename

### Task 1: ADR-034

**Files:**
- Create: `docs/adr/adr-034-campaign-list-draft-visibility.md`

- [ ] **Step 1: Write the ADR**

```markdown
# ADR-034: Draft visibility on the campaign list endpoint

## Status
Accepted (2026-08-25)

## Context
`GET /campaigns/history` was built as a send-history feed and hardcoded
`campaign.status <> 'draft'`. The Chiến dịch restructure replaces the two
separate sidebar destinations (drafts list, send history) with one campaign
list, so a single endpoint must serve every status. `GET /campaigns` cannot
take that role: it is guarded by CONTENT_MANAGE, which viewers do not hold,
and it has no keyset pagination.

## Decision
`GET /campaigns/history` accepts `includeDrafts` (default `false`) and
`scope`. Draft rows are returned only when the caller holds `content:manage`;
a caller without it is silently downgraded to the previous non-draft result
rather than refused, because a 403 would blank a list the caller is otherwise
entitled to read. A caller who is not an admin with `settings:manage` sees
only drafts they created — the SQL predicate mirrors
`CampaignsService.assertDraftAccess` exactly, so the list can never surface a
draft that a direct `GET /campaigns/:id` would refuse.

The endpoint keeps its URL. Renaming it to `/campaigns/list` would break the
published contract for no user-visible gain; the concept is renamed on the
web client instead (`api/history.ts` → `api/campaign-list.ts`).

## Consequences
- The endpoint's audience widens from "send history" to "all campaigns".
- No existing caller's results change: `includeDrafts` defaults to `false`.
- Draft visibility now has two enforcement points (the direct route and this
  list query) that must stay in agreement; `history-query.test.ts` pins the
  list side against the same rule the service applies.
```

- [ ] **Step 2: Commit**

```bash
git add docs/adr/adr-034-campaign-list-draft-visibility.md
git commit -m "docs(adr): record campaign-list draft visibility"
```

---

### Task 2: rename the history screens into `screens/campaigns`

**Files:**
- Move: `apps/web/src/screens/history/*` → `apps/web/src/screens/campaigns/*`
- Modify: `apps/web/src/app/AppRoutes.tsx`, `apps/web/src/screens/compose/ComposeDraftScreen.tsx`

A pure rename: same URLs, same behaviour, same tests, same test count. Running it first means every later task writes into a directory that already exists, and means no screen is ever deleted before its replacement is built.

- [ ] **Step 1: Move the files**

```bash
mkdir -p apps/web/src/screens/campaigns
git mv apps/web/src/screens/history/HistoryScreen.tsx apps/web/src/screens/campaigns/CampaignListScreen.tsx
git mv apps/web/src/screens/history/CampaignProgressDrawer.tsx apps/web/src/screens/campaigns/CampaignDetailScreen.tsx
git mv apps/web/src/screens/history/HistoryFilterDialog.tsx apps/web/src/screens/campaigns/HistoryFilterDialog.tsx
git mv apps/web/src/screens/history/ResendConfirmDialog.tsx apps/web/src/screens/campaigns/ResendConfirmDialog.tsx
git mv apps/web/src/screens/history/campaign-realtime.ts apps/web/src/screens/campaigns/campaign-realtime.ts
git mv apps/web/src/screens/history/campaign-realtime.test.ts apps/web/src/screens/campaigns/campaign-realtime.test.ts
git mv apps/web/src/screens/history/eta-format.ts apps/web/src/screens/campaigns/eta-format.ts
git mv apps/web/src/screens/history/eta-format.test.ts apps/web/src/screens/campaigns/eta-format.test.ts
git mv apps/web/src/screens/history/history-countdown.ts apps/web/src/screens/campaigns/history-countdown.ts
git mv apps/web/src/screens/history/history-countdown.test.ts apps/web/src/screens/campaigns/history-countdown.test.ts
git mv apps/web/src/screens/history/recipient-delivery.ts apps/web/src/screens/campaigns/recipient-delivery.ts
git mv apps/web/src/screens/history/recipient-delivery.test.ts apps/web/src/screens/campaigns/recipient-delivery.test.ts
```

`HistoryScreen.tsx` is **renamed, not deleted** — Task 19 grows it into the campaign list in place, so there is no point at which the app has no list screen and no deleted file to recover from git history.

- [ ] **Step 2: Rename the two exported components**

In `CampaignListScreen.tsx`: `export function HistoryScreen()` → `export function CampaignListScreen()`.

In `CampaignDetailScreen.tsx`: `export function CampaignProgressDrawer()` → `export function CampaignDetailScreen()`.

Change nothing else in either file. The back link, the draft redirect and the screen's data source all depend on routes that do not exist yet; they land in Tasks 17 and 19.

- [ ] **Step 3: Repoint the importers**

```bash
grep -rn "screens/history\|\.\./history/" apps/web/src apps/web/e2e
```

`AppRoutes.tsx` imports both screens by their old names and paths; `ComposeDraftScreen.tsx` imports `../history/campaign-realtime.js`. Update each to the new path and name. **Leave the `/history` and `/history/:campaignId` route URLs exactly as they are** — Task 17 changes the URLs.

Expected after fixing: no hits.

- [ ] **Step 4: Verify nothing changed behaviourally**

```bash
pnpm --filter @eow/web exec vitest run src/screens/campaigns
pnpm --filter @eow/web typecheck
```

Expected: PASS, with the same test count the `src/screens/history` suites reported before the move. A different count means a test file was left behind.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src
git commit -m "refactor(web): rename the history screens under screens/campaigns"
```

---

### Task 3: web API client — rename and extend

**Files:**
- Move: `apps/web/src/api/history.ts` → `apps/web/src/api/campaign-list.ts`
- Modify: every importer of `../../api/history.js`

- [ ] **Step 1: Move the file**

```bash
git mv apps/web/src/api/history.ts apps/web/src/api/campaign-list.ts
```

- [ ] **Step 2: Extend the query type and fetch function**

In `apps/web/src/api/campaign-list.ts`, add to `CampaignHistoryQuery`:

```ts
  /** ADR-034: ask for draft rows too; the server still gates them on permission and ownership. */
  includeDrafts?: boolean;
  scope?: 'mine' | 'all';
```

and inside `fetchCampaignHistory`, before `const suffix`:

```ts
  if (query.includeDrafts) params.set('includeDrafts', 'true');
  if (query.scope) params.set('scope', query.scope);
```

- [ ] **Step 3: Add the bulk client**

Append to the same file:

```ts
export type CampaignBulkAction = 'delete' | 'duplicate' | 'cancel';
export type CampaignBulkResult = { campaignId: string; outcome: 'succeeded' | 'failed' | 'skipped'; code: string; message: string };
export type CampaignBulkResponse = { results: CampaignBulkResult[]; succeeded: number; failed: number; skipped: number };

export function bulkCampaignAction(action: CampaignBulkAction, campaignIds: string[]): Promise<CampaignBulkResponse> {
  return request('/campaigns/bulk', { method: 'POST', headers: csrfHeaders(), body: JSON.stringify({ action, campaignIds }) });
}
```

- [ ] **Step 4: Fix the importers**

```bash
grep -rln "api/history.js" apps/web/src
```

Update each hit to `api/campaign-list.js`. At the time of writing these are `HistoryScreen.tsx`, `CampaignProgressDrawer.tsx`, `HistoryFilterDialog.tsx` and `ResendConfirmDialog.tsx`.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm --filter @eow/web typecheck
git add apps/web/src
git commit -m "refactor(web): rename the history client to campaign-list and add bulk"
```

---

## Phase 2 — Backend: unified campaign list

### Task 4: `includeDrafts` and `scope` on the list query schema

**Files:**
- Modify: `apps/api/src/campaigns/dto/history.dto.ts:15-24`
- Test: `apps/api/src/campaigns/history-query.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to the `historyListQuerySchema` describe block in `apps/api/src/campaigns/history-query.test.ts`, and replace the existing `'rejects a status outside the send-history vocabulary'` test with these three:

```ts
  it('defaults includeDrafts to false so existing callers are unchanged', () => {
    expect(historyListQuerySchema.parse({})).toEqual({ limit: 25, includeDrafts: false });
  });

  it('accepts includeDrafts and scope for the campaign list surface', () => {
    const parsed = historyListQuerySchema.parse({ includeDrafts: 'true', scope: 'mine' });
    expect(parsed.includeDrafts).toBe(true);
    expect(parsed.scope).toBe('mine');
  });

  it('accepts status=draft (the campaign list can filter to drafts)', () => {
    expect(historyListQuerySchema.parse({ status: 'draft' }).status).toBe('draft');
  });

  it('rejects a status outside the campaign vocabulary', () => {
    expect(() => historyListQuerySchema.parse({ status: 'archived' })).toThrow();
  });

  it('rejects an unknown scope', () => {
    expect(() => historyListQuerySchema.parse({ scope: 'everyone' })).toThrow();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @eow/api exec vitest run src/campaigns/history-query.test.ts
```

Expected: FAIL — `includeDrafts` is an unknown key (the schema is `.strict()`), and `status: 'draft'` is rejected by the enum.

- [ ] **Step 3: Widen the schema**

In `apps/api/src/campaigns/dto/history.dto.ts`, replace the `historyStatuses` const and `historyListQuerySchema` with:

```ts
/**
 * Every campaign status, including 'draft'. The list surface at
 * GET /campaigns/history covers the whole campaign lifecycle since the
 * Chiến dịch restructure (ADR-034); whether draft rows are actually
 * returned is decided by includeDrafts plus the caller's permissions,
 * not by this vocabulary.
 */
const campaignStatuses = [
  'draft', 'scheduled', 'blocked', 'missed', 'queued', 'validating', 'sending', 'paused',
  'completed', 'partial_failed', 'failed', 'cancelled',
] as const;

/**
 * NOT z.coerce.boolean(): that is `Boolean(input)`, and query parameters
 * arrive as strings, so the string 'false' would coerce to TRUE -- turning an
 * explicit opt-out into an opt-in on a permission-bearing flag.
 */
const queryBoolean = z.union([
  z.boolean(),
  z.literal('true').transform(() => true),
  z.literal('false').transform(() => false),
]);

export const historyListQuerySchema = z.object({
  status: z.enum(campaignStatuses).optional(),
  dateFrom: z.string().datetime({ offset: true }).optional(),
  dateTo: z.string().datetime({ offset: true }).optional(),
  senderConfigId: z.string().uuid().optional(),
  createdBy: z.string().uuid().optional(),
  search: z.string().trim().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
  cursor: z.string().min(1).optional(),
  /** ADR-034. Default false keeps every pre-restructure caller's results identical. */
  includeDrafts: queryBoolean.optional().default(false),
  scope: z.enum(['mine', 'all']).optional(),
}).strict();
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm --filter @eow/api exec vitest run src/campaigns/history-query.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/campaigns/dto/history.dto.ts apps/api/src/campaigns/history-query.test.ts
git commit -m "feat(api): allow includeDrafts and scope on the campaign list query"
```

---

### Task 5: draft-visibility predicate in `buildHistoryListSql`

**Files:**
- Modify: `apps/api/src/campaigns/history-query.ts:46-56`
- Test: `apps/api/src/campaigns/history-query.test.ts`

- [ ] **Step 1: Write the failing tests**

Add a new describe block to `apps/api/src/campaigns/history-query.test.ts`:

```ts
import { buildHistoryListSql } from './history-query.js';

describe('campaign list draft visibility (ADR-034)', () => {
  const parse = (input: Record<string, unknown>) => historyListQuerySchema.parse(input);
  const viewer = { actorId: 'u-1', canManageContent: false, canManageAllDrafts: false };
  const operator = { actorId: 'u-1', canManageContent: true, canManageAllDrafts: false };
  const admin = { actorId: 'u-1', canManageContent: true, canManageAllDrafts: true };

  it('excludes drafts when includeDrafts is not set', () => {
    const built = buildHistoryListSql(parse({}), 'tenant-1', admin);
    expect(built.sql).toContain("campaign.status <> 'draft'");
  });

  it('excludes drafts for a caller without content:manage even when asked', () => {
    const built = buildHistoryListSql(parse({ includeDrafts: 'true' }), 'tenant-1', viewer);
    expect(built.sql).toContain("campaign.status <> 'draft'");
    expect(built.sql).not.toContain('campaign.created_by =');
  });

  it('limits drafts to the caller own rows for a non-admin content manager', () => {
    const built = buildHistoryListSql(parse({ includeDrafts: 'true' }), 'tenant-1', operator);
    expect(built.sql).toContain("(campaign.status <> 'draft' OR campaign.created_by =");
    expect(built.params).toContain('u-1');
  });

  it('applies no draft predicate at all for an admin who manages every draft', () => {
    const built = buildHistoryListSql(parse({ includeDrafts: 'true' }), 'tenant-1', admin);
    expect(built.sql).not.toContain("campaign.status <> 'draft'");
    expect(built.sql).not.toContain('campaign.created_by =');
  });

  it('honours scope=mine for an admin, restricting drafts to their own', () => {
    const built = buildHistoryListSql(parse({ includeDrafts: 'true', scope: 'mine' }), 'tenant-1', admin);
    expect(built.sql).toContain("(campaign.status <> 'draft' OR campaign.created_by =");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @eow/api exec vitest run src/campaigns/history-query.test.ts
```

Expected: FAIL — `buildHistoryListSql` currently takes two arguments and always emits the hardcoded predicate.

- [ ] **Step 3: Implement the predicate**

In `apps/api/src/campaigns/history-query.ts`, add the viewer type above `buildHistoryListSql`:

```ts
/**
 * ADR-034. The SQL-side mirror of CampaignsService.assertDraftAccess:
 * `canManageAllDrafts` is admin-role AND settings:manage, exactly as
 * `canManageAllDrafts()` computes it, so the list can never show a draft
 * a direct GET would refuse.
 */
export type CampaignListViewer = {
  actorId: string | null;
  canManageContent: boolean;
  canManageAllDrafts: boolean;
};
```

Then change the signature and the hardcoded condition:

```ts
export function buildHistoryListSql(query: HistoryListQueryDto, tenantId: string, viewer: CampaignListViewer): HistoryListSql {
  const params: unknown[] = [tenantId];
  const conditions: string[] = [
    'campaign.tenant_id = $1',
    'campaign.deleted_at IS NULL',
  ];

  const draftsVisible = query.includeDrafts && viewer.canManageContent;
  const ownDraftsOnly = draftsVisible && (!viewer.canManageAllDrafts || query.scope === 'mine');
  if (!draftsVisible) {
    conditions.push("campaign.status <> 'draft'");
  } else if (ownDraftsOnly && viewer.actorId) {
    params.push(viewer.actorId);
    conditions.push(`(campaign.status <> 'draft' OR campaign.created_by = $${params.length})`);
  }
```

The rest of the function is unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm --filter @eow/api exec vitest run src/campaigns/history-query.test.ts
```

Expected: PASS, all suites in the file.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/campaigns/history-query.ts apps/api/src/campaigns/history-query.test.ts
git commit -m "feat(api): gate campaign-list draft rows on permission and ownership"
```

---

### Task 6: wire the service, controller and OpenAPI contract

**Files:**
- Modify: `apps/api/src/campaigns/campaigns.service.ts:1157-1160`
- Modify: `apps/api/src/campaigns/campaigns.controller.ts:39-42`
- Modify: `contracts/openapi.yaml:961-969`

- [ ] **Step 1: Pass the viewer through the service**

In `apps/api/src/campaigns/campaigns.service.ts`, change `listHistory` to accept the actor and build the viewer. Replace its first three lines:

```ts
  async listHistory(tenantId: string, query: HistoryListQueryDto, actor: CampaignActor) {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const viewer: CampaignListViewer = {
        actorId: actor.actorId,
        canManageContent: actor.permissions?.includes('content:manage') ?? false,
        canManageAllDrafts: this.canManageAllDrafts(actor),
      };
      const { sql, params } = buildHistoryListSql(query, tenantId, viewer);
```

Add `CampaignListViewer` to the existing `history-query.js` import on line 21.

- [ ] **Step 2: Pass the actor from the controller**

In `apps/api/src/campaigns/campaigns.controller.ts`, the `history` handler becomes:

```ts
  @Get('history') @RequirePermission(PERMISSIONS.CAMPAIGN_READ)
  async history(@Query(new ZodValidationPipe(historyListQuerySchema)) query: HistoryListQueryDto, @Req() req: AuthenticatedRequest) {
    return this.campaigns.listHistory(tenantId(req), query, actor(req));
  }
```

- [ ] **Step 3: Update the contract (additive only)**

In `contracts/openapi.yaml`, add two parameters after the `cursor` line at 969 and widen the `status` enum on line 962:

```yaml
        - {name: status, in: query, schema: {enum: [draft, scheduled, blocked, missed, queued, validating, sending, paused, completed, partial_failed, failed, cancelled]}}
```

```yaml
        - {name: includeDrafts, in: query, schema: {type: boolean, default: false}}
        - {name: scope, in: query, schema: {enum: [mine, all]}}
```

- [ ] **Step 4: Regenerate contracts and verify compatibility**

```bash
pnpm contracts:generate
pnpm contracts:compat-check
```

Expected: compat-check PASSES — both parameters are optional and the enum only grows.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm --filter @eow/api typecheck
git add apps/api/src/campaigns/campaigns.service.ts apps/api/src/campaigns/campaigns.controller.ts contracts/ packages/contracts/
git commit -m "feat(api): serve drafts from the campaign list endpoint"
```

---

## Phase 3 — Backend: bulk actions

### Task 7: bulk request DTO

**Files:**
- Create: `apps/api/src/campaigns/dto/bulk.dto.ts`
- Test: `apps/api/src/campaigns/campaign-bulk.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/campaigns/campaign-bulk.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { campaignBulkSchema } from './dto/bulk.dto.js';

describe('campaignBulkSchema', () => {
  const id = '11111111-1111-4111-8111-111111111111';

  it('accepts a delete request', () => {
    expect(campaignBulkSchema.parse({ action: 'delete', campaignIds: [id] })).toEqual({ action: 'delete', campaignIds: [id] });
  });

  it('rejects an unknown action', () => {
    expect(() => campaignBulkSchema.parse({ action: 'archive', campaignIds: [id] })).toThrow();
  });

  it('rejects an empty selection', () => {
    expect(() => campaignBulkSchema.parse({ action: 'delete', campaignIds: [] })).toThrow();
  });

  it('rejects more than 100 campaigns', () => {
    expect(() => campaignBulkSchema.parse({ action: 'delete', campaignIds: Array(101).fill(id) })).toThrow();
  });

  it('rejects a non-uuid campaign id', () => {
    expect(() => campaignBulkSchema.parse({ action: 'delete', campaignIds: ['nope'] })).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @eow/api exec vitest run src/campaigns/campaign-bulk.test.ts
```

Expected: FAIL — `./dto/bulk.dto.js` does not exist.

- [ ] **Step 3: Create the schema**

Create `apps/api/src/campaigns/dto/bulk.dto.ts`:

```ts
import { z } from 'zod';

/**
 * Synchronous bulk actions for the campaign list. Bounded at 100 because
 * the caller can only select rows it has loaded, and because each row runs
 * its own transaction — an unbounded list would hold a request open for an
 * unbounded time.
 */
export const campaignBulkSchema = z.object({
  action: z.enum(['delete', 'duplicate', 'cancel']),
  campaignIds: z.array(z.string().uuid()).min(1).max(100),
}).strict();
export type CampaignBulkDto = z.infer<typeof campaignBulkSchema>;

export type CampaignBulkOutcome = 'succeeded' | 'failed' | 'skipped';
export type CampaignBulkResult = { campaignId: string; outcome: CampaignBulkOutcome; code: string; message: string };
export type CampaignBulkResponse = {
  results: CampaignBulkResult[];
  succeeded: number;
  failed: number;
  skipped: number;
};
```

- [ ] **Step 4: Run to verify it passes**

```bash
pnpm --filter @eow/api exec vitest run src/campaigns/campaign-bulk.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/campaigns/dto/bulk.dto.ts apps/api/src/campaigns/campaign-bulk.test.ts
git commit -m "feat(api): add the campaign bulk request schema"
```

---

### Task 8: pure precondition logic

**Files:**
- Create: `apps/api/src/campaigns/campaign-bulk.ts`
- Test: `apps/api/src/campaigns/campaign-bulk.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/campaigns/campaign-bulk.test.ts`:

```ts
import { bulkPrecondition, requiredBulkPermission, type CampaignBulkAction } from './campaign-bulk.js';

describe('bulkPrecondition', () => {
  it('allows delete only for drafts', () => {
    expect(bulkPrecondition('delete', 'draft')).toEqual({ allowed: true });
    expect(bulkPrecondition('delete', 'sending')).toEqual({ allowed: false, code: 'CAMPAIGN_NOT_DRAFT', message: 'Only a draft campaign can be deleted.' });
    expect(bulkPrecondition('delete', 'completed')).toEqual({ allowed: false, code: 'CAMPAIGN_NOT_DRAFT', message: 'Only a draft campaign can be deleted.' });
  });

  it('allows cancel from the three in-flight statuses', () => {
    for (const status of ['scheduled', 'queued', 'sending'] as const) {
      expect(bulkPrecondition('cancel', status)).toEqual({ allowed: true });
    }
    expect(bulkPrecondition('cancel', 'draft')).toEqual({ allowed: false, code: 'CAMPAIGN_NOT_CANCELLABLE', message: 'Campaign is not scheduled, queued or sending.' });
    expect(bulkPrecondition('cancel', 'completed')).toEqual({ allowed: false, code: 'CAMPAIGN_NOT_CANCELLABLE', message: 'Campaign is not scheduled, queued or sending.' });
  });

  it('allows duplicate from any status', () => {
    for (const status of ['draft', 'sending', 'completed', 'cancelled'] as const) {
      expect(bulkPrecondition('duplicate', status)).toEqual({ allowed: true });
    }
  });
});

describe('requiredBulkPermission', () => {
  it('maps each action to the permission the single-row route already requires', () => {
    const cases: Array<[CampaignBulkAction, string]> = [
      ['delete', 'content:manage'],
      ['duplicate', 'content:manage'],
      ['cancel', 'campaign:manage'],
    ];
    for (const [action, permission] of cases) expect(requiredBulkPermission(action)).toBe(permission);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @eow/api exec vitest run src/campaigns/campaign-bulk.test.ts
```

Expected: FAIL — `./campaign-bulk.js` does not exist.

- [ ] **Step 3: Implement**

Create `apps/api/src/campaigns/campaign-bulk.ts`:

```ts
import type { CampaignEntity } from '../database/entities/campaign.entity.js';

export type CampaignBulkAction = 'delete' | 'duplicate' | 'cancel';
export type BulkPrecondition = { allowed: true } | { allowed: false; code: string; message: string };

const CANCELLABLE = new Set<CampaignEntity['status']>(['scheduled', 'queued', 'sending']);

/**
 * The state rules the single-row routes already enforce, restated as data so
 * a bulk row can be reported as `skipped` with a reason instead of aborting
 * the whole request. Kept pure and separate from the service so the
 * behaviour is testable without a database.
 */
export function bulkPrecondition(action: CampaignBulkAction, status: CampaignEntity['status']): BulkPrecondition {
  if (action === 'duplicate') return { allowed: true };
  if (action === 'delete') {
    return status === 'draft'
      ? { allowed: true }
      : { allowed: false, code: 'CAMPAIGN_NOT_DRAFT', message: 'Only a draft campaign can be deleted.' };
  }
  return CANCELLABLE.has(status)
    ? { allowed: true }
    : { allowed: false, code: 'CAMPAIGN_NOT_CANCELLABLE', message: 'Campaign is not scheduled, queued or sending.' };
}

/** Permissions differ per action, so the guard cannot be a single route decorator. */
export function requiredBulkPermission(action: CampaignBulkAction): string {
  return action === 'cancel' ? 'campaign:manage' : 'content:manage';
}
```

If the entity's status union is not exported from that path, import the status type from `./campaigns.types.js` instead and adjust the two annotations — do not widen them to `string`.

- [ ] **Step 4: Run to verify it passes**

```bash
pnpm --filter @eow/api exec vitest run src/campaigns/campaign-bulk.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/campaigns/campaign-bulk.ts apps/api/src/campaigns/campaign-bulk.test.ts
git commit -m "feat(api): add pure precondition rules for campaign bulk actions"
```

---

### Task 9: bulk service method

**Files:**
- Modify: `apps/api/src/campaigns/campaigns.service.ts`

- [ ] **Step 1: Add the method**

Add to `CampaignsService`, next to `duplicateDraft`:

```ts
  /**
   * Synchronous bulk action for the campaign list. Each campaign is applied
   * independently: a precondition failure is reported as `skipped` and an
   * error as `failed`, and neither stops the remaining rows. There is no
   * If-Match — N versions cannot travel in one request — so the version is
   * read inside each row's own transaction and a moved version surfaces as
   * CAMPAIGN_VERSION_CONFLICT (see ADR-034's sibling note in the spec).
   */
  async bulkAction(tenantId: string, body: CampaignBulkDto, actor: CampaignActor): Promise<CampaignBulkResponse> {
    const permission = requiredBulkPermission(body.action);
    if (!actor.permissions?.includes(permission)) {
      throw new ForbiddenException({ code: 'PERMISSION_REQUIRED', message: `This action requires ${permission}.` });
    }

    const results: CampaignBulkResult[] = [];
    for (const campaignId of body.campaignIds) {
      results.push(await this.runBulkRow(tenantId, body.action, campaignId, actor));
    }

    return {
      results,
      succeeded: results.filter((row) => row.outcome === 'succeeded').length,
      failed: results.filter((row) => row.outcome === 'failed').length,
      skipped: results.filter((row) => row.outcome === 'skipped').length,
    };
  }

  private async runBulkRow(tenantId: string, action: CampaignBulkAction, campaignId: string, actor: CampaignActor): Promise<CampaignBulkResult> {
    let status: CampaignEntity['status'];
    let version: number;
    try {
      const campaign = await runInTenantContext(this.dataSource, tenantId, async (manager) => {
        const found = await new CampaignsRepository(manager, tenantId).findActiveById(campaignId);
        if (!found) throw new NotFoundException('Campaign was not found.');
        return found;
      });
      status = campaign.status;
      version = campaign.version;
    } catch {
      return { campaignId, outcome: 'failed', code: 'CAMPAIGN_NOT_FOUND', message: 'Campaign was not found.' };
    }

    const precondition = bulkPrecondition(action, status);
    if (!precondition.allowed) {
      return { campaignId, outcome: 'skipped', code: precondition.code, message: precondition.message };
    }

    try {
      if (action === 'delete') await this.deleteDraft(tenantId, campaignId, version, actor);
      else if (action === 'duplicate') await this.duplicateDraft(tenantId, campaignId, actor);
      else if (status === 'scheduled') await this.cancelCampaignSchedule(tenantId, campaignId, actor);
      else if (status === 'queued') await this.cancelCampaign(tenantId, campaignId, actor);
      else await this.cancelCampaignSend(tenantId, campaignId, randomUUID(), actor);
      return { campaignId, outcome: 'succeeded', code: 'OK', message: '' };
    } catch (cause) {
      return { campaignId, outcome: 'failed', ...bulkFailure(cause) };
    }
  }
```

Add above the class:

```ts
/** Maps the exceptions the single-row methods already throw onto stable bulk codes. */
function bulkFailure(cause: unknown): { code: string; message: string } {
  if (cause instanceof HttpException && cause.getStatus() === 412) {
    return { code: 'CAMPAIGN_VERSION_CONFLICT', message: 'Campaign changed while the action was running.' };
  }
  if (cause instanceof ForbiddenException) return { code: 'DRAFT_OWNER_REQUIRED', message: 'Only the draft owner or an administrator can change this draft.' };
  if (cause instanceof ConflictException) return { code: 'CAMPAIGN_STATE_CONFLICT', message: 'Campaign state changed while the action was running.' };
  return { code: 'BULK_ACTION_FAILED', message: 'The action could not be completed.' };
}
```

Add the imports: `randomUUID` from `node:crypto`, and `bulkPrecondition`, `requiredBulkPermission`, `type CampaignBulkAction` from `./campaign-bulk.js`, plus the bulk types from `./dto/bulk.dto.js`.

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @eow/api typecheck
```

Expected: PASS. If `HttpException`, `ConflictException` or `NotFoundException` are not already imported in this file, add them from `@nestjs/common`.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/campaigns/campaigns.service.ts
git commit -m "feat(api): add bulkAction with per-campaign outcomes"
```

---

### Task 10: bulk route and contract

**Files:**
- Modify: `apps/api/src/campaigns/campaigns.controller.ts`
- Modify: `contracts/openapi.yaml`

- [ ] **Step 1: Add the route**

Declare it **before** `@Get(':id')` and any `@Post(':id/…')` route so Nest does not route `bulk` into an id handler — the same hazard the existing comment at line 37 documents for `history`:

```ts
  @Post('bulk') @HttpCode(200) @UseGuards(CsrfGuard) @RequirePermission(PERMISSIONS.CAMPAIGN_READ)
  async bulk(@Body(new ZodValidationPipe(campaignBulkSchema)) body: CampaignBulkDto, @Req() req: AuthenticatedRequest) {
    return this.campaigns.bulkAction(tenantId(req), body, actor(req));
  }
```

`CAMPAIGN_READ` is the floor that gets the request into the handler; the real per-action permission is checked in `bulkAction` because it differs by action.

- [ ] **Step 2: Add the contract entry**

Insert into `contracts/openapi.yaml` immediately after the `/campaigns/history` block:

```yaml
  /campaigns/bulk:
    post:
      operationId: bulkCampaignAction
      description: >-
        Synchronous bulk action over a bounded campaign selection. Each
        campaign is applied in its own transaction and reported individually:
        a precondition failure is `skipped` with a reason code, an error is
        `failed`, and neither stops the remaining rows. Deliberately carries
        no If-Match (N versions cannot travel in one request) and no
        Idempotency-Key (the call is synchronous and the client disables the
        control while it is in flight).
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [action, campaignIds]
              additionalProperties: false
              properties:
                action: {enum: [delete, duplicate, cancel]}
                campaignIds: {type: array, minItems: 1, maxItems: 100, items: {type: string, format: uuid}}
      responses:
        '200':
          description: Per-campaign outcomes
          content:
            application/json:
              schema:
                type: object
                required: [results, succeeded, failed, skipped]
                properties:
                  results:
                    type: array
                    items:
                      type: object
                      required: [campaignId, outcome, code, message]
                      properties:
                        campaignId: {type: string, format: uuid}
                        outcome: {enum: [succeeded, failed, skipped]}
                        code: {type: string}
                        message: {type: string}
                  succeeded: {type: integer}
                  failed: {type: integer}
                  skipped: {type: integer}
        '403': {$ref: '#/components/responses/Problem'}
```

- [ ] **Step 3: Regenerate, check and commit**

```bash
pnpm contracts:generate
pnpm contracts:compat-check
pnpm --filter @eow/api typecheck
git add apps/api/src/campaigns/campaigns.controller.ts contracts/ packages/contracts/
git commit -m "feat(api): expose POST /campaigns/bulk"
```

---

## Phase 4 — Web: pure logic units

### Task 11: `resolvePageMeta`

**Files:**
- Create: `apps/web/src/app/page-meta.ts`, `apps/web/src/app/page-meta.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/app/page-meta.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { resolvePageMeta } from './page-meta.js';

describe('resolvePageMeta', () => {
  it('names the campaign list', () => {
    expect(resolvePageMeta('/campaigns').title).toBe('Chiến dịch');
  });

  it('names both composer routes the same', () => {
    expect(resolvePageMeta('/campaigns/new').title).toBe('Soạn chiến dịch');
    expect(resolvePageMeta('/campaigns/abc-123/edit').title).toBe('Soạn chiến dịch');
  });

  it('names the detail route, which a static pathname table could not match', () => {
    expect(resolvePageMeta('/campaigns/abc-123').title).toBe('Chi tiết chiến dịch');
  });

  it('still resolves the unchanged static routes', () => {
    expect(resolvePageMeta('/recipients').title).toBe('Người nhận');
    expect(resolvePageMeta('/settings/custom-fields').title).toBe('Cấu hình');
  });

  it('returns empty strings for an unknown path rather than throwing', () => {
    expect(resolvePageMeta('/nope')).toEqual({ title: '', description: '' });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @eow/web exec vitest run src/app/page-meta.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `apps/web/src/app/page-meta.ts`:

```ts
export type PageMeta = { title: string; description: string };

const CAMPAIGN_LIST: PageMeta = { title: 'Chiến dịch', description: 'Theo dõi mọi chiến dịch, từ bản nháp đến kết quả gửi.' };
const CAMPAIGN_COMPOSE: PageMeta = { title: 'Soạn chiến dịch', description: 'Thay đổi được tự động lưu tuần tự để không ghi đè phiên mới hơn.' };
const CAMPAIGN_DETAIL: PageMeta = { title: 'Chi tiết chiến dịch', description: 'Tiến độ gửi và kết quả theo từng người nhận.' };
const SETTINGS: PageMeta = { title: 'Cấu hình', description: 'Quản lý cấu hình gửi, dữ liệu người nhận và biến dùng chung.' };

/**
 * Pattern-matched rather than keyed by exact pathname. The previous
 * `pageMeta[location.pathname]` lookup silently rendered an empty <h1> on
 * every route with a dynamic segment — /history/:campaignId did exactly
 * that — so any new detail route inherited the same bug by default.
 */
const ROUTES: ReadonlyArray<[RegExp, PageMeta]> = [
  [/^\/campaigns$/, CAMPAIGN_LIST],
  [/^\/campaigns\/new$/, CAMPAIGN_COMPOSE],
  [/^\/campaigns\/[^/]+\/edit$/, CAMPAIGN_COMPOSE],
  [/^\/campaigns\/[^/]+$/, CAMPAIGN_DETAIL],
  [/^\/recipients$/, { title: 'Người nhận', description: 'Quản lý danh sách liên hệ hoặc nhập dữ liệu từ Excel.' }],
  [/^\/templates$/, { title: 'Email template', description: 'Quản lý, chỉnh sửa và xem trước các template HTML.' }],
  [/^\/settings\/(senders|policy|custom-fields|global-variables)$/, SETTINGS],
];

export function resolvePageMeta(pathname: string): PageMeta {
  return ROUTES.find(([pattern]) => pattern.test(pathname))?.[1] ?? { title: '', description: '' };
}

/** Both composer routes; used by AppShell to decide whether to show the autosave indicator. */
export function isComposeRoute(pathname: string): boolean {
  return /^\/campaigns\/new$/.test(pathname) || /^\/campaigns\/[^/]+\/edit$/.test(pathname);
}
```

Order matters: `/campaigns/new` and `/campaigns/:id/edit` must be tested before `/campaigns/:id`.

- [ ] **Step 4: Run to verify it passes**

```bash
pnpm --filter @eow/web exec vitest run src/app/page-meta.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/page-meta.ts apps/web/src/app/page-meta.test.ts
git commit -m "feat(web): resolve page meta by route pattern"
```

---

### Task 12: `campaignRowTarget`

**Files:**
- Create: `apps/web/src/screens/campaigns/campaign-row-target.ts`, `campaign-row-target.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { campaignRowTarget } from './campaign-row-target.js';

describe('campaignRowTarget', () => {
  it('opens the composer for a draft, which has no send history yet', () => {
    expect(campaignRowTarget('draft', 'c-1')).toBe('/campaigns/c-1/edit');
  });

  it('opens the detail screen for every non-draft status', () => {
    for (const status of ['scheduled', 'queued', 'sending', 'paused', 'completed', 'partial_failed', 'failed', 'cancelled', 'blocked', 'missed', 'validating']) {
      expect(campaignRowTarget(status, 'c-1')).toBe('/campaigns/c-1');
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @eow/web exec vitest run src/screens/campaigns/campaign-row-target.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
/**
 * A draft has never been sent, so the detail screen would have nothing to
 * show: rows route by status instead of all landing on one destination.
 */
export function campaignRowTarget(status: string, campaignId: string): string {
  return status === 'draft' ? `/campaigns/${campaignId}/edit` : `/campaigns/${campaignId}`;
}
```

- [ ] **Step 4: Run to verify it passes**

Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/screens/campaigns/campaign-row-target.ts apps/web/src/screens/campaigns/campaign-row-target.test.ts
git commit -m "feat(web): route campaign rows by status"
```

---

### Task 13: `campaign-selection`

**Files:**
- Create: `apps/web/src/screens/campaigns/campaign-selection.ts`, `campaign-selection.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { availableBulkActions, toggleSelection, selectAll } from './campaign-selection.js';

const rows = [
  { id: 'a', status: 'draft' },
  { id: 'b', status: 'draft' },
  { id: 'c', status: 'sending' },
  { id: 'd', status: 'completed' },
];

describe('toggleSelection', () => {
  it('adds an unselected id', () => {
    expect(toggleSelection(['a'], 'b')).toEqual(['a', 'b']);
  });

  it('removes a selected id', () => {
    expect(toggleSelection(['a', 'b'], 'a')).toEqual(['b']);
  });
});

describe('selectAll', () => {
  it('selects every row when not all are selected', () => {
    expect(selectAll(rows, ['a'])).toEqual(['a', 'b', 'c', 'd']);
  });

  it('clears the selection when every row is already selected', () => {
    expect(selectAll(rows, ['a', 'b', 'c', 'd'])).toEqual([]);
  });
});

describe('availableBulkActions', () => {
  it('enables nothing for an empty selection', () => {
    expect(availableBulkActions(rows, [])).toEqual({ delete: false, duplicate: false, cancel: false });
  });

  it('enables delete only when every selected row is a draft', () => {
    expect(availableBulkActions(rows, ['a', 'b']).delete).toBe(true);
    expect(availableBulkActions(rows, ['a', 'c']).delete).toBe(false);
  });

  it('enables cancel only when every selected row is in flight', () => {
    expect(availableBulkActions(rows, ['c']).cancel).toBe(true);
    expect(availableBulkActions(rows, ['c', 'd']).cancel).toBe(false);
    expect(availableBulkActions(rows, ['a']).cancel).toBe(false);
  });

  it('enables duplicate for any non-empty selection', () => {
    expect(availableBulkActions(rows, ['a', 'c', 'd']).duplicate).toBe(true);
  });

  it('ignores selected ids that are no longer on the page', () => {
    expect(availableBulkActions(rows, ['a', 'gone']).delete).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @eow/web exec vitest run src/screens/campaigns/campaign-selection.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
export type SelectableCampaign = { id: string; status: string };
export type BulkActionAvailability = { delete: boolean; duplicate: boolean; cancel: boolean };

const CANCELLABLE = new Set(['scheduled', 'queued', 'sending']);

export function toggleSelection(selected: readonly string[], id: string): string[] {
  return selected.includes(id) ? selected.filter((value) => value !== id) : [...selected, id];
}

export function selectAll(rows: readonly SelectableCampaign[], selected: readonly string[]): string[] {
  return selected.length === rows.length && rows.length > 0 ? [] : rows.map((row) => row.id);
}

/**
 * An action is offered only when it is valid for *every* selected row, so a
 * bulk click can never produce a result the user did not ask for. Ids that
 * are no longer on the page are ignored rather than blocking the action:
 * the server re-checks each row anyway and reports it as skipped.
 */
export function availableBulkActions(rows: readonly SelectableCampaign[], selected: readonly string[]): BulkActionAvailability {
  const statuses = selected
    .map((id) => rows.find((row) => row.id === id)?.status)
    .filter((status): status is string => status !== undefined);
  if (statuses.length === 0) return { delete: false, duplicate: false, cancel: false };
  return {
    delete: statuses.every((status) => status === 'draft'),
    duplicate: true,
    cancel: statuses.every((status) => CANCELLABLE.has(status)),
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/screens/campaigns/campaign-selection.ts apps/web/src/screens/campaigns/campaign-selection.test.ts
git commit -m "feat(web): add campaign selection and bulk availability rules"
```

---

### Task 14: `bulk-outcome`

**Files:**
- Create: `apps/web/src/screens/campaigns/bulk-outcome.ts`, `bulk-outcome.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { bulkSummary, reasonByCampaign, retrySet } from './bulk-outcome.js';

const response = {
  results: [
    { campaignId: 'a', outcome: 'succeeded' as const, code: 'OK', message: '' },
    { campaignId: 'b', outcome: 'succeeded' as const, code: 'OK', message: '' },
    { campaignId: 'c', outcome: 'failed' as const, code: 'CAMPAIGN_VERSION_CONFLICT', message: 'Campaign changed while the action was running.' },
    { campaignId: 'd', outcome: 'skipped' as const, code: 'CAMPAIGN_NOT_DRAFT', message: 'Only a draft campaign can be deleted.' },
  ],
  succeeded: 2, failed: 1, skipped: 1,
};

describe('bulkSummary', () => {
  it('reports the unfinished rows alongside the successes', () => {
    expect(bulkSummary('delete', response)).toBe('Đã xóa 2 chiến dịch. 2 chiến dịch không xử lý được, vẫn đang được chọn bên dưới kèm lý do.');
  });

  it('reports a clean run without mentioning failures', () => {
    expect(bulkSummary('duplicate', { results: [], succeeded: 3, failed: 0, skipped: 0 }))
      .toBe('Đã nhân bản 3 chiến dịch.');
  });

  it('uses the right verb for cancel', () => {
    expect(bulkSummary('cancel', { results: [], succeeded: 1, failed: 0, skipped: 0 })).toBe('Đã dừng 1 chiến dịch.');
  });
});

describe('retrySet', () => {
  it('is exactly the rows that did not succeed', () => {
    expect(retrySet(response)).toEqual(['c', 'd']);
  });
});

describe('reasonByCampaign', () => {
  it('maps each unfinished row to a short Vietnamese one-liner keyed by code', () => {
    expect(reasonByCampaign(response)).toEqual({
      c: 'Không xong: vừa bị người khác sửa.',
      d: 'Bỏ qua: chỉ xóa được bản nháp.',
    });
  });

  it('falls back to a generic line for an unrecognised code, never the server message', () => {
    const unknown = { results: [{ campaignId: 'x', outcome: 'failed' as const, code: 'WAT', message: 'a very long server sentence' }], succeeded: 0, failed: 1, skipped: 0 };
    expect(reasonByCampaign(unknown)).toEqual({ x: 'Không xong: lỗi không xác định.' });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @eow/web exec vitest run src/screens/campaigns/bulk-outcome.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import type { CampaignBulkAction, CampaignBulkResponse } from '../../api/campaign-list.js';

/**
 * Reasons are short fixed strings keyed by code, never the server's own
 * `message`. A full sentence wraps in the name column, widens it and pushes
 * the rest of the table out of alignment — found while reviewing the mockup.
 */
const REASON: Record<string, string> = {
  CAMPAIGN_NOT_DRAFT: 'Bỏ qua: chỉ xóa được bản nháp.',
  CAMPAIGN_NOT_CANCELLABLE: 'Bỏ qua: chiến dịch không đang chờ hoặc đang gửi.',
  CAMPAIGN_VERSION_CONFLICT: 'Không xong: vừa bị người khác sửa.',
  CAMPAIGN_STATE_CONFLICT: 'Không xong: trạng thái vừa thay đổi.',
  DRAFT_OWNER_REQUIRED: 'Không xong: không phải bản nháp của bạn.',
  CAMPAIGN_NOT_FOUND: 'Không xong: chiến dịch không còn tồn tại.',
};

const VERB: Record<CampaignBulkAction, string> = {
  delete: 'Đã xóa',
  duplicate: 'Đã nhân bản',
  cancel: 'Đã dừng',
};

export function retrySet(response: CampaignBulkResponse): string[] {
  return response.results.filter((row) => row.outcome !== 'succeeded').map((row) => row.campaignId);
}

export function reasonByCampaign(response: CampaignBulkResponse): Record<string, string> {
  const reasons: Record<string, string> = {};
  for (const row of response.results) {
    if (row.outcome === 'succeeded') continue;
    reasons[row.campaignId] = REASON[row.code] ?? 'Không xong: lỗi không xác định.';
  }
  return reasons;
}

export function bulkSummary(action: CampaignBulkAction, response: CampaignBulkResponse): string {
  const done = `${VERB[action]} ${response.succeeded} chiến dịch.`;
  const unfinished = response.failed + response.skipped;
  return unfinished === 0 ? done : `${done} ${unfinished} chiến dịch không xử lý được, vẫn đang được chọn bên dưới kèm lý do.`;
}
```

- [ ] **Step 4: Run to verify it passes**

Expected: PASS, 6 tests. Task 3 supplies the `CampaignBulkAction` and `CampaignBulkResponse` types this module imports.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/screens/campaigns/bulk-outcome.ts apps/web/src/screens/campaigns/bulk-outcome.test.ts
git commit -m "feat(web): summarise bulk outcomes as short per-row reasons"
```

---

### Task 15: `active-filters`

**Files:**
- Create: `apps/web/src/screens/campaigns/active-filters.ts`, `active-filters.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { filterChips, removeFilter } from './active-filters.js';

describe('filterChips', () => {
  it('is empty when nothing is filtered', () => {
    expect(filterChips({})).toEqual([]);
  });

  it('labels a status filter with its Vietnamese name', () => {
    expect(filterChips({ status: 'draft' })).toEqual([{ key: 'status', label: 'Trạng thái: Bản nháp' }]);
  });

  it('labels both ends of a date range in Vietnamese order', () => {
    expect(filterChips({ dateFrom: '2026-08-01T00:00:00Z', dateTo: '2026-08-31T23:59:59Z' })).toEqual([
      { key: 'dateFrom', label: 'Từ 01/08/2026' },
      { key: 'dateTo', label: 'Đến 31/08/2026' },
    ]);
  });

  it('labels the id-valued filters generically, since the id is not a name', () => {
    expect(filterChips({ senderConfigId: 's-1', createdBy: 'u-1' })).toEqual([
      { key: 'senderConfigId', label: 'Cấu hình gửi đã chọn' },
      { key: 'createdBy', label: 'Người tạo đã chọn' },
    ]);
  });

  it('ignores paging and search, which have their own controls', () => {
    expect(filterChips({ cursor: 'abc', limit: 25, search: 'tháng 8' })).toEqual([]);
  });
});

describe('removeFilter', () => {
  it('drops one filter and keeps the rest', () => {
    expect(removeFilter({ status: 'draft', dateFrom: '2026-08-01T00:00:00Z' }, 'status')).toEqual({ dateFrom: '2026-08-01T00:00:00Z' });
  });

  it('drops the cursor too, because the old page is meaningless under a new filter', () => {
    expect(removeFilter({ status: 'draft', cursor: 'abc' }, 'status')).toEqual({});
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @eow/web exec vitest run src/screens/campaigns/active-filters.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import type { CampaignHistoryQuery } from '../../api/campaign-list.js';

export type FilterChipKey = 'status' | 'dateFrom' | 'dateTo' | 'senderConfigId' | 'createdBy';
export type FilterChip = { key: FilterChipKey; label: string };

export const CAMPAIGN_STATUS_LABEL: Record<string, string> = {
  draft: 'Bản nháp', scheduled: 'Đã lên lịch', blocked: 'Cần xử lý trước khi gửi', missed: 'Quá thời gian dự kiến',
  queued: 'Sẵn sàng gửi', validating: 'Đang kiểm tra trước khi gửi', sending: 'Đang gửi', paused: 'Đã tạm dừng',
  completed: 'Gửi hoàn tất', partial_failed: 'Hoàn tất, có email lỗi', failed: 'Không gửi được', cancelled: 'Đã dừng',
};

function day(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getUTCDate()).padStart(2, '0')}/${String(date.getUTCMonth() + 1).padStart(2, '0')}/${date.getUTCFullYear()}`;
}

/**
 * Chips are *output*: they show what the filter dialog currently holds and
 * let one dimension be dropped. They are deliberately not a second input for
 * `status` — that would be a duplicate control over the same query field.
 * Adding a filter dimension later only means adding a case here.
 */
export function filterChips(query: CampaignHistoryQuery): FilterChip[] {
  const chips: FilterChip[] = [];
  if (query.status) chips.push({ key: 'status', label: `Trạng thái: ${CAMPAIGN_STATUS_LABEL[query.status] ?? query.status}` });
  if (query.dateFrom) chips.push({ key: 'dateFrom', label: `Từ ${day(query.dateFrom)}` });
  if (query.dateTo) chips.push({ key: 'dateTo', label: `Đến ${day(query.dateTo)}` });
  if (query.senderConfigId) chips.push({ key: 'senderConfigId', label: 'Cấu hình gửi đã chọn' });
  if (query.createdBy) chips.push({ key: 'createdBy', label: 'Người tạo đã chọn' });
  return chips;
}

/** Removing a filter invalidates the cursor: that page was numbered under the old predicate. */
export function removeFilter(query: CampaignHistoryQuery, key: FilterChipKey): CampaignHistoryQuery {
  const next = { ...query };
  delete next[key];
  delete next.cursor;
  return next;
}
```

- [ ] **Step 4: Run to verify it passes**

Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/screens/campaigns/active-filters.ts apps/web/src/screens/campaigns/active-filters.test.ts
git commit -m "feat(web): derive removable filter chips from the list query"
```

---

## Phase 5 — Web: navigation and routing

### Task 16: sidebar entry and shell wiring

**Files:**
- Modify: `apps/web/src/app/nav.ts`
- Modify: `apps/web/src/app/AppShell.tsx:66,120,~200`

- [ ] **Step 1: Rewrite the nav table**

Replace `navGroups`, `routePermissions` and `pageMeta` in `apps/web/src/app/nav.ts`. Delete the `pageMeta` export entirely — `resolvePageMeta` from `page-meta.ts` replaces it.

```ts
export const navGroups: NavGroup[] = [
  {
    items: [{
      id: 'campaigns',
      label: 'Chiến dịch',
      icon: 'compose',
      path: '/campaigns',
      // The composer and the detail screen are route descendants, so they
      // keep the entry lit without needing activePaths.
      requiredPermission: 'campaign:read',
    }],
  },
  {
    label: 'QUẢN LÝ',
    items: [
      { id: 'recipients', label: 'Người nhận', icon: 'recipients', path: '/recipients', requiredPermission: 'recipient:read' },
      { id: 'templates', label: 'Email template', icon: 'templates', path: '/templates', requiredPermission: 'content:manage' },
    ],
  },
  {
    label: 'HỆ THỐNG',
    items: [{
      id: 'settings',
      label: 'Cấu hình',
      icon: 'settings',
      path: '/settings/senders',
      activePaths: ['/settings/policy', '/settings/custom-fields', '/settings/global-variables'],
      requiredPermission: 'settings:manage',
    }],
  },
];

export const routePermissions: Record<string, string> = {
  '/campaigns': 'campaign:read',
  '/campaigns/new': 'content:manage',
  '/campaigns/:id/edit': 'content:manage',
  '/campaigns/:id': 'campaign:read',
  '/recipients': 'recipient:read',
  '/templates': 'content:manage',
  '/settings/senders': 'settings:manage',
  '/settings/policy': 'settings:manage',
  '/settings/custom-fields': 'settings:manage',
  '/settings/global-variables': 'settings:manage',
};
```

`isNavItemActive` matches `path` exactly plus `activePaths`, so extend it to also match descendants of `path` — otherwise `Chiến dịch` goes dark on `/campaigns/:id`. Update `apps/web/src/app/nav-active.ts` and add this case to `nav-active.test.ts`:

```ts
  it('stays active on a descendant route', () => {
    expect(isNavItemActive({ path: '/campaigns' }, '/campaigns/abc/edit')).toBe(true);
  });

  it('does not match a sibling with a shared prefix', () => {
    expect(isNavItemActive({ path: '/campaigns' }, '/campaigns-archive')).toBe(false);
  });
```

The implementation becomes:

```ts
  return pathname === item.path
    || pathname.startsWith(`${item.path}/`)
    || (item.activePaths?.includes(pathname) ?? false);
```

- [ ] **Step 2: Point AppShell at the resolver**

In `apps/web/src/app/AppShell.tsx`:

```ts
import { resolvePageMeta, isComposeRoute } from './page-meta.js';
import { navGroups } from './nav.js';
```

```ts
  const meta = resolvePageMeta(location.pathname);
  const isComposeCompose = isComposeRoute(location.pathname);
```

Leave the two disabled `Gửi thử` / `Gửi ngay` buttons in the page header alone — they belong to the composer spec, which is explicitly out of scope.

- [ ] **Step 3: Verify**

```bash
pnpm --filter @eow/web exec vitest run src/app
pnpm --filter @eow/web typecheck
```

Expected: nav-active and page-meta suites PASS. Typecheck will still fail on `AppRoutes.tsx` until Task 17 — that is expected at this point.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/nav.ts apps/web/src/app/nav-active.ts apps/web/src/app/nav-active.test.ts apps/web/src/app/AppShell.tsx
git commit -m "feat(web): replace the Email and Lịch sử gửi nav entries with Chiến dịch"
```

---

### Task 17: routes and legacy redirects

**Files:**
- Create: `apps/web/src/app/LegacyRedirects.tsx`
- Modify: `apps/web/src/app/AppRoutes.tsx`

- [ ] **Step 1: Write the redirect component**

`/email/compose?draft=X` cannot be a static `<Navigate>` — the target path is built from a query parameter.

```tsx
import { Navigate, useSearchParams } from 'react-router-dom';

/**
 * The composer moved from `?draft=<id>` to `/campaigns/:id/edit`. Saved
 * links and the e2e suite still use the old shape, so the query parameter
 * is translated rather than dropped.
 */
export function LegacyComposeRedirect() {
  const [searchParams] = useSearchParams();
  const draftId = searchParams.get('draft');
  return <Navigate to={draftId ? `/campaigns/${draftId}/edit` : '/campaigns/new'} replace />;
}
```

- [ ] **Step 2: Rewrite the route table**

Inside the authenticated shell in `apps/web/src/app/AppRoutes.tsx`, replace the `/email/*` and `/history/*` routes with:

```tsx
        <Route path="/campaigns" element={<RequirePermission permission="campaign:read"><CampaignListScreen /></RequirePermission>} />
        <Route path="/campaigns/new" element={<RequirePermission permission="content:manage"><ComposeDraftScreen /></RequirePermission>} />
        <Route path="/campaigns/:campaignId/edit" element={<RequirePermission permission="content:manage"><ComposeDraftScreen /></RequirePermission>} />
        <Route path="/campaigns/:campaignId" element={<RequirePermission permission="campaign:read"><CampaignDetailScreen /></RequirePermission>} />

        <Route path="/email/compose" element={<LegacyComposeRedirect />} />
        <Route path="/email/drafts" element={<Navigate to="/campaigns" replace />} />
        <Route path="/history" element={<Navigate to="/campaigns" replace />} />
        <Route path="/history/:campaignId" element={<LegacyHistoryRedirect />} />
```

`LegacyHistoryRedirect` reads the param and forwards it — add it to `LegacyRedirects.tsx`:

```tsx
import { useParams } from 'react-router-dom';

export function LegacyHistoryRedirect() {
  const { campaignId } = useParams<{ campaignId: string }>();
  return <Navigate to={campaignId ? `/campaigns/${campaignId}` : '/campaigns'} replace />;
}
```

Change both catch-alls at the bottom of the file from `/email/compose` to `/campaigns`.

- [ ] **Step 3: Fix the detail screen's back link**

Deferred from Task 2 because `/campaigns` did not resolve until this task. In `apps/web/src/screens/campaigns/CampaignDetailScreen.tsx`, the header link currently points at the composer, so "back" lands in the wrong place:

```tsx
<Link to="/campaigns" className="secondary-button">← Quay lại danh sách chiến dịch</Link>
```

- [ ] **Step 4: Send drafts from the detail route to the composer**

A draft has no progress to show. In the same file, after the existing `getCampaignDraft` effect:

```tsx
  const navigate = useNavigate();
  useEffect(() => {
    if (draft?.status === 'draft' && campaignId) navigate(`/campaigns/${campaignId}/edit`, { replace: true });
  }, [draft?.status, campaignId, navigate]);
```

Add `useNavigate` to the existing `react-router-dom` import.

- [ ] **Step 5: Typecheck**

```bash
pnpm --filter @eow/web typecheck
```

Expected: PASS. Both `CampaignListScreen` and `CampaignDetailScreen` already exist under `screens/campaigns/` — Task 2 renamed them there, and this task only repoints the route table at the new URLs.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/app/LegacyRedirects.tsx apps/web/src/app/AppRoutes.tsx apps/web/src/screens/campaigns/CampaignDetailScreen.tsx
git commit -m "feat(web): route /campaigns and redirect the legacy email and history URLs"
```

---

### Task 18: composer reads the draft id from the path

**Files:**
- Modify: `apps/web/src/screens/compose/ComposeDraftScreen.tsx:216-234,340`

- [ ] **Step 1: Swap the parameter source**

Replace the `useSearchParams` import and usage with `useNavigate` / `useParams`:

```tsx
import { useOutletContext, useNavigate, useParams, Link } from 'react-router-dom';
```

```tsx
  const navigate = useNavigate();
  const { campaignId } = useParams<{ campaignId: string }>();
```

The load effect becomes:

```tsx
  useEffect(() => {
    if (campaignId) {
      void getCampaignDraft(campaignId).then((draft) => dispatch({ type: 'saved', draft })).catch((cause) => setLoadError(cause instanceof ApiError ? cause.message : 'Không thể tải bản nháp.'));
      return;
    }
    if (createStarted.current || state) return;
    createStarted.current = true;
    setCreating(true);
    void createCampaignDraft({ name: '' })
      .then((draft) => { dispatch({ type: 'saved', draft }); navigate(`/campaigns/${draft.id}/edit`, { replace: true }); })
      .catch((cause) => { createStarted.current = false; setLoadError(cause instanceof ApiError ? cause.message : 'Không thể tạo bản nháp.'); })
      .finally(() => setCreating(false));
  }, [campaignId, navigate]);
```

- [ ] **Step 2: Fix the error-state button**

Line 340 does a full page load to a route that no longer exists:

```tsx
<button className="secondary-button" onClick={() => navigate('/campaigns')}>Quay lại danh sách chiến dịch</button>
```

- [ ] **Step 3: Fix the in-page progress link**

The `SendingBanner` links to `/history/${campaignId}`; change it to `/campaigns/${campaignId}`.

- [ ] **Step 4: Typecheck and commit**

```bash
pnpm --filter @eow/web typecheck
git add apps/web/src/screens/compose/ComposeDraftScreen.tsx
git commit -m "refactor(web): read the composer draft id from the route path"
```

---

## Phase 6 — Web: screens

### Task 19: `CampaignListScreen`

**Files:**
- Modify: `apps/web/src/screens/campaigns/CampaignListScreen.tsx`

- [ ] **Step 1: Grow the screen**

The file already exists and already works — Task 2 renamed the send-history screen into it. Apply these nine changes in place; everything not listed (the search debounce, `HistoryFilterDialog` wiring, countdown, resend flow, load/error/empty states) stays exactly as it is.

1. `fetchCampaignHistory({ ...query, includeDrafts: true, search: debouncedSearch || undefined })`.
2. Add selection state and the bulk flow:

```tsx
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [summary, setSummary] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const canSelect = hasPermission(session.data?.permissions, PERMISSIONS.CONTENT_MANAGE)
    || hasPermission(session.data?.permissions, PERMISSIONS.CAMPAIGN_MANAGE);
  const rows = (items ?? []).map((row) => ({ id: row.id, status: row.status }));
  const actions = availableBulkActions(rows, selectedIds);

  const runBulk = async (action: CampaignBulkAction) => {
    setRunning(true);
    try {
      const response = await bulkCampaignAction(action, selectedIds);
      setSummary(bulkSummary(action, response));
      setReasons(reasonByCampaign(response));
      setSelectedIds(retrySet(response));
      load();
    } catch (cause) {
      setSummary(cause instanceof ApiError ? cause.message : 'Không chạy được thao tác hàng loạt.');
    } finally {
      setRunning(false);
    }
  };
```

3. Toolbar: keep the search box and the filter button, **do not add a status pill strip** — status lives in the filter dialog only. Render the chips underneath:

```tsx
      <div className="module-frame-body">
        {filterChips(query).length > 0 && (
          <div className="active-filters" aria-label="Bộ lọc đang áp dụng">
            <span>Đang lọc</span>
            {filterChips(query).map((chip) => (
              <button key={chip.key} className="active-filter-chip" onClick={() => setQuery(removeFilter(query, chip.key))}>
                {chip.label}<i aria-hidden="true">×</i>
              </button>
            ))}
            <button className="active-filter-clear" onClick={() => setQuery({})}>Xóa bộ lọc</button>
          </div>
        )}
```

4. Bulk bar, shown when there is a selection or a summary to report:

```tsx
        {(selectedIds.length > 0 || summary) && (
          <div className="bulk-bar">
            <span>{summary ?? <><b>{selectedIds.length}</b> chiến dịch đã chọn</>}</span>
            <div>
              <button disabled={running || !actions.duplicate} onClick={() => void runBulk('duplicate')}>Nhân bản</button>
              <button disabled={running || !actions.cancel} onClick={() => void runBulk('cancel')}>Dừng gửi</button>
              <button className="danger-text" disabled={running || !actions.delete} onClick={() => void runBulk('delete')}>Xóa</button>
            </div>
            <button aria-label="Bỏ chọn tất cả" onClick={() => { setSelectedIds([]); setReasons({}); setSummary(null); }}>×</button>
          </div>
        )}
```

5. Table: prepend a checkbox column, gated on `canSelect`, using the same markup `RecipientsScreen.tsx:459-486` uses. The row click handler becomes `navigate(campaignRowTarget(row.status, row.id))`; the checkbox cell calls `event.stopPropagation()`.

6. Row subtitle: show the bulk reason when there is one, otherwise the subject.

```tsx
<td>
  <b>{row.name}</b>
  {reasons[row.id]
    ? <small className="row-reason">{reasons[row.id]}</small>
    : <small className="cell-subtitle">{row.subject}</small>}
</td>
```

7. Progress cell: a draft has no send progress, so render completeness text instead of the barber-pole bar.

```tsx
<td>
  {row.status === 'draft' ? (
    <span className="cell-subtitle">Bản nháp chưa gửi</span>
  ) : row.progress ? (
    <div className="send-progress">
      <div><i style={{ width: `${row.progress.percent}%` }} /></div>
      <span>{row.progress.percent}%</span>
      <small>{row.progress.sent} gửi · {row.progress.pending} chờ · {row.progress.failed} lỗi</small>
    </div>
  ) : (
    <div className="send-progress scheduled">
      <div><i style={{ width: '0%' }} /></div>
      <span>Chờ gửi</span>
    </div>
  )}
</td>
```

The `.send-progress.scheduled` rule forces `width:100%` with a dashed gradient meaning "waiting to send", which is why a draft must not use it — a draft is not waiting, it has never been scheduled.

8. Status label: use `CAMPAIGN_STATUS_LABEL` from `active-filters.ts` rather than the local `STATUS_LABEL`, so `draft` has a name. Extend `statusClass` with `if (status === 'draft') return '';`.

9. Empty state copy: `Chưa có chiến dịch nào.`

- [ ] **Step 2: Verify in the browser**

```bash
pnpm --filter @eow/web dev
```

Sign in as `admin@example.test` / `Admin@123`, go to `/campaigns`, and confirm: drafts and sent campaigns appear in one table; selecting three drafts disables `Dừng gửi`; deleting a mixed selection leaves the unfinished rows selected with reasons; clicking a draft row opens the composer and a sent row opens the detail.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/screens/campaigns/CampaignListScreen.tsx
git commit -m "feat(web): add the unified campaign list with bulk actions"
```

---

### Task 20: filter dialog — full status vocabulary and a clear option

**Files:**
- Modify: `apps/web/src/screens/campaigns/HistoryFilterDialog.tsx:4-11,44-56`

- [ ] **Step 1: Replace the status options**

Six of the twelve statuses are missing today, and the radios have no way back to "no filter".

```tsx
import { CAMPAIGN_STATUS_LABEL } from './active-filters.js';

const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'Tất cả trạng thái' },
  ...Object.entries(CAMPAIGN_STATUS_LABEL).map(([value, label]) => ({ value, label })),
];
```

- [ ] **Step 2: Make the empty option clear the filter**

```tsx
                    <input
                      type="radio"
                      name="history-status"
                      checked={(draft.status ?? '') === option.value}
                      onChange={() => setDraft((current) => ({ ...current, status: option.value || undefined }))}
                    />
```

Change the grid class from `three` to `four` so thirteen options do not produce an over-tall dialog, and update the heading from `Trạng thái gửi` to `Trạng thái chiến dịch`.

- [ ] **Step 3: Verify and commit**

Reload `/campaigns`, open `Bộ lọc`, pick `Bản nháp`, apply — the table shows only drafts and a `Trạng thái: Bản nháp ×` chip appears. Click the chip; the filter clears.

```bash
git add apps/web/src/screens/campaigns/HistoryFilterDialog.tsx
git commit -m "fix(web): offer every campaign status in the filter and allow clearing it"
```

---

### Task 21: styles and the removal of `DraftsScreen`

**Files:**
- Modify: `apps/web/src/app/globals.css`
- Delete: `apps/web/src/screens/drafts/DraftsScreen.tsx`

- [ ] **Step 1: Generalise the bulk bar**

`RecipientsScreen` and the campaign list use the same control, so the selector carries both names rather than duplicating the block. Find every `.recipient-bulk-bar` rule in `globals.css` (including the dark-theme overrides) and add `.bulk-bar` to each selector, e.g.:

```css
.recipient-bulk-bar,.bulk-bar{min-height:48px;margin:0 0 12px;padding:7px 10px 7px 14px;border:1px solid color-mix(in srgb,var(--color-primary) 30%,var(--color-border));border-radius:11px;background:var(--color-primary-soft);display:flex;align-items:center;gap:14px}
```

- [ ] **Step 2: Add the new rules**

```css
.active-filters{display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin:0 0 12px}
.active-filters>span{font-size:9px;font-weight:750;letter-spacing:.04em;text-transform:uppercase;color:var(--color-text-subtle);margin-right:2px}
.active-filter-chip{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 6px 0 10px;border-radius:999px;border:1px solid color-mix(in srgb,var(--color-primary) 30%,var(--color-border));background:var(--color-primary-soft);color:var(--color-primary-text);font-size:10px;font-weight:700}
.active-filter-chip i{font-style:normal;font-size:13px;line-height:1;width:16px;height:16px;border-radius:999px;display:grid;place-items:center;background:color-mix(in srgb,var(--color-primary) 14%,transparent)}
.active-filter-clear{height:28px;padding:0 8px;border:0;border-radius:7px;background:transparent;color:var(--color-text-muted);font-size:10px;font-weight:600;text-decoration:underline}
.row-reason{display:block;margin-top:2px;font-size:9px;line-height:1.45;color:var(--color-warning);font-weight:600}
table tr.is-selected{background:var(--color-primary-soft)}
```

If `--color-warning` is not defined, use the amber token the `.status.warning` rule already uses.

- [ ] **Step 3: Delete `DraftsScreen`**

```bash
git rm apps/web/src/screens/drafts/DraftsScreen.tsx
```

Its rename / duplicate / delete affordances are now covered: rename via the composer's own name field, duplicate and delete via the bulk bar. Add a per-row kebab to `CampaignListScreen` for the single-row equivalents using the existing `EntityActionMenu`:

```tsx
<EntityActionMenu
  label={`Tùy chọn chiến dịch ${row.name}`}
  items={[
    { label: row.status === 'draft' ? 'Tiếp tục soạn' : 'Xem chi tiết', icon: 'arrowRight', onSelect: () => navigate(campaignRowTarget(row.status, row.id)) },
    { label: 'Nhân bản chiến dịch', icon: 'copy', onSelect: () => { setSelectedIds([row.id]); void runBulk('duplicate'); } },
  ]}
/>
```

- [ ] **Step 4: Verify no orphans and commit**

```bash
pnpm --filter @eow/architecture-tests test
pnpm --filter @eow/web typecheck
git add apps/web/src
git commit -m "feat(web): style the campaign list and retire DraftsScreen"
```

Expected: `ARCH-NO-ORPHANS` passes — every new module is reachable from `main.tsx` through the routed screens.

---

## Phase 7 — Tests and verification

### Task 22: update the e2e suite

**Files:**
- Modify: `apps/web/e2e/auth.spec.ts:19-30`, `rbac.spec.ts:37-51`, `visual-capture.spec.ts`

- [ ] **Step 1: Fix the nav and title assertions**

`auth.spec.ts`:

```ts
  test('sign in lands on /campaigns in the shell, and sign out returns to /login', async ({ page }) => {
```

```ts
    await expect(page.locator('.sidebar .nav-item.active')).toContainText('Chiến dịch');
    await expect(page.locator('.page-header h1')).toHaveText('Chiến dịch');
```

The post-login landing URL assertion in the same test changes from `/email/compose` to `/campaigns`.

`rbac.spec.ts` — the viewer no longer sees a `Lịch sử gửi` entry; it sees `Chiến dịch` instead:

```ts
    expect(navLabels).toContain('Chiến dịch');
    expect(navLabels).not.toContain('Email template');
```

and for the operator/admin cases, replace `expect(navLabels).toContain('Email')` and `expect(navLabels).toContain('Lịch sử gửi')` with a single `expect(navLabels).toContain('Chiến dịch')`.

- [ ] **Step 2: Update the route literals**

```bash
grep -n "email/compose\|email/drafts\|'/history" apps/web/e2e/visual-capture.spec.ts
```

Rewrite each: `/email/compose` → `/campaigns/new`, `/email/compose?draft=${draft.id}` → `/campaigns/${draft.id}/edit`, `/email/drafts` → `/campaigns`. The redirects added in Task 16 mean an overlooked one still works, so treat a passing suite as necessary but not sufficient — the grep must come back clean.

- [ ] **Step 3: Run the e2e suite**

```bash
pnpm --filter @eow/web exec playwright test
```

Expected: PASS. Investigate any screenshot diffs in `visual-capture.spec.ts` — the campaign list is a new screen, so new baselines are expected; changed baselines on unrelated screens are not.

- [ ] **Step 4: Commit**

```bash
git add apps/web/e2e
git commit -m "test(e2e): follow the Chiến dịch routes and nav labels"
```

---

### Task 23: full verification

- [ ] **Step 1: Run the workspace check**

```bash
pnpm check
```

Not bare `pnpm test` — two API boot tests fail without a prior build. Compare the **test count and skip count** against the run before this work started, not just the exit code: a suite that stops running reports skipped tests under a green summary.

- [ ] **Step 2: Confirm the contract is still compatible**

```bash
pnpm contracts:compat-check
```

- [ ] **Step 3: Manual pass over the required states**

At 1440, 768 and 390 px, against the seeded admin:

| State | How to reach it |
|---|---|
| loading | throttle the network, load `/campaigns` |
| empty | filter to a status with no campaigns |
| error | stop the API, reload `/campaigns` |
| success | default load |
| permission_denied | sign in as a viewer, open `/campaigns/new` |
| reconnecting | stop the realtime socket while a campaign is sending |
| partial failure | bulk-delete a mixed selection of drafts and sent campaigns |
| viewer list | sign in as a viewer: no checkbox column, no draft rows |

- [ ] **Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix(web): address findings from the Chiến dịch verification pass"
```

---
