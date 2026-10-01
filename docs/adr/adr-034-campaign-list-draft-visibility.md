# ADR-034: Draft visibility on the campaign list endpoint

Status: Accepted

Extends: ADR-029 and the campaign list/history split introduced at M4-S1 and M6-S3. No
prior ADR is superseded — snapshot semantics, delivery state and the frozen recipient
envelope are untouched.

## Context

`GET /campaigns/history` was built as a send-history feed and hardcodes
`campaign.status <> 'draft'` (`history-query.ts`). Its sibling `GET /campaigns` covers
exactly the complement, `campaign.status = 'draft'` (`campaigns.repository.ts`). The two
queries partition one entity, and the split existed only because the UI had two separate
destinations for it: a drafts list and a send-history list.

The Chiến dịch restructure removes that split. One sidebar entry now opens one campaign
list covering the whole lifecycle, so a single endpoint has to serve every status.

`GET /campaigns` cannot take that role. It is guarded by `content:manage`, which the
viewer role does not hold, and it paginates by `limit` alone while history uses keyset
cursors. Merging the two client-side would break pagination outright: two sources with
two different cursor schemes cannot be interleaved into one ordered page.

## Decision

`GET /campaigns/history` accepts two new optional query parameters, `includeDrafts`
(default `false`) and `scope`.

Draft rows are returned only when the caller holds `content:manage`. A caller without it
is **silently downgraded** to the previous non-draft result rather than refused: a 403
would blank a list the caller is otherwise entitled to read, and the viewer role's whole
purpose is reading that list.

A caller who is not an admin with `settings:manage` sees only drafts they created. The
SQL predicate mirrors `CampaignsService.assertDraftAccess` and `canManageAllDrafts`
exactly — admin-role *and* `settings:manage`, not role alone — so the list can never
surface a draft that a direct `GET /campaigns/:id` would refuse. `scope=mine` narrows an
admin to their own drafts, matching the semantics `GET /campaigns` already implements.

| Caller | Draft rows returned |
| --- | --- |
| `includeDrafts` not set | none (unchanged behaviour) |
| lacks `content:manage` | none |
| has `content:manage`, not admin-with-`settings:manage` | own drafts only |
| admin with `settings:manage` | all drafts, or own drafts under `scope=mine` |

The endpoint keeps its URL. Renaming it to `/campaigns/list` would break the published
contract for no user-visible gain, since the URL never appears in the interface. The
concept is renamed on the web client instead: `api/history.ts` → `api/campaign-list.ts`.

## Consequences

- The endpoint's audience widens from "send history" to "all campaigns". Its
  `CAMPAIGN_READ` guard is unchanged; `content:manage` is checked inside the query.
- No existing caller's results change, because `includeDrafts` defaults to `false`. The
  OpenAPI change is additive and passes `contracts:compat-check`.
- Draft visibility now has two enforcement points — the direct route and this list query
  — that must stay in agreement. `history-query.test.ts` pins the list side against the
  same rule the service applies, so a change to one without the other fails a test rather
  than leaking a draft.
- The silent downgrade means a viewer passing `includeDrafts=true` gets a 200 with fewer
  rows than asked for. This is deliberate and is the only place in the API where a
  permission shortfall narrows a result instead of failing the request; it is safe here
  because the parameter widens a read rather than requesting a specific resource.
