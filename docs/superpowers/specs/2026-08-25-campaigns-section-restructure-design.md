# Campaigns Section Restructure — Design

## Context

The sidebar's first entry is labelled `Email` and opens the composer directly (`/email/compose`). Three problems follow from that shape, all raised by the user on 2026-08-25 and all confirmed against the code:

1. **The campaign list is unreachable.** `DraftsScreen` exists and works at `/email/drafts`, but nothing links to it — not the sidebar, not a tab, nothing. The only ways in are typing the URL or hitting the error state in `ComposeDraftScreen.tsx:340`. The approved handoff had an `.email-workspace-tabs` strip (`Soạn email` / `Bản nháp`) at `design-reference/ui-handoff-v2/source/app/page.tsx:290`; the react-router migration dropped it. Its CSS is still in `globals.css`.

2. **Send history is a second, parallel campaign list.** At the data layer the two lists are exact complements: `GET /campaigns` filters `status = 'draft'` (`campaigns.repository.ts:19`), `GET /campaigns/history` filters `status <> 'draft'` (`history-query.ts:51`). The backend already treats these as one entity; only the UI splits them into two sidebar destinations.

3. **The list offers no multi-selection and no detail affordance.** `DraftsScreen` has a per-row "Tiếp tục soạn" button and a kebab menu, nothing else.

Six design questions were resolved with the user in sequence, each with alternatives and trade-offs presented; a working mockup built against the real `globals.css` was reviewed and revised twice before approval. The composer's own gaps (no preview, no editing, no variable insertion) are a separate, independent piece of work and are **out of scope here** — see "Out of scope".

`design-reference/ui-source-contract.yaml` carries the rule `do_not_redesign_without_explicit_approval`. The user gave that approval explicitly for this restructure, including the rename away from the handoff's `Email` label.

## Decision

### Sidebar and routes

`Email` and `Lịch sử gửi` both disappear. One entry replaces them:

```
Chiến dịch                     /campaigns
QUẢN LÝ
  Người nhận                   /recipients
  Email template               /templates
HỆ THỐNG
  Cấu hình                     /settings/senders
```

| Route | Screen | Permission |
|---|---|---|
| `/campaigns` | `CampaignListScreen` — every campaign, every status | `campaign:read` |
| `/campaigns/new` | `ComposeDraftScreen` — creates a draft, then replaces the URL with `/campaigns/:id/edit` | `content:manage` |
| `/campaigns/:id/edit` | `ComposeDraftScreen` — opens an existing draft | `content:manage` |
| `/campaigns/:id` | `CampaignDetailScreen` — progress and per-recipient send history | `campaign:read` |

`campaign:read` is held by admin, operator and viewer (`004_rbac.sql:82,87`), so the nav entry is visible to every role. Viewer reaches the list and the detail but not the composer, which keeps today's boundary intact.

The draft id moves from a query parameter (`?draft=`) to a path segment. `ComposeDraftScreen` currently reads `searchParams.get('draft')` and calls `setSearchParams({ draft: id }, { replace: true })` after creating; both become `useParams()` / `navigate('/campaigns/:id/edit', { replace: true })`.

### Redirects

Saved links and the ~20 `page.goto('/email/…')` calls in `visual-capture.spec.ts` must keep working:

| From | To |
|---|---|
| `/email/compose` | `/campaigns/new` |
| `/email/compose?draft=X` | `/campaigns/X/edit` |
| `/email/drafts` | `/campaigns` |
| `/history` | `/campaigns` |
| `/history/:id` | `/campaigns/:id` |

The `?draft=` case needs a small redirect component rather than a static `<Navigate>`, since it reads the query parameter to build the target path.

### Page titles

`pageMeta` is keyed by exact pathname and looked up as `pageMeta[location.pathname]`, so **every route with a dynamic segment already renders an empty `<h1>`** — `/history/:campaignId` does this today. Replace the lookup with `resolvePageMeta(pathname)`, a pure pattern-matching helper with its own unit test:

```ts
resolvePageMeta('/campaigns')            // { title: 'Chiến dịch', description: 'Theo dõi mọi chiến dịch, từ bản nháp đến kết quả gửi.' }
resolvePageMeta('/campaigns/new')        // { title: 'Soạn chiến dịch', … }
resolvePageMeta('/campaigns/abc/edit')   // { title: 'Soạn chiến dịch', … }
resolvePageMeta('/campaigns/abc')        // { title: 'Chi tiết chiến dịch', … }
```

`AppShell`'s `isComposeCompose` check (which gates the autosave indicator) changes from `pathname === '/email/compose'` to a compose-route match covering both `/campaigns/new` and `/campaigns/:id/edit`.

## Backend — unified campaign list

`GET /campaigns/history` keeps its URL. Renaming it would be a breaking contract change that `pnpm contracts:compat-check` rejects, and the URL is not user-visible; the concept is renamed in the web client (`api/history.ts` → `api/campaign-list.ts`) instead. Two optional query parameters are added:

- `includeDrafts?: boolean` — default `false`, so existing callers see no behaviour change.
- `scope?: 'mine' | 'all'` — mirrors the semantics `GET /campaigns` already implements.

`buildHistoryListSql` currently hardcodes `campaign.status <> 'draft'`. That becomes conditional:

| Caller | Condition added |
|---|---|
| `includeDrafts` not set | `campaign.status <> 'draft'` (unchanged) |
| `includeDrafts`, actor lacks `content:manage` | `campaign.status <> 'draft'` — silently downgraded |
| `includeDrafts`, has `content:manage`, not admin | `(campaign.status <> 'draft' OR campaign.created_by = :actorId)` |
| `includeDrafts`, admin | none |

The downgrade for viewers is deliberate: returning 403 would blank the whole list screen for a role that is entitled to see the non-draft rows. This mirrors how the list already hides rows a caller may not see rather than failing the request.

**This changes the permission semantics of an existing endpoint and therefore requires an ADR** before implementation, per `AGENTS.md` §2. The ADR records: the endpoint's audience widens from "send history" to "all campaigns"; draft visibility remains gated on `content:manage` plus ownership; no existing caller's results change.

## Backend — `POST /campaigns/bulk`

Synchronous, not a background job. The existing `bulk_job` / `bulk_job_row` machinery is recipient-shaped (`bulk_job_row.recipient_id` is a hard uuid column and the worker only understands recipient actions), and campaign selections are bounded by what is on screen — tens of rows, not thousands. Reusing that framework would cost a migration on live data, a worker change and a polling UI for an operation that completes in under a second.

```
POST /campaigns/bulk
{ "action": "delete" | "duplicate" | "cancel", "campaignIds": ["…"] }   // max 100

200
{
  "results": [{ "campaignId": "…", "outcome": "succeeded" | "failed" | "skipped",
                "code": "…", "message": "…" }],
  "succeeded": 2, "failed": 1, "skipped": 2
}
```

Each campaign is processed in its own transaction; one failure never aborts the rest. State preconditions are enforced server-side and reported per row:

| Action | Applies to | Otherwise |
|---|---|---|
| `delete` | `status = 'draft'` | `skipped`, `CAMPAIGN_NOT_DRAFT` |
| `cancel` | `scheduled`, `queued`, `sending` | `skipped`, `CAMPAIGN_NOT_CANCELLABLE` |
| `duplicate` | any status — always produces a new draft | — |

Permissions differ by action (`content:manage` for `delete`/`duplicate`, `campaign:manage` for `cancel`), so the check lives in the service, not in the decorator-based `PermissionGuard`.

Two accepted trade-offs, both to be stated in the endpoint's doc comment so they are not rediscovered as bugs:

- **No `If-Match`.** N version numbers cannot travel in one request, so bulk `delete` loses the optimistic-concurrency guard that single-row delete has. A row whose version moved returns `failed` with `CAMPAIGN_VERSION_CONFLICT`, using the version read inside its own transaction.
- **No idempotency key.** The UI disables the action button while the request is in flight, which is the only realistic double-submit path for a synchronous call.

## Web — campaign list screen

`CampaignListScreen` is `HistoryScreen` extended, not a rewrite: the table, search debounce, filter dialog, countdown and resend flow all carry over.

### Toolbar

Search box, then a single `Bộ lọc` button with its active count. **There is no status chip strip.** An earlier revision of the mockup had one; it was removed because it is a second input bound to the same `query.status` field the filter dialog already owns (`HistoryFilterDialog.tsx:44`), and because campaigns have 12 statuses — a chip row can never be the complete control, so it would permanently be a partial duplicate of the dialog.

Directly beneath the toolbar sits a row of **active-filter chips**, which are output rather than input: each chip names one active filter and removes it when clicked (`Trạng thái: Bản nháp ×`, `Từ 01/08/2026 ×`), followed by a `Xóa bộ lọc` link. The row is absent when no filter is set. New filter dimensions added later appear here automatically without growing the toolbar. This needs new CSS (`.active-filters`, `.active-filter-chip`, `.active-filter-clear`) — the mockup carries a working version built from existing tokens.

Two pre-existing defects in `HistoryFilterDialog` are fixed as part of this work, since the campaign list makes them reachable in a way they were not before:

- Its `STATUS_OPTIONS` lists 6 of the 12 campaign statuses. `draft`, `blocked`, `missed`, `queued`, `validating` and `paused` are missing, so those campaigns cannot be filtered for at all.
- The options are radios with no "all" choice, so a chosen status cannot be cleared except via `Đặt lại`. Add an explicit `Tất cả trạng thái` option.

### Table and selection

A checkbox column leads each row, with a select-all checkbox in the header — the same markup and classes `RecipientsScreen` already uses (`is-selected` row class, header checkbox, `.recipient-bulk-bar`). The bulk bar's class is generalised so both screens share it rather than campaigns getting a near-copy.

Clicking a row navigates; clicking the checkbox does not (`stopPropagation`). The destination depends on status — a draft has no send history to look at:

```
draft            → /campaigns/:id/edit
everything else  → /campaigns/:id
```

Draft rows show no send-progress bar. The `.send-progress.scheduled` style forces a full-width barber-pole meaning "waiting to send", which is wrong for a campaign that has not been scheduled at all; drafts instead show completeness as text (`Hoàn tất 68% · còn thiếu template`).

Viewers see no checkbox column at all, and no draft rows.

### Bulk actions and their results

The bulk bar appears once at least one row is selected, offering `Nhân bản`, `Dừng gửi` and `Xóa`. An action is enabled only when it is valid for **every** selected row — selecting three drafts leaves `Dừng gửi` disabled.

**There is no separate result screen.** An earlier mockup had one; the user correctly identified it as the same list rendered twice. Instead the list itself reports the outcome:

- the list reloads, so succeeded rows simply leave the table;
- rows that did **not** succeed stay selected, so the selection is exactly the retry set;
- each of those rows shows its reason in place of the email-subject subtitle (`Bỏ qua: đang gửi, không thể xóa.`);
- the bulk bar becomes a summary with a retry action (`Đã xóa 2 chiến dịch. 3 chiến dịch không xử lý được…` / `Thử lại 3 chiến dịch`);
- reasons clear on deselect or on the next action.

The reason is the one thing filtering cannot supply: a filter shows that a campaign is still present, never why the delete was refused.

**Reason strings must be short single lines.** Building the mockup showed that a full sentence wraps, widens the name column and pushes the rest of the table out of alignment. Reasons are mapped from the response `code` to a fixed short Vietnamese string in the client; the server's `message` is never rendered directly into the cell.

### Pure units

This codebase has no React component-testing library, so component wiring is verified by typecheck, the `ARCH-NO-ORPHANS` architecture test and a manual browser pass, while logic is extracted into pure modules with Vitest tests — the pattern every prior screen follows.

| Module | Responsibility |
|---|---|
| `campaign-selection.ts` | toggle, select-all, clear; `availableBulkActions(rows, selectedIds)` |
| `bulk-outcome.ts` | response → summary sentence, per-row reason strings, retry set |
| `campaign-row-target.ts` | status → route |
| `active-filters.ts` | query object → chip list; chip removal → next query |
| `page-meta.ts` | `resolvePageMeta(pathname)` |

## Web — campaign detail

`CampaignProgressDrawer` becomes `CampaignDetailScreen` at `/campaigns/:id`. Its content is unchanged — progress tiles, meta rows, per-recipient delivery table, export, pause/resume.

Two fixes come with the move:

- Its `Quay lại` link points at `/email/compose`, so "back" currently lands in the composer instead of the list. It becomes `← Quay lại danh sách chiến dịch` pointing at `/campaigns`.
- The page `<h1>` is empty here today (see "Page titles"); with `resolvePageMeta` the campaign name appears.

`/campaigns/:id` for a campaign whose status is `draft` redirects to `/campaigns/:id/edit`.

The whole `screens/history/` directory moves to `screens/campaigns/`, keeping `HistoryFilterDialog`, `ResendConfirmDialog`, `history-countdown.ts`, `campaign-realtime.ts`, `eta-format.ts` and `recipient-delivery.ts` and their existing tests.

## File structure

**Create**
- `apps/api/src/campaigns/dto/bulk.dto.ts`, plus bulk handling in `campaigns.controller.ts` / `campaigns.service.ts` and its service test
- `apps/web/src/screens/campaigns/CampaignListScreen.tsx`
- `apps/web/src/screens/campaigns/campaign-selection.ts` + test
- `apps/web/src/screens/campaigns/bulk-outcome.ts` + test
- `apps/web/src/screens/campaigns/campaign-row-target.ts` + test
- `apps/web/src/screens/campaigns/active-filters.ts` + test
- `apps/web/src/app/page-meta.ts` + test
- `docs/adr/adr-034-campaign-list-draft-visibility.md` — the permission-semantics change above

**Move**
- `apps/web/src/screens/history/*` → `apps/web/src/screens/campaigns/*`
- `CampaignProgressDrawer.tsx` → `CampaignDetailScreen.tsx`
- `apps/web/src/screens/drafts/DraftsScreen.tsx` → deleted; its rename/duplicate/delete overlay logic folds into the list's row menu and bulk actions

**Modify**
- `apps/api/src/campaigns/history-query.ts`, `dto/history.dto.ts`, `campaigns.service.ts`, `campaigns.controller.ts`
- `contracts/openapi.yaml` (additive) and regenerated `@eow/contracts`
- `apps/web/src/app/nav.ts`, `AppRoutes.tsx`, `AppShell.tsx`
- `apps/web/src/api/history.ts` → renamed to `api/campaign-list.ts`, with `includeDrafts`/`scope` support
- `apps/web/src/screens/compose/ComposeDraftScreen.tsx` — path param instead of query param
- `apps/web/src/app/globals.css` — active-filter chips; generalise the bulk-bar class
- `apps/web/e2e/auth.spec.ts:29-30`, `rbac.spec.ts:37-51`, `visual-capture.spec.ts` route literals

`ARCH-NO-ORPHANS` requires every production web module to be reachable from `main.tsx`; the new modules are reachable through the screens that import them, but re-run that test after the move.

## Required states

Per `ui-source-contract.yaml`, the list and detail screens each cover loading, empty, error, success, permission_denied and reconnecting. Two additions specific to this work: the **partial-failure** state described above, and the **viewer** variant of the list (no checkbox column, no draft rows).

## Verification

`pnpm check` — not bare `pnpm test`, which fails two API boot tests without a prior build. Compare the suite's test and skip counts against the previous run, not just the exit code. `pnpm contracts:compat-check` must pass on the additive OpenAPI change. Manual browser pass at 1440 / 768 / 390 against the seeded admin account.

## Out of scope

- **The composer.** Preview, content editing, HTML view and variable insertion are a separate spec. The `editor-shell` placeholder, the single-tab `panel-switch`, the non-clickable variable rows and the two permanently disabled `Gửi thử` / `Gửi ngay` buttons in `AppShell`'s page header all belong to that work and are left untouched here.
- **Bulk "Tải báo cáo".** It would spawn N asynchronous export jobs producing N download links — a different mechanism from the three state-changing actions, dragging in a job-management surface. Export stays available per campaign from the detail screen.
- **Dark mode review.** The mockup is light-only, but it uses the real stylesheet, so the dark palette follows from existing tokens.
