# M6-S2 Notification Centre Implementation Plan

Node: `M6-S2-notification-center` · Depends on: `M1-GATE` (closed) — **independent of M4 and M5**.
Owns rules: **all 16 `BR-NOT-*`** (`catalog/notification-rules.json`, not `ba-rules.json`)
Overlay: `notifications` (popover in `UI-SHELL-001`) · Reserved: migration **021**,
`DEC-066…070`, `D-56…60`, test IDs **`TC-NOT-001…016`**

Read [`PARALLEL-EXECUTION-PROTOCOL.md`](PARALLEL-EXECUTION-PROTOCOL.md) first.

---

## 1. Outcome, and the one structural fact that shapes everything

`apps/api/src/notifications/notifications.service.ts` is still the original starter mock: a
hardcoded in-memory array with one fake item, `list()` and `read()`, no tenant, no user, no
database. `notification` and `user_notification` tables have existed since `001_initial.sql` and
have never been used. This node replaces the mock with real durable persistence.

### The unusual thing about this node: it has no test cases

`traceability-plan.yaml` says it outright — the 16 `BR-NOT-*` rules have **no `TC-NOT-*` entries**
in `catalog/test-cases.json`. Every other slice mapped to pre-authored cases. Here the tests must
be **authored in-run** and registered with `source: authored-in-run`, taking reserved IDs
`TC-NOT-001…016` (one per rule, extending where a rule needs several).

That has a consequence worth stating: nobody wrote acceptance text for these, so the rule text in
`catalog/notification-rules.json` **is** the specification. Quote it in each test's name.

### The 16 rules, grouped by what they actually demand

| Group | Rules | Demand |
|-------|-------|--------|
| Durability | BR-NOT-001, 012 | Durable business events in PostgreSQL; after reconnect/login the **unread API is authoritative** and fills what the socket missed. A toast is never the only record of a failure needing action. |
| Recipients & authz | BR-NOT-002, 003, 008 | Explicit per-user recipients within one tenant, resolved by role/ownership/subscription/preference. Deep links **recheck permission at open time**; payload must not reveal what the user can no longer access. Optional categories mutable; security/critical ones not. |
| State | BR-NOT-004, 005 | Read state per user, synchronised across devices, mark-one and mark-all **idempotent**. Action state (`open`/`resolved`/`expired`) independent of read state. |
| Integrity | BR-NOT-006, 011 | One notification per (source event, recipient) — repeated webhooks cannot inflate unread. High-volume similar events batch into one summary within a window. |
| Presentation | BR-NOT-007, 010, 015 | Severity `info|success|warning|critical` controls icon/colour only, never replaces event type. Stable deep-link route + resource id, with a safe state for deleted targets. Store **message key + structured params**, not only rendered text. |
| Operations | BR-NOT-009, 013, 014, 016 | In-app channel for MVP, email opt-in, channel failure never rolls back the business transaction. Configurable retention/PII minimisation; deleting a notification never deletes audit. Explicit trigger catalogue. Metrics with ids and no unmasked PII. |

### Hard non-goals

- **No campaign/send triggers wired.** BR-NOT-014's catalogue names campaign completion/failure,
  schedule dispatch/miss, import/bulk completion, sender failure, quota thresholds. Of those, only
  import/bulk exist today (M2-S4); campaign send is M5, quota is M7. Build the **trigger
  registry + the triggers whose source events already exist**, and record the rest as
  registered-but-unwired with their owning node. Do not fabricate a campaign event to claim the rule.
- **No email channel delivery.** BR-NOT-009 makes in-app the MVP channel and email opt-in *per
  policy*; the actual outbound email path is M5. Model the channel, do not send.
- **No history screen.** `UI-HIS-001/002` are M6-S3.
- **No realtime progress.** M6-S1 owns `campaign.progress.*`; this node owns the notification
  channel only, and must not couple to progress aggregation.

---

## 2. Acceptance criteria

| # | Criterion | Rule | Proof |
|---|-----------|------|-------|
| A1 | A notification persists and survives a process restart, scoped to one tenant | BR-NOT-001 | integration |
| A2 | Recipients resolve to explicit users by role/ownership; a user outside the audience never sees it | BR-NOT-002 | integration |
| A3 | The same `(source_event_id, user_id)` inserted twice creates one row — proven by a real unique constraint, not application logic alone | BR-NOT-006 | integration + SQL |
| A4 | `markRead` twice, and `markAllRead` twice, leave identical state and identical unread count | BR-NOT-004 | integration |
| A5 | Two sessions for one user observe the same read state | BR-NOT-004 | integration |
| A6 | Action state transitions independently of read state (a read-but-open item stays open) | BR-NOT-005 | integration |
| A7 | Opening a deep link as a user whose permission was revoked returns the safe state, not the payload | BR-NOT-003 | integration |
| A8 | A deleted deep-link target renders the safe explanatory state | BR-NOT-010 | e2e |
| A9 | The unread API returns everything created while a socket was disconnected | BR-NOT-012 | integration |
| A10 | A muted optional category is suppressed; a critical/security category is **not** muteable | BR-NOT-008 | integration |
| A11 | N similar events inside the window produce one summary notification | BR-NOT-011 | integration |
| A12 | Stored rows carry a message key + params, and the rendered string is derivable from them | BR-NOT-015 | unit + integration |
| A13 | A channel failure leaves the business transaction committed | BR-NOT-009 | integration |
| A14 | Deleting a notification leaves its `audit_log` rows intact | BR-NOT-013 | integration |
| A15 | Metrics/logs carry notification and event ids and **no** unmasked recipient PII | BR-NOT-016 | integration (assert on emitted payload) |
| A16 | Severity affects only presentation — same type at two severities behaves identically | BR-NOT-007 | unit |
| A17 | The notifications popover shows real unread counts, filters, and mark-read against the real API | BR-NOT-001/004 | e2e + **visual (Claude)** |

---

## 3. Locked design

### 3.1 Migration 021 — extend, never recreate

`notification` (`id`, `tenant_id`, `type`, `severity`, `title`, `body`, `entity_type`,
`entity_id`, `created_at`) and `user_notification` (`tenant_id`, `notification_id`, `user_id`,
`read_at`, `archived_at`, PK on `(notification_id, user_id)`) are **published in `001_initial.sql`
and are never edited**. 021 adds, all with defaults:

- `notification.source_event_id` — the dedup key (BR-NOT-006), plus
  `UNIQUE (tenant_id, source_event_id)`; pair it with the per-user uniqueness the existing PK
  already gives, so A3 is enforced by the database, not by a service check.
- `notification.message_key` + `notification.params_json` (BR-NOT-015). `title`/`body` stay as the
  server-rendered fallback so existing rows and the popover keep working.
- `notification.deep_link_route` (BR-NOT-010) — a route + resource id, not a URL string.
- `notification.group_key` + a window column (BR-NOT-011 batching).
- `notification.expires_at` / retention marker (BR-NOT-013).
- `user_notification.action_state` CHECK `('open','resolved','expired')` (BR-NOT-005), independent
  of `read_at`.
- A `notification_preference` table for BR-NOT-008, carrying which categories are muteable — the
  non-muteable set must be data or code, not a comment.

Both existing tables already have RLS from `012_rls.sql`; a **new** table needs its own policy and
`GRANT ... TO eow_app` (copy `016_template_test_sends.sql`; M3-S3 shipped a migration with zero
grants and owner-connected tests could not see it). Add an `eow_app`-connected test.

### 3.2 Delivery is a hint; the API is the truth

`realtime.gateway.ts` already exposes `publish(room, eventType, envelope)` and emits
`rt.connection.ready` on connect. Notifications ride that, but AGENTS.md §2 is unambiguous:

> Never make a UI socket payload the only copy of business state.

So: persist first, then publish. The popover's unread count comes from the API on mount and on
reconnect; the socket only prompts a refetch or applies a targeted update. A17 must be provable
with the socket disabled — that is A9.

### 3.3 Trigger catalogue (BR-NOT-014)

A registry mapping source event → notification type, severity, recipient-resolution rule, deep
link, and whether it is muteable. Wire the triggers whose source events exist today
(`import.completed`, `bulk_update.completed`, and their failure counterparts — all already emitted
by M2-S4). Register the rest with their owning node named. The registry is the artifact that makes
"explicit trigger definitions" checkable; a future node adding a trigger edits data, not plumbing.

### 3.4 HTTP surface (reserved prefix `/notifications*`)

`GET /notifications` and `PUT /notifications/{id}/read` **already exist** in `contracts/openapi.yaml`
with real operation ids (`listNotifications`, `markNotificationRead`) and are served by the mock.
Give them real schemas and add, additively:

| Method | Path | operationId |
|--------|------|-------------|
| GET | `/notifications` (filter `unread`, cursor, limit) | `listNotifications` (existing) |
| PUT | `/notifications/{notificationId}/read` | `markNotificationRead` (existing) |
| PUT | `/notifications/read-all` | `markAllNotificationsRead` |
| PATCH | `/notifications/{notificationId}/action-state` | `updateNotificationActionState` |
| GET/PUT | `/notification-preferences` | `getNotificationPreferences` / `updateNotificationPreferences` |

Permission stays `notification:read` for reads (all roles hold it per `004_rbac.sql`); mutations
act only on **the caller's own** `user_notification` rows — user scoping is in addition to tenant
scoping, and A2 must prove one user cannot mark another's notification read.

Bound the list (limit default 50, max 100) from the first commit. Unbounded list endpoints have
already been a real defect in this run twice.

---

## 4. Checkpoints

Each ends with a commit and an inbox section. Codex writes none of the four shared artifacts.

**CP1 — migration 021 + entities**, applied, idempotent re-run, `eow_app` grant/RLS test, and a
direct SQL test that the dedup unique constraint rejects a duplicate (A3).
**CP2 — pure units, RED first.** Message key/param rendering (A12), severity-is-presentation-only
(A16), recipient resolution, batching window (A11), muteable-category policy (A10).
**CP3 — durable service, RED first.** Replace the mock: create/list/mark-read/mark-all/action-state
against real PostgreSQL, tenant **and** user scoped. A1-A7, A9, A13, A14 here.
**CP4 — trigger registry + the two wireable triggers** (import/bulk), plus metrics assertions (A15).
**CP5 — contract.** One additive OpenAPI edit, committed immediately (protocol §3.3). Note the two
pre-existing operations gaining real schemas — additive, and `openapi-compat-check` must confirm it.
**CP6 — web.** The `notifications` popover from the handoff's real DOM (`action-overlays.tsx` L94-98:
`.notification-center` with a `role="tablist"` Tất cả / Chưa đọc filter and per-item rows) wired to
the real API, plus the shell's bell badge showing a real unread count. This node is the **only** one
permitted to edit `AppShell.tsx` (protocol §3.4); M4-S1 already added `Outlet` save-state context
there — extend it, do not replace it.
**CP7 — VISUAL HANDOFF.** Capture block as a patch proposal in the inbox; do not run or judge it; stop.
**CP8 — Claude.** Captures, image inspection, artifact merge, **authoring `TC-NOT-001…016` into the
registry with `source: authored-in-run`**, independent re-verification, close.

---

## 5. Risks

| Risk | Mitigation |
|------|-----------|
| Socket payload becomes the only copy of state | Persist-then-publish; A9 proves the API alone is sufficient. |
| Dedup enforced only in application code | Real `UNIQUE` constraint; A3 tests it via raw SQL. |
| A user marks another user's notification read | Mutations scoped by `user_id` from the session, never from the body; A2 proves it. |
| Claiming BR-NOT-014 with unwired triggers | Registry records owner nodes; only existing source events are wired, and the inbox says which. |
| PII in metrics | A15 asserts on the emitted payload, not on intent. |
| 16 rules closed on thin evidence | One authored `TC-NOT-*` per rule, named with the rule's own text; Claude re-verifies before any rule flips to `closed`. |
