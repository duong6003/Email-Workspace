# M6-S3 History & Recovery Implementation Plan

> **For agentic workers:** execute this plan checkpoint-by-checkpoint under
> AGENTS.md §2 (evidence precedes status, commit at every checkpoint, compare
> test *and skip* counts against the CP0 baseline). Use
> `superpowers:test-driven-development` (RED before GREEN at every checkpoint)
> and `superpowers:systematic-debugging` on any red. This plan is the spec; do
> not re-derive it from `state.json`. Steps use checkbox (`- [ ]`) syntax.

Node: `M6-S3-history-recovery` · Depends on: `M6-S1-realtime-progress` (completed 2026-08-18, commit `9fc6460`, **not pushed** — `origin/main` is still at `7d2eec0`)
Owns rules: **BR-HIS-001, BR-HIS-003, BR-HIS-004, BR-HIS-005, BR-HIS-007, BR-SEND-009** (6 — re-confirmed directly against `traceability.csv`, all six `not_started`)
Split out of this node: **BR-HIS-006** (retention/purge, P2, release `P1`) → new node `M6-S4-history-retention`, created in CP1. See §0(i).
Test cases: **TC-HIS-001, TC-HIS-003, TC-HIS-004, TC-HIS-005, TC-HIS-007, TC-HIS-009, TC-SEC-017, TC-SEND-009, TC-SEND-019**
Screens: **UI-HIS-001** (`Send history`, route `/history`) — the approved `History` component at `design-reference/ui-handoff-v2/source/app/page.tsx:199`, plus the approved `historyFilter`, `resendConfirm` and `resendSuccess` overlays at `design-reference/ui-handoff-v2/source/app/action-overlays.tsx:216-229`. **UI-HIS-002 already exists** (M6-S1) and is only extended, never rebuilt.
Reserved: migration **029**, **ADR-027**, decisions **DEC-132…DEC-141**, defects **D-122…D-126**
Solo execution.

**Goal:** Turn `/history` from a `ComingSoon` placeholder into the real send-history surface — a server-paginated, server-filtered list; a resend that creates a *new* execution over only the previously failed recipients and records its parent; a background CSV export gated by a new `history:export` permission, with a stored artifact, an expiry and a per-download audit row; and a pause/resume that takes effect inside ten seconds.

**Architecture:** No new counting logic. The list reuses M6-S1's stored `campaign_execution` summary columns (028) for per-row progress and reuses `getCampaignProgress` for drill-down. Resend follows the schema's own already-published grain: a *new* `campaign_snapshot` supersedes the parent and carries only the parent's failed recipients, so the existing `UNIQUE (campaign_id, snapshot_id)` idempotency key, the existing `readProgressFacts` snapshot-scoped counting, and `run.ts`'s existing live-snapshot join all keep working untouched. Export is a new `export_job` table + BullMQ queue modelled directly on `bulk_job`/`bulk-processor.ts`, finally wiring the long-declared `export.completed` channel. Pause is a new pair of state-machine edges plus a re-check *inside* the send loop, because the scheduler tick is far too slow to satisfy the rule on its own.

**Tech Stack:** NestJS + Zod DTOs, TypeORM `EntityManager` (api) / `pg.PoolClient` (worker), BullMQ + ioredis, PostgreSQL with RLS, React + TanStack Query, Vitest, Playwright.

---

## 0. Read this before touching anything

Every finding below was verified directly against the working tree at `9fc6460`
during planning. Nine are constraints that decide the design; three are records
this node is the first able to correct. **None may be re-litigated mid-checkpoint.**

### (a) `parent_execution_id` does not exist anywhere. Confirmed, not assumed.

The M6-S3 handoff guessed this ("unlikely; migration 026 predates this
requirement"). It is now verified: a repository-wide grep for `parent_execution`
across `.sql`, `.ts`, `.yaml` and `.json` returns **zero matches**.
`026_campaign_execution.sql:48-64` creates `campaign_execution` with
`id, tenant_id, campaign_id, snapshot_id, status, correlation_id, batch_size,
max_attempts, sender_config_id, failure_code, started_at, finished_at` and no
parent reference of any kind. BR-HIS-005's *"retry tạo execution mới có liên kết
parent"* therefore needs migration **029**. There is no `019` in
`database/migrations/`, so `028_progress_counters.sql` is genuinely the highest
and `029` is genuinely next.

### (b) `apps/worker/src/main.ts` is clean — there is no third fabricated-success stub.

The handoff correctly told you to grep before assuming a clean slate (D-87,
D-115). The grep was done. `apps/worker/src/main.ts` today contains exactly four
`case` arms — `campaign-misfire-scan`, `campaign-send-scan`, `outbox-publish`,
`progress-reconcile` — each performing real work behind the narrow
`OUTBOX_DATABASE_URL` guard, and a `default` that throws
``new Error(`Unknown job ${job.name}`)``. Both prior stub classes were removed in
place with comments recording why. **There is no `'export'`, `'purge'`,
`'resend'` or similar arm to un-fabricate.** Consequence for this plan: the
export queue in CP8 is genuinely new registration work (a new `Worker` binding
next to `importWorker`/`bulkWorker`), not a body dropped into an existing arm.
**Record as DEC-132** so the next agent does not re-run this grep.

### (c) Resend cannot reuse the parent snapshot. Four published constraints forbid it.

This was the handoff's open question 1. It is answered by the schema, not by
preference:

1. **`campaign_execution UNIQUE (campaign_id, snapshot_id)`**
   (`026_campaign_execution.sql:64`), whose own comment calls it *"the DAG's
   idempotency key … re-running `freeze` for the same snapshot cannot create a
   second execution, so no distributed lock is needed."* A second execution
   against the same snapshot is **not insertable**. Relaxing this would delete
   the reason M5-S3 needs no distributed lock.
2. **`readProgressFacts` counts by `snapshot_id`, not `execution_id`**
   (`apps/api/src/campaigns/progress-snapshot.ts:36` and its worker twin). Two
   executions sharing one snapshot would report **one merged set of counts**,
   silently breaking BR-HIS-005's own *"summary nêu rõ counts"*.
3. **`uq_campaign_recipient_snapshot` is `(snapshot_id, recipient_id)`**
   (`022_campaign_snapshot.sql:42`), and its comment says exactly why:
   *"Per-snapshot, not per-campaign: a refreshed snapshot re-freezes the same
   people."* A new snapshot may legally re-freeze the parent's failed
   recipients. A reused snapshot may not.
4. **`run.ts`'s `currentExecutionId` already joins
   `campaign_snapshot cs ON cs.superseded_at IS NULL`**
   (`apps/worker/src/campaign-send/run.ts:110-113`). Once a resend supersedes the
   parent snapshot and creates a new live one, the existing worker scan resolves
   to the resend execution **with no change to `run.ts` at all**.

So the model is: **resend supersedes the parent snapshot, creates a child
snapshot carrying only the parent's failed recipients, and creates a child
execution linked to the parent.** This is the only model the published schema
admits, and it costs one migration rather than a constraint rollback.
`aggregate.ts` already scopes by `execution_id`
(`apps/worker/src/campaign-send/aggregate.ts:47`) and needs no change;
`partition.ts` claims by `campaign_id AND status = 'pending'` with no execution
scope (`partition.ts:57-60`), which is safe here only because every parent row is
already terminal when a resend is permitted — CP6 enforces that precondition
explicitly rather than relying on it. **Record as DEC-133.**

### (d) There is no file storage in this codebase, and no expiry mechanism.

This was the handoff's suggestion to "reuse whatever file-storage mechanism
import already uses". There is none. `GET /bulk-jobs/:id/result-file`
(`apps/api/src/jobs/bulk-jobs.controller.ts:55`) **re-renders CSV on demand**
from database rows via `renderBulkExportCsv` (`apps/api/src/jobs/job-artifacts.ts:21`)
and stores no bytes. `import_job.result_file_ref` (`009_import_job_artifacts.sql`)
is a `text` column that **nothing in the codebase ever writes**. No expiry and no
download audit exists anywhere. BR-HIS-007's *"file có expiry và audit download"*
is therefore genuinely new: CP7-CP9 add an `export_job` row that stores the
rendered artifact, an `expires_at`, and one `audit_log` row per download.
**Record as D-122** (the stale `result_file_ref` column, dead since M2-S4 — noted,
not removed; it is published and out of this node's scope) and **DEC-134**.

### (e) No existing permission separates "read history" from "export history".

This was the handoff's open question 2. `apps/api/src/common/permissions.ts`
defines eight keys; `004_rbac.sql:66-87` seeds them and grants viewer exactly
`session:manage, campaign:read, notification:read`. The `/history` route already
requires `campaign:read`, which the viewer holds. So there is **no** existing key
that can express BR-HIS-007's *"Viewer không được export nếu thiếu quyền"* —
keying off `campaign:manage` would conflate "may send campaigns" with "may
extract recipient PII in bulk". Migration 029 seeds a new **`history:export`**
key granted to `admin` and `operator` only. Note that `004_rbac.sql:75-77` grants
admin *every* permission via an unfiltered cross join executed once at seed time;
**029 must grant the new key to admin explicitly** — it is not inherited.
`packages/architecture-tests/src/rbac-coverage.test.ts` must be extended in the
same checkpoint. **Record as DEC-135.**

### (f) Pause cannot be satisfied by the scan tick. It must be re-checked inside the send loop.

This was not among the handoff's four questions and is the most likely thing to
be got wrong. `apps/scheduler/src/main.ts:6` reads
`Math.max(5_000, Number(process.env.SCHEDULER_TICK_MS ?? 60_000))` — the default
tick is **60 seconds**. BR-SEND-009 requires *"Pause đạt hiệu lực trong 10 giây"*.
Setting `campaign.status = 'paused'` removes the campaign from
`queued_campaign_executions()` (`026:...` selects only
`status IN ('queued','validating','sending')`) and from `partition.ts`'s
precondition — but a batch **already claimed and mid-flight** inside
`sendClaimedBatch` would keep sending for up to a whole `batchSize` (default 100)
after the operator clicked pause. The pause check therefore goes **inside
`sendClaimedBatch`'s per-row loop** (`apps/worker/src/campaign-send/send.ts:123`),
re-reading campaign status on a bounded cadence. CP5 specifies the exact cadence
and its test. **Record as D-123** (the requirement is unmeetable by scan cadence
alone) **and DEC-136.**

### (g) `'paused'` is in both status vocabularies but has no edge in either state machine.

`018_campaign_status_values.sql` admits `'paused'` for `campaign.status` and
`026_campaign_execution.sql:53-55` admits it for `campaign_execution.status`, but
`LEGAL_CAMPAIGN_EXECUTION_EDGES` in **both**
`apps/api/src/campaigns/send-state-machine.ts:15-24` and its worker twin
`apps/worker/src/campaign-send/send-state-machine.ts` contains no edge into or
out of `'paused'` — exactly as DEC-097 says. CP4 adds `sending->paused` and
`paused->sending` to both copies **in the same commit**; they are a deliberate
transliteration pair under the DEC-107/DEC-123 precedent, and diverging them is
the failure mode `packages/architecture-tests` exists to catch.

### (h) `'paused'` remains invisible to the live worker, so M6-S1's fixture trick still holds.

The handoff warns (D-118) that this host's live `worker`/`scheduler` containers
race host-run tests whose fixtures sit in `('queued','validating','sending')`,
and that M6-S1 worked around it by parking a fixture at
`campaign.status='paused'`. That trick survives this node: `paused` is still
absent from `queued_campaign_executions()`'s `WHERE`, so the live worker still
never picks such a fixture up. **Every long-running fixture this plan creates
uses `'paused'` for the same reason** — stated per-checkpoint rather than
discovered mid-run.

### (i) BR-HIS-006 is split out of this node by explicit user decision.

Six rules already carry one migration with three distinct concerns, an ADR, a new
queue, a new screen, a resend flow and a two-app state-machine change. BR-HIS-006
is **P2** and the only one of the seven whose `release` is `P1` rather than
`MVP` — it is a self-contained scheduled job. CP1 creates node
**`M6-S4-history-retention`** in `state.json` (`dependsOn:
["M6-S3-history-recovery"]`, `status: "pending"`), moves BR-HIS-006 to it, and
adds it to `M6-GATE.dependsOn`. `M6-GATE`'s success condition *"All 28 M6 rules
closed"* is **not** weakened — the gate simply gains a fourth dependency that
must close before it. **Record as DEC-137.**

### (j) `campaignListQuerySchema` cannot be stretched to carry BR-HIS-001.

`apps/api/src/campaigns/dto/campaign.dto.ts:72-75` is, in full:

```ts
export const campaignListQuerySchema = z.object({
  status: z.enum(campaignStatuses).optional().default('draft'),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
}).strict();
```

No cursor, no sort, no date/sender/creator filter, and a **`'draft'` default**
that is the opposite of what history wants. `GET /campaigns` is also guarded by
`CONTENT_MANAGE` (`campaigns.controller.ts:34`), which the viewer lacks — while
history must be viewer-readable under `CAMPAIGN_READ`. History gets its **own**
endpoint and its own schema; the drafts list is not touched. **DEC-138.**

### (k) BR-HIS-004's countdown needs a server clock, and the response is the cheapest place to put it.

*"countdown dùng server time"* means the client must not compute a countdown from
its own clock. Rather than add a `/time` endpoint, the history list response
carries a top-level `serverTime` ISO-8601 string, and the client computes every
countdown as an offset against it. The same response's per-row `progress` is
`null` for any campaign that has not started, which is the other half of the rule
(*"Không hiển thị progress gửi trước khi bắt đầu"*). **DEC-139.**

### (l) The approved handoff already specifies every screen affordance this node needs.

Do not design UI. `design-reference/ui-handoff-v2/source/app/page.tsx:199-230`
gives the `History` table (columns TIÊU ĐỀ / NGƯỜI NHẬN / THỜI GIAN / TIẾN ĐỘ /
TRẠNG THÁI / THAO TÁC), the `history-live-summary` strip, the search box, the
filter button, and a per-row `row-resend` button shown **only** when the row's
status is the error state. `action-overlays.tsx:216-229` gives `historyFilter`
(date presets + range, status checkboxes, sender-config select, result select),
`resendConfirm` (whose own copy — *"Chỉ gửi lại cho các địa chỉ thất bại ở lần
gửi trước"* and *"Không gửi lại cho 126 địa chỉ đã nhận email thành công"* —
independently confirms the design in §0(c)) and `resendSuccess`. The
`historyDetail` drawer's footer already carries **"Tạm dừng"** and **"Tải báo
cáo"** buttons; those are this node's pause and export entry points on
UI-HIS-002, which M6-S1 built but left inert.

---

## 1. What this slice turns from definition into fact

### The rules, in their own words

Read directly from `catalog/ba-rules.json`, not from any summary.

- **BR-HIS-001** (P1) — *statement:* "History hiển thị campaign name, subject, sender, created/scheduled/started/completed, status và progress." *acceptance:* "Sort mặc định mới nhất; filter theo status/date/sender/creator; server pagination."
- **BR-HIS-003** (P1) — *statement:* "Người dùng có thể lọc recipient theo message status và tải danh sách lỗi theo quyền." *acceptance:* "Export chạy background nếu lớn; dữ liệu PII theo RBAC."
- **BR-HIS-004** (P1) — *statement:* "Campaign đã lên lịch xuất hiện trong history với scheduled time/timezone và action sửa/hủy khi được phép." *acceptance:* "Không hiển thị progress gửi trước khi bắt đầu; countdown dùng server time."
- **BR-HIS-005** (P0) — *statement:* "Campaign có cả thành công và lỗi kết thúc partial_failed, không gộp thành failed toàn bộ." *acceptance:* "Summary và export nêu rõ counts/reasons; retry tạo execution mới có liên kết parent."
- **BR-HIS-007** (P1) — *statement:* "Export history/audience không bao gồm secret và tôn trọng field-level permission." *acceptance:* "Viewer không được export nếu thiếu quyền; file có expiry và audit download."
- **BR-SEND-009** (P1) — *statement:* "Operator có thể pause campaign đang sending; message đã submitted không thu hồi, message chưa queued dừng lại." *acceptance:* "Pause đạt hiệu lực trong 10 giây; resume tiếp tục phần còn lại, không gửi trùng."

Note BR-HIS-005's first half — *"Campaign có cả thành công và lỗi kết thúc
partial_failed, không gộp thành failed toàn bộ"* — is **already implemented and
correct**: `aggregate.ts:55-61` computes `failed` only when
`failed_count === actionable_count`, else `partial_failed` when `failed_count > 0`.
This node closes the rule's *second* half (summary counts/reasons + parent-linked
retry) and adds the test coverage the first half never received.

### Hard non-goals

- **No purge/retention job.** BR-HIS-006 is `M6-S4-history-retention` (§0(i)).
- **No rebuild of the progress drawer.** UI-HIS-002 exists; this node wires its
  two inert footer buttons and adds a drill-down filter. Nothing else.
- **No change to the counting logic.** `progress-math.ts`, `progress-snapshot.ts`
  and their worker twins are read and reused, never re-derived. If a checkpoint
  finds itself writing a third count implementation, it has gone wrong.
- **No relaxation of `UNIQUE (campaign_id, snapshot_id)`** (§0(c)).
- **No automatic resend.** Resend is operator-initiated only; a policy-driven
  auto-retry is out of scope and would need its own bound on repeated failure.
- **No new file/volume storage surface.** The artifact lives in a database
  column, so the one-command deployment contract is unchanged.
- **No push to `origin`.** `origin/main` is two nodes behind; pushing requires
  separate explicit confirmation in the session that does it.

---

## 2. Acceptance criteria

A rule may be flipped to `closed` in `traceability.csv` only when the evidence
below exists and has been re-run.

| Rule | Closes when |
|---|---|
| BR-HIS-001 | `GET /campaigns/history` returns newest-first by default; `status`, `dateFrom`, `dateTo`, `senderConfigId` and `createdBy` each provably narrow the result set in an integration test; a cursor round-trip returns the next page with no overlap and no gap; the `/history` screen renders real rows at 3 viewports. |
| BR-HIS-003 | Drill-down filters recipients by message status through the existing progress read path; an export whose row count exceeds `EXPORT_INLINE_MAX_ROWS` is queued to the worker rather than rendered inline; the exported CSV contains no `secret_ref`, no password hash and no session material. |
| BR-HIS-004 | A `scheduled` campaign appears in the list with its `scheduledAtUtc` **and** its original `scheduledTimezone`; its `progress` field is `null`, not `0`; the response carries `serverTime` and the rendered countdown is computed from it (proved by a test that moves the client clock and asserts the countdown does not move). |
| BR-HIS-005 | A campaign with mixed outcomes ends `partial_failed` (test added — the behaviour exists, the coverage does not); `POST /campaigns/:id/resend` creates a child snapshot + child execution whose `parent_execution_id` and `parent_snapshot_id` point at the parent; the child's recipient set equals exactly the parent's `failed` sendable recipients; the export/summary names per-status counts and `skipped_reason`/failure reasons. |
| BR-HIS-007 | A viewer receives `403` from both the export-create and the export-download routes; a non-viewer succeeds; a download past `expires_at` returns `410`; every successful download writes one `audit_log` row with action `history.export.downloaded`. |
| BR-SEND-009 | `POST /campaigns/:id/pause` moves a `sending` campaign to `paused` and the worker stops submitting **within 10 seconds** measured against a fixture larger than one batch; already-`submitted` rows are untouched; `POST /campaigns/:id/resume` returns it to `sending` and the run completes with **no recipient submitted twice** (asserted against `message_attempt`, which is append-only and therefore the only trustworthy witness). |

---

## 3. Locked design

### 3.1 Migration 029 — `029_history_recovery.sql`

Three concerns, one migration, in this order. Never edit 001-028.

```sql
-- M6-S3 -- resend lineage, background export artifacts and the export
-- permission (BR-HIS-005, BR-HIS-003, BR-HIS-007, ADR-027).

-- ---------------------------------------------------------------------------
-- (1) BR-HIS-005's "retry tao execution moi co lien ket parent". Nullable:
-- every execution that exists today is a root. The snapshot lineage is
-- carried too, because DEC-133 makes a resend a *new snapshot* -- without
-- parent_snapshot_id the superseded parent snapshot and its child are
-- related only by timestamp, which is not a key.
-- ---------------------------------------------------------------------------
ALTER TABLE campaign_execution
  ADD COLUMN IF NOT EXISTS parent_execution_id uuid REFERENCES campaign_execution(id),
  ADD COLUMN IF NOT EXISTS resend_generation integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT campaign_execution_resend_generation_nonnegative
    CHECK (resend_generation >= 0),
  ADD CONSTRAINT campaign_execution_parent_is_not_self
    CHECK (parent_execution_id IS NULL OR parent_execution_id <> id);

ALTER TABLE campaign_snapshot
  ADD COLUMN IF NOT EXISTS parent_snapshot_id uuid REFERENCES campaign_snapshot(id);

CREATE INDEX IF NOT EXISTS idx_campaign_execution_parent
  ON campaign_execution (tenant_id, parent_execution_id)
  WHERE parent_execution_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- (2) BR-HIS-003/BR-HIS-007's background export. Modelled on bulk_job
-- (008_import_bulk_jobs.sql:74) -- same status vocabulary shape, same
-- created_by/created_at/completed_at spine. artifact_bytes holds the rendered
-- CSV: DEC-134 -- there is no file storage in this system and adding a volume
-- for a P1 rule would change the one-command deployment contract.
-- ---------------------------------------------------------------------------
CREATE TABLE export_job (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  campaign_id uuid NOT NULL REFERENCES campaign(id),
  execution_id uuid REFERENCES campaign_execution(id),
  kind text NOT NULL CHECK (kind IN ('campaign_recipients', 'campaign_failures')),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  status_filter text[] NOT NULL DEFAULT '{}',
  row_count integer NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  artifact_bytes bytea,
  artifact_filename text,
  failure_code text,
  expires_at timestamptz,
  downloaded_count integer NOT NULL DEFAULT 0 CHECK (downloaded_count >= 0),
  created_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  CONSTRAINT export_job_completed_has_artifact CHECK (
    status <> 'completed'
    OR (artifact_bytes IS NOT NULL AND artifact_filename IS NOT NULL AND expires_at IS NOT NULL)
  )
);
CREATE INDEX idx_export_job_tenant_created ON export_job (tenant_id, created_at DESC);
CREATE INDEX idx_export_job_campaign ON export_job (tenant_id, campaign_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE ON TABLE export_job TO eow_app;
ALTER TABLE export_job ENABLE ROW LEVEL SECURITY;
ALTER TABLE export_job FORCE ROW LEVEL SECURITY;
CREATE POLICY export_job_tenant_isolation ON export_job
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

-- The worker's narrow cross-tenant boundary, in the exact shape 013/025/026/028
-- already established: a fixed SECURITY DEFINER query returning only the ids the
-- caller needs, so eow_app stays NOBYPASSRLS.
CREATE OR REPLACE FUNCTION queued_export_jobs(p_limit integer)
RETURNS TABLE (id uuid, tenant_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT export_job.id, export_job.tenant_id
  FROM export_job
  WHERE export_job.status = 'queued'
  ORDER BY export_job.created_at
  LIMIT LEAST(GREATEST(p_limit, 1), 1000)
$$;
REVOKE ALL ON FUNCTION queued_export_jobs(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION queued_export_jobs(integer) TO eow_app;

-- ---------------------------------------------------------------------------
-- (3) BR-HIS-007's "Viewer khong duoc export neu thieu quyen". DEC-135: no
-- existing key carries this distinction, and 004_rbac.sql's admin grant was an
-- unfiltered cross join executed once at seed time -- admin does NOT inherit a
-- later key, so it is granted explicitly here alongside operator.
-- ---------------------------------------------------------------------------
INSERT INTO permission (key, description) VALUES
  ('history:export', 'Export send history and recipient-level results')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permission (role_id, permission_id)
SELECT r.id, p.id FROM role r, permission p
WHERE r.key IN ('admin', 'operator') AND p.key = 'history:export'
ON CONFLICT DO NOTHING;
```

`ON CONFLICT DO NOTHING` on `role_permission` requires that table to have a
unique key over `(role_id, permission_id)`; **verify it in CP2 before writing
this line** and fall back to a `NOT EXISTS` guard if absent.

### 3.2 The history list query

New file `apps/api/src/campaigns/history-query.ts`, deliberately separate from
`campaigns.repository.ts` — the drafts list and the history list have opposite
defaults and different permissions (§0(j)), and keeping them in one file is how
they drift into each other.

The DTO, in `apps/api/src/campaigns/dto/history.dto.ts`:

```ts
import { z } from 'zod';

/** BR-HIS-001. Deliberately NOT campaignListQuerySchema (DEC-138): that one
 *  defaults to status='draft' and is guarded by CONTENT_MANAGE, while history
 *  is viewer-readable and defaults to every non-draft status, newest first. */
export const historyListQuerySchema = z.object({
  status: z.enum(['scheduled', 'queued', 'validating', 'sending', 'paused', 'completed', 'partial_failed', 'failed', 'cancelled']).optional(),
  dateFrom: z.string().datetime({ offset: true }).optional(),
  dateTo: z.string().datetime({ offset: true }).optional(),
  senderConfigId: z.string().uuid().optional(),
  createdBy: z.string().uuid().optional(),
  search: z.string().trim().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
  cursor: z.string().min(1).optional(),
}).strict();
export type HistoryListQueryDto = z.infer<typeof historyListQuerySchema>;
```

The cursor is the same keyset shape `NotificationsRepository.listForUser`
already uses (`base64url` of `` `${isoTimestamp}|${id}` ``) — read
`apps/api/src/notifications/notifications.service.ts:38` and reuse the encoding
exactly rather than inventing a second cursor format. The sort key is
`COALESCE(campaign.started_at, campaign.scheduled_at_utc, campaign.created_at) DESC, campaign.id DESC`
so that a scheduled campaign sorts by when it *will* run and a sent one by when
it *did* — which is what "mới nhất" means on this screen.

Per-row progress reads the **stored** 028 columns rather than recomputing:

```sql
SELECT ce.id AS execution_id, ce.status AS execution_status, ce.progress_seq,
       ce.pending_count, ce.queued_count, ce.submitted_count, ce.delivered_count,
       ce.bounced_count, ce.failed_count, ce.skipped_count, ce.cancelled_count,
       cs.total_snapshot
FROM campaign_execution ce
JOIN campaign_snapshot cs ON cs.id = ce.snapshot_id
WHERE ce.tenant_id = $1 AND ce.campaign_id = ANY($2::uuid[]) AND cs.superseded_at IS NULL
```

joined in a **second** query keyed by the page's campaign ids, not a correlated
subquery per row. Rows with no execution get `progress: null` — which is exactly
BR-HIS-004's *"Không hiển thị progress gửi trước khi bắt đầu"* falling out of the
data model rather than being special-cased in the UI.

The rollups (`sent`, `delivered`, `failed`, `percent`) are computed by calling
the **existing** `progress-math.ts` helpers on the stored counts. Do not inline
the arithmetic.

### 3.3 Resend

New file `apps/api/src/campaigns/resend.service.ts`. One exported function,
`resendFailedRecipients(tenantId, campaignId, actor)`, running entirely inside
one `runInTenantContext` transaction:

1. Load the campaign. Reject unless `status IN ('partial_failed', 'failed')` —
   a resend of a still-running campaign is not a thing (`409`).
2. Load the live snapshot and its execution (the parent). Reject if absent
   (`409`).
3. Count the parent's failed sendable recipients:
   `WHERE snapshot_id = $parent AND eligibility = 'sendable' AND status = 'failed'`.
   If zero, `409` with a body naming zero — never create an empty execution.
4. **Assert the parent is fully terminal** — no `campaign_recipient` row for the
   parent snapshot in `('pending','queued')`. This is the precondition §0(c)
   said would be enforced rather than assumed, because `partition.ts` claims by
   `campaign_id` without an execution scope and a resend started while the parent
   still had claimable rows would let one partition pass straddle both.
5. `UPDATE campaign_snapshot SET superseded_at = now() WHERE id = $parent` —
   the single mutation `campaign_snapshot_immutable` permits.
6. `INSERT` the child snapshot copying **every** frozen column from the parent
   (`template_version_id`, `sender_json`, `audience_query_json`,
   `policy_result_json`, `variable_schema_json`, `frozen_by`) with
   `parent_snapshot_id = $parent`, `total_snapshot = sendable_count = <failed count>`,
   `skipped_count = 0`.
7. `INSERT INTO campaign_recipient` one row per parent failed recipient, copying
   `recipient_id`, `merge_data_json`, `email_snapshot`, `eligibility`
   (always `'sendable'`), with `snapshot_id = <child>`, `status = 'pending'`,
   `attempt_count = 0`, `execution_id = NULL`. The copy is a single
   `INSERT … SELECT`, not a row loop.
8. `INSERT INTO campaign_execution` with `snapshot_id = <child>`,
   `parent_execution_id = <parent execution>`,
   `resend_generation = parent.resend_generation + 1`,
   `status = 'validating'`, a fresh `correlation_id`, and the parent's
   `batch_size`/`max_attempts`/`sender_config_id`.
9. `UPDATE campaign SET status = 'queued', version = version + 1` so the existing
   scan picks it up. `campaign_no_edit_after_send` permits this: no guarded
   column changes and the campaign never touches `'draft'`.
10. `appendAuditLog` with action `campaign.resend.created`, metadata carrying
    parent execution id, child execution id and recipient count.

Nothing in `apps/worker` changes for resend. That is the point of §0(c)(4).

### 3.4 Export

`export_job` rows are created by the API (`POST /campaigns/:id/exports`,
`history:export`) and processed by a new worker queue.

**Inline vs background** — BR-HIS-003 says *"Export chạy background nếu lớn"*.
The threshold is a new env var `EXPORT_INLINE_MAX_ROWS` (default `500`),
documented in `apps/api/src/config/env.ts`, `.env.deploy.example` and
`compose.yaml` in the same checkpoint per AGENTS.md §2. At or below the
threshold the API renders and completes the row synchronously; above it, the row
stays `queued` and the worker picks it up. Either way the client polls
`GET /campaigns/:id/exports/:exportId` and downloads from
`GET /campaigns/:id/exports/:exportId/file`, so there is exactly one client flow.

**The renderer** lives in `apps/api/src/campaigns/export-render.ts` and is a pure
function over rows — no database access, so it is unit-testable without a
fixture and is transliterated to the worker under the DEC-107/DEC-123 precedent
with a parity test, exactly as `progress-math.ts` already is. Columns:

```
recipient_email,status,skipped_reason,attempt_count,last_error_code,last_error_class,submitted_at,delivered_at
```

**No secret ever enters this file** (BR-HIS-007): the query selects from
`campaign_recipient`, `recipient` and `message_attempt` only, and never joins
`sender_config` (which holds `secret_ref`) or `app_user`. CP7 asserts this with a
test that greps the rendered output for the fixture's secret value.

**Expiry** is `now() + EXPORT_ARTIFACT_TTL_HOURS` (default `72`), stamped at
completion. The download route returns `410 Gone` past it and does not serve the
bytes.

**Audit** — every successful download calls `appendAuditLog` with action
`history.export.downloaded` and increments `downloaded_count` in the same
transaction. BR-HIS-007's *"audit download"* is a per-download row, not a
per-creation row.

**`export.completed`** is published through the existing outbox/relay spine, the
same way `import.completed` is (`apps/worker/src/import-processor.ts:299`), and
gets a `notification-rules.ts` entry so the notification centre surfaces it.

### 3.5 Pause and resume

**State machine (both apps, one commit).** Add to
`LEGAL_CAMPAIGN_EXECUTION_EDGES`:

```
'sending->paused'
'paused->sending'
```

Nothing else. `paused->cancelled` is deliberately **not** added: cancel from
pause is not in BR-SEND-009's text and adding an edge no rule asks for is how a
state machine stops being a specification.

**API.** `POST /campaigns/:id/pause` and `POST /campaigns/:id/resume`, both
`CAMPAIGN_MANAGE` + `CsrfGuard` + `202`, mirroring the existing
`POST /campaigns/:id/cancel` (`campaigns.controller.ts:88`). Each writes both
`campaign.status` and `campaign_execution.status` in one tenant transaction,
guarded by `isLegalCampaignExecutionTransition`, and appends an audit row.

**Worker enforcement (the part that actually satisfies the 10 seconds).**
`sendClaimedBatch`'s per-row loop (`send.ts:123`) gains a bounded re-check:

```ts
// BR-SEND-009 / D-123. The scheduler tick is 60s by default, so a pause that
// only took effect between scan passes would miss the rule's 10-second bound
// by a factor of six. Re-read campaign status inside the loop, at most once
// per PAUSE_CHECK_INTERVAL_MS, and stop claiming further rows the moment it
// is no longer 'sending'. Rows already submitted are never recalled -- the
// rule says so explicitly ("message da submitted khong thu hoi").
```

with `PAUSE_CHECK_INTERVAL_MS = 2_000`, giving a worst case of one in-flight
message plus 2 s — comfortably inside 10 s. On observing a non-`sending` status
the loop `break`s; rows already reserved but not yet sent are released by setting
`claimed_at = NULL` (the same release `rescheduleOverBudget` already performs at
`send.ts:174`), so resume re-reserves them without duplicating. **The
no-duplicate guarantee is asserted against `message_attempt`'s
`UNIQUE (campaign_recipient_id, attempt_no)`**, which is append-only and cannot
be talked into agreeing.

**Interaction with M6-S1's throttled publish (the handoff's open question 4).**
`buildProgressEvent` already takes its `status` from a fresh read of
`campaign.status` at publish time (`progress-snapshot.ts:117-121` reads
`c.status AS campaign_status` inside its own transaction), and
`publishProgressSnapshot` opens its **own** transaction rather than the caller's.
So a pause that commits before the flush is picked up correctly and no change is
needed — **but the plan does not assert this from reading; CP5 proves it with a
test that pauses mid-batch and asserts the next published envelope carries
`status: 'paused'`.** If it does not, that is a real defect, and it is fixed at
the root rather than worked around.

### 3.6 The web screen

`apps/web/src/screens/history/HistoryScreen.tsx` replaces the `ComingSoon`
placeholder at `apps/web/src/app/AppRoutes.tsx:95-100`. Structure and class names
come verbatim from the approved `History` component (§0(l)); only the data
source changes from `histories` mock data to a TanStack Query hook.

- `apps/web/src/api/history.ts` — `fetchCampaignHistory`, `createCampaignExport`,
  `fetchCampaignExport`, `resendCampaign`, `pauseCampaign`, `resumeCampaign`.
- `apps/web/src/screens/history/history-countdown.ts` — a pure function
  `countdownFrom(serverTime, scheduledAtUtc)` returning a formatted remainder.
  Pure so BR-HIS-004's "server time, not client clock" is unit-testable without a
  browser: the test passes a `serverTime` that disagrees with the machine clock
  and asserts the output follows the former.
- `apps/web/src/screens/history/HistoryFilterDialog.tsx` — the approved
  `historyFilter` overlay, mapping onto the `historyListQuerySchema` fields.
- `apps/web/src/screens/history/ResendConfirmDialog.tsx` — the approved
  `resendConfirm` + `resendSuccess` overlays, showing the real failed-recipient
  count and the real reasons from the drill-down endpoint.

The existing `CampaignProgressDrawer` gains only: a status drill-down filter
(BR-HIS-003), a working **Tạm dừng**/**Tiếp tục** button (BR-SEND-009) and a
working **Tải báo cáo** button (BR-HIS-003/007) that is hidden — not merely
disabled — for a user lacking `history:export`.

---

## 4. Contracts

- `contracts/openapi.yaml` gains, all additive: `getCampaignHistory`,
  `resendCampaign`, `pauseCampaign`, `resumeCampaign`, `createCampaignExport`,
  `getCampaignExport`, `downloadCampaignExport`, plus schemas
  `CampaignHistoryPage`, `CampaignHistoryRow`, `CampaignExport`,
  `CampaignResendResult`. Run the repo's `contracts:compat-check` against
  `origin/main` and expect additive-only for this node's own paths — the M4-S2
  breaking findings M6-S2 already traced and reported are pre-existing and out of
  scope.
- `contracts/asyncapi.yaml`'s `export_completed` channel is finally **used**; the
  channel declaration itself needs no change, but `catalog/realtime-events.json`'s
  entry (`channel: job:{job_id}`, `dedupe: job_id`, `cadence: Once`) is the
  contract the publisher must satisfy: exactly one event per export job, keyed by
  the export job id.
- `docs/adr/adr-027-resend-lineage-and-pause-resume.md` — new, **Accepted**,
  written in CP1 before any code. It covers both ADR triggers this node crosses
  (AGENTS.md §2): resend changes **campaign snapshot semantics** (a second live
  snapshot generation with a lineage pointer), and pause/resume changes
  **delivery state** (a new pair of edges and a new in-loop actor that halts
  submission). ADR-016 and ADR-026 are not amended; ADR-027 is additive.

---

## 5. Risks

**R1 — The child snapshot supersedes the parent, and superseding is one-way.**
`campaign_snapshot_immutable` permits `superseded_at` to be set exactly once
(`023:...`, `IF OLD.superseded_at IS NOT NULL … RAISE`). A resend that fails
*after* superseding but *before* inserting the child would leave the campaign
with no live snapshot. Mitigation: the whole of §3.3 runs in **one** transaction,
and CP6 includes a test that forces a failure at step 7 and asserts the parent's
`superseded_at` is still `NULL` afterwards.

**R2 — D-118 fixture racing.** Every fixture in CP5, CP6 and CP8 that must sit
still for more than a few hundred milliseconds is parked at
`campaign.status = 'paused'`, which `queued_campaign_executions()` does not
select (§0(h)). The one place this is impossible is CP5's own pause test, which
by definition needs a `sending` campaign — that test therefore runs against its
own tenant and asserts on `message_attempt` rows for its own execution id only,
never on a global count.

**R3 — A new cross-tenant scan.** `queued_export_jobs()` is this node's own
cross-tenant boundary and is exactly the shape D-121 bit M6-S1 on. **It gets the
`if (!row) return <no-op>` guard from the first line of code**, and CP12 runs the
worker package at `--maxWorkers=3` or higher before the node is called done.

**R4 — `bytea` round-tripping.** `pg` returns `bytea` as a Node `Buffer`;
TypeORM's `EntityManager.query` does the same. The download route must
`response.type('text/csv').attachment(filename).send(buffer)` without a string
conversion, or a UTF-8 CSV with Vietnamese content will be mangled — the same
class of failure AGENTS.md's encoding paragraph describes. CP9 tests a round-trip
with Vietnamese recipient data specifically.

**R5 — The 10-second bound is a wall-clock assertion in a test.** On a contended
host a wall-clock assertion is a flake generator (D-93/D-94). CP5's test
therefore asserts on **submission count** rather than elapsed time: after the
pause commits, at most one further `message_attempt` row may appear for that
execution. The 10-second figure is then argued from the code's own
`PAUSE_CHECK_INTERVAL_MS = 2_000` constant, which is asserted directly, rather
than from a timing measurement.

---

## 6. Checkpoints

One commit per checkpoint. Every commit subject names the node; every commit
body records the workspace check's test count and skip count.

### CP0 — baseline

- [ ] **Step 1: Confirm the working tree and HEAD**

```bash
git -C "C:/Works/Projects/Email operations workspace/email-operations-workspace" log --oneline -1
```

Expected: `9fc6460 M6-S1-realtime-progress: completed (5 rules -- 4 closed/1 partially_closed by design)`, clean tree.

- [ ] **Step 2: Confirm nothing stale is bound to the dev ports**

```bash
netstat -ano | grep -E ":3000|:5173" | head
```

Expected: empty, or only the docker-compose published ports. Kill any leftover host-side dev server from the previous session before starting new ones.

- [ ] **Step 3: Establish the per-package baseline at real parallelism**

Run each package directly rather than `pnpm run check` — a single flake in `apps/api` aborts the whole recursive run (`ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL`) and the later packages never start.

```bash
pnpm --filter @eow/api exec vitest run --maxWorkers=3
```

Expected: 77 files / 579 tests / 0 skipped / 0 failed. Repeat for `@eow/worker` (25/124), `@eow/web` (22/65), `@eow/architecture-tests` (13/110). **Total baseline: 137 files / 878 tests / 0 skipped.** Record the actual numbers in `state.json`; if any differ from these, isolate before proceeding — do not start CP1 on an unexplained delta.

- [ ] **Step 4: Commit the baseline record**

```bash
git add .agents/runs/2026-08-10-eow-master-execplan/state.json
git commit -m "M6-S3 CP0: baseline (137 files / 878 tests / 0 skipped)"
```

### CP1 — ADR-027, the node split, and the graph, before any code

- [ ] **Step 1: Write `docs/adr/adr-027-resend-lineage-and-pause-resume.md`**

Status `Accepted`. Context: BR-HIS-005 needs a parent-linked retry and BR-SEND-009 needs pause/resume; both cross AGENTS.md §2's ADR triggers (snapshot semantics, delivery state). Decision: resend creates a child snapshot superseding its parent, with `parent_snapshot_id`/`parent_execution_id` lineage (the four constraints in §0(c), quoted with file and line); pause adds exactly two state-machine edges plus an in-loop status re-check at a 2-second cadence (the 60-second scheduler tick argument from §0(f)). Consequences: `UNIQUE (campaign_id, snapshot_id)` is preserved; `readProgressFacts` needs no change; `run.ts` needs no change; a campaign accrues one superseded snapshot per resend generation. Alternatives rejected: reusing the parent snapshot (requires dropping the DAG idempotency key and merges two executions' counts into one).

- [ ] **Step 2: Create node `M6-S4-history-retention` in `state.json`**

`dependsOn: ["M6-S3-history-recovery"]`, `status: "pending"`, `attempt: 0`, `maxAttempts: 5`, `evidence: []`, `successConditions`: purge job has audit, does not break aggregate reporting, retention policy is tenant-configurable, `BR-HIS-006` closed. Remove BR-HIS-006 from `M6-S3-history-recovery`'s own success conditions and add `M6-S4-history-retention` to `M6-GATE.dependsOn`.

- [ ] **Step 3: Reassign BR-HIS-006 in `traceability.csv`**

Set its `slice` column to `M6-S4-history-retention`. Status stays `not_started`.

- [ ] **Step 4: Record the decisions in `EXECPLAN.md` §19/§20**

`DEC-132`…`DEC-139` and `D-122`, `D-123` exactly as stated in §0. Also correct any note that still implies BR-HIS-006 is this node's.

- [ ] **Step 5: Validate the run state**

```bash
python .agents/runs/2026-08-10-eow-master-execplan/validate_plan.py
```

Expected: no errors. A warning about the new node having no evidence yet is expected and fine.

- [ ] **Step 6: Commit**

```bash
git add docs/adr/adr-027-resend-lineage-and-pause-resume.md .agents/runs/2026-08-10-eow-master-execplan/
git commit -m "M6-S3 CP1: ADR-027, split BR-HIS-006 into M6-S4-history-retention (DEC-132..DEC-139, D-122, D-123)"
```

### CP2 — migration 029, RED first

- [ ] **Step 1: Verify `role_permission`'s unique key before writing the seed**

```bash
grep -n "role_permission" -A 8 database/migrations/004_rbac.sql | head -20
```

If there is no `UNIQUE (role_id, permission_id)`, replace §3.1(3)'s `ON CONFLICT DO NOTHING` with a `WHERE NOT EXISTS (SELECT 1 FROM role_permission rp WHERE rp.role_id = r.id AND rp.permission_id = p.id)` guard.

- [ ] **Step 2: Write the failing schema test**

Create `apps/api/test/integration/history-schema.test.ts`. There is **no** `helpers/` directory in `apps/api/test/integration/` — the established convention for a DB-layer test is a raw `createDataSource(testDatabaseUrl())`, exactly as `campaign-execution-db.test.ts:1-25` does for migration 026. Follow it:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { createDataSource } from '../../src/database/data-source.js';
import { testDatabaseUrl } from './test-database-url.js';

/**
 * M6-S3 CP2, RED first: migration 029 has not been written yet. Every case
 * here must fail against the current schema before 029 exists, and pass once
 * it lands. Covers the DB-layer half of BR-HIS-005/003/007 only.
 */
describe('History and recovery DB layer (M6-S3 CP2: migration 029)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = createDataSource(testDatabaseUrl());
    await dataSource.initialize();
  });
  afterAll(async () => { await dataSource.destroy(); });

  it('adds resend lineage to campaign_execution', async () => {
    const rows = await dataSource.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'campaign_execution'
         AND column_name IN ('parent_execution_id', 'resend_generation')
       ORDER BY column_name`,
    );
    expect(rows.map((r: { column_name: string }) => r.column_name))
      .toEqual(['parent_execution_id', 'resend_generation']);
  });

  it('adds snapshot lineage to campaign_snapshot', async () => {
    const rows = await dataSource.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'campaign_snapshot' AND column_name = 'parent_snapshot_id'`,
    );
    expect(rows).toHaveLength(1);
  });

  it('creates export_job with row level security forced', async () => {
    const [row] = await dataSource.query(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'export_job'`,
    );
    expect(row).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it('grants history:export to admin and operator but not viewer', async () => {
    const rows = await dataSource.query(
      `SELECT r.key FROM role r
       JOIN role_permission rp ON rp.role_id = r.id
       JOIN permission p ON p.id = rp.permission_id
       WHERE p.key = 'history:export' ORDER BY r.key`,
    );
    expect(rows.map((r: { key: string }) => r.key)).toEqual(['admin', 'operator']);
  });
});
```

- [ ] **Step 3: Run it and verify it fails**

```bash
pnpm --filter @eow/api exec vitest run test/integration/history-schema.test.ts
```

Expected: FAIL — `parent_execution_id` missing, `export_job` relation does not exist.

- [ ] **Step 4: Write `database/migrations/029_history_recovery.sql`**

Exactly as specified in §3.1, written as UTF-8 (AGENTS.md §2 — pass `-Encoding utf8` to PowerShell or `encoding='utf-8'` to Python; do not let the Windows-1252 default touch it).

- [ ] **Step 5: Apply the migration and re-run**

```bash
pnpm --filter @eow/api exec vitest run test/integration/history-schema.test.ts
```

Expected: PASS, 4/4.

- [ ] **Step 6: Extend the RBAC coverage guard**

`packages/architecture-tests/src/rbac-coverage.test.ts` asserts every `PERMISSIONS` key is seeded and every route carries one. Add `HISTORY_EXPORT: 'history:export'` to `apps/api/src/common/permissions.ts` and re-run:

```bash
pnpm --filter @eow/architecture-tests exec vitest run
```

Expected: PASS, 110 tests. The migration-immutability guard must stay green — 029 is new, 001-028 untouched.

- [ ] **Step 7: Commit**

```bash
git add database/migrations/029_history_recovery.sql apps/api/src/common/permissions.ts apps/api/test/integration/history-schema.test.ts packages/architecture-tests/src/rbac-coverage.test.ts
git commit -m "M6-S3 CP2: migration 029 -- resend lineage, export_job, history:export permission"
```

### CP3 — the history list, RED first

- [ ] **Step 1: Write the failing DTO/cursor unit test**

`apps/api/src/campaigns/history-query.test.ts`, covering: default sort is newest-first; `limit` defaults to 25 and rejects 101; an unknown query key is rejected by `.strict()`; a cursor encodes and decodes to the same `(timestamp, id)` pair; a malformed cursor throws a message containing `Invalid history cursor`.

- [ ] **Step 2: Run and verify it fails**

```bash
pnpm --filter @eow/api exec vitest run src/campaigns/history-query.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write `dto/history.dto.ts` and `history-query.ts`**

Per §3.2. `history-query.ts` exports `buildHistoryQuery(query, tenantId)` returning `{ sql, params }` and `encodeCursor`/`decodeCursor`. Keep it pure — no `EntityManager` — so this test needs no database.

- [ ] **Step 4: Run and verify it passes**

- [ ] **Step 5: Write the failing integration test**

`apps/api/test/integration/campaign-history.test.ts`: seed one tenant with a `scheduled`, a `sending`, a `completed` and a `partial_failed` campaign across two sender configs and two creators; assert newest-first ordering; assert each of `status`, `dateFrom`/`dateTo`, `senderConfigId`, `createdBy` narrows correctly; assert a two-page cursor walk returns every row exactly once; assert the `scheduled` row has `progress === null` and carries `scheduledTimezone`; assert the response carries a `serverTime` within 5 seconds of `now()`. Park every fixture that is not the `sending` one at a status the live worker ignores (§0(h)).

- [ ] **Step 6: Run and verify it fails, then wire the service and controller**

`CampaignsService.listHistory` + `@Get('history') @RequirePermission(PERMISSIONS.CAMPAIGN_READ)` on `CampaignsController`. **Declare it before `@Get(':id')`** or Nest will route `/campaigns/history` into the id handler.

- [ ] **Step 7: Run both tests and verify they pass**

- [ ] **Step 8: Commit**

```bash
git commit -m "M6-S3 CP3: GET /campaigns/history -- server filtering, keyset pagination, serverTime (BR-HIS-001, BR-HIS-004)"
```

### CP4 — pause/resume state machine edges, RED first (pure, no I/O)

- [ ] **Step 1: Write the failing test in both apps**

Append to `apps/api/src/campaigns/send-state-machine.test.ts` and create the matching cases in the worker's own suite:

```ts
it('admits pause and resume, and nothing else into or out of paused', () => {
  expect(isLegalCampaignExecutionTransition('sending', 'paused')).toBe(true);
  expect(isLegalCampaignExecutionTransition('paused', 'sending')).toBe(true);
  expect(isLegalCampaignExecutionTransition('paused', 'completed')).toBe(false);
  expect(isLegalCampaignExecutionTransition('paused', 'cancelled')).toBe(false);
  expect(isLegalCampaignExecutionTransition('queued', 'paused')).toBe(false);
});
```

- [ ] **Step 2: Run and verify both fail**

- [ ] **Step 3: Add the two edges to both copies and update the DEC-097 comment**

The comment in both files currently reads *"'paused' carries no edge in either direction (DEC-097) -- M6-S1 adds pause/resume, not this node."* Replace with a note that M6-S3 adds exactly `sending->paused` and `paused->sending` per ADR-027, and that no other edge touches `paused` by design.

- [ ] **Step 4: Run and verify both pass**

- [ ] **Step 5: Commit**

```bash
git commit -m "M6-S3 CP4: sending<->paused edges in both state machines (BR-SEND-009, ADR-027)"
```

### CP5 — pause enforcement in the send loop and the API routes, RED first

- [ ] **Step 1: Write the failing worker integration test**

`apps/worker/src/campaign-send/pause.integration.test.ts`: seed a campaign with 40 sendable recipients and `batchSize = 40`, drive `sendClaimedBatch` with a stubbed `sendFn` that flips `campaign.status` to `'paused'` after the 5th call, and assert (a) `message_attempt` rows for that execution number at most 6, (b) no row already `submitted` changed status, (c) every reserved-but-unsent row has `claimed_at IS NULL` afterwards. Assert on counts, never on elapsed wall-clock time (R5).

- [ ] **Step 2: Run and verify it fails** — today the loop sends all 40.

- [ ] **Step 3: Add the bounded re-check to `sendClaimedBatch`**

Per §3.5, with `const PAUSE_CHECK_INTERVAL_MS = 2_000;` as a module constant and a direct unit assertion on that constant's value in the same test file, so the 10-second claim rests on an asserted number rather than a measurement.

- [ ] **Step 4: Run and verify it passes**

- [ ] **Step 5: Write the failing API test**

`apps/api/test/integration/campaign-pause.test.ts`: `POST /campaigns/:id/pause` on a `sending` campaign returns 202 and moves both `campaign.status` and `campaign_execution.status` to `paused`; on a `completed` campaign returns 409; a viewer receives 403; `POST /campaigns/:id/resume` returns it to `sending`; each writes an audit row.

- [ ] **Step 6: Run, verify it fails, then add the two controller routes and service methods**

Mirror `POST /campaigns/:id/cancel`'s decorators exactly (`@HttpCode(202) @UseGuards(CsrfGuard) @RequirePermission(PERMISSIONS.CAMPAIGN_MANAGE)`).

- [ ] **Step 7: Prove the realtime interaction rather than assuming it (§3.5)**

Extend the worker test: after the pause commits, call `publishProgressSnapshot` with a capturing publisher and assert the captured envelope's `status` is `'paused'`. If it is `'sending'`, that is a real defect — fix it at the root in `progress-snapshot.ts` and record it as `D-124`.

- [ ] **Step 8: Run both packages and verify green, then commit**

```bash
git commit -m "M6-S3 CP5: pause takes effect inside the send loop; pause/resume routes (BR-SEND-009, D-123)"
```

### CP6 — resend, RED first

- [ ] **Step 1: Write the failing integration test**

`apps/api/test/integration/campaign-resend.test.ts`, asserting all of:
a `partial_failed` campaign with 3 failed and 7 delivered recipients yields a child snapshot with `total_snapshot === 3`; the child execution's `parent_execution_id` is the parent's id and `resend_generation === 1`; the parent snapshot's `superseded_at` is now set and the child's is `NULL`; the child's recipient set is exactly the parent's failed `recipient_id`s; resending a `sending` campaign returns 409; resending a campaign with zero failures returns 409; a second resend produces `resend_generation === 2`; and — per R1 — a forced failure during child-recipient insertion leaves the parent's `superseded_at` still `NULL`.

- [ ] **Step 2: Run and verify it fails**

- [ ] **Step 3: Write `apps/api/src/campaigns/resend.service.ts`**

The ten steps of §3.3, all inside one `runInTenantContext`.

- [ ] **Step 4: Add `POST /campaigns/:id/resend`**

`@HttpCode(202) @UseGuards(CsrfGuard) @RequirePermission(PERMISSIONS.CAMPAIGN_MANAGE)`.

- [ ] **Step 5: Add the missing BR-HIS-005 first-half coverage**

`apps/worker/src/campaign-send/aggregate.integration.test.ts` — a case with both a `failed` and a `delivered` recipient must end `partial_failed`, and an all-failed case must end `failed`. The behaviour exists; the test does not.

- [ ] **Step 6: Run and verify all pass, then commit**

```bash
git commit -m "M6-S3 CP6: resend creates a parent-linked child execution over failed recipients only (BR-HIS-005, DEC-133)"
```

### CP7 — export creation and RBAC, RED first

- [ ] **Step 1: Write the failing renderer unit test**

`apps/api/src/campaigns/export-render.test.ts`: header row is exactly the eight columns in §3.4; a Vietnamese display name round-trips unmangled; a value containing `"` and `,` is quoted and doubled; a `skipped` row carries its `skipped_reason`; and — the BR-HIS-007 assertion — rendering rows built from a fixture whose sender config holds a known secret produces output that does not contain that secret.

- [ ] **Step 2: Run, verify it fails, write `export-render.ts` (pure), verify it passes**

- [ ] **Step 3: Write the failing API integration test**

`apps/api/test/integration/campaign-export.test.ts`: a viewer receives 403 from `POST /campaigns/:id/exports`; an operator receives 202; an export under `EXPORT_INLINE_MAX_ROWS` comes back `completed` with `expires_at` set; one over the threshold comes back `queued` with `artifact_bytes IS NULL`.

- [ ] **Step 4: Run, verify it fails**

- [ ] **Step 5: Add `EXPORT_INLINE_MAX_ROWS` (default 500) and `EXPORT_ARTIFACT_TTL_HOURS` (default 72) to `apps/api/src/config/env.ts`, `.env.deploy.example` and `compose.yaml`**

All three in this step — AGENTS.md §2 requires the deployment contract to move together with the variable.

- [ ] **Step 6: Write `exports.service.ts` and the controller route, then verify green**

- [ ] **Step 7: Commit**

```bash
git commit -m "M6-S3 CP7: export job creation, inline/background threshold, history:export gate (BR-HIS-003, BR-HIS-007)"
```

### CP8 — the export worker and `export.completed`, RED first

- [ ] **Step 1: Write the failing worker integration test**

`apps/worker/src/export-processor.integration.test.ts`: a `queued` export job is picked up, rendered, and left `completed` with `row_count` matching the fixture, `artifact_bytes` non-null and `expires_at` in the future; a second run over the same job is a no-op (idempotent); a job whose campaign has vanished is left `failed` with a `failure_code` **and does not throw** — the D-121 guard, present from the first line.

- [ ] **Step 2: Run and verify it fails**

- [ ] **Step 3: Write `apps/worker/src/export-processor.ts`**

Modelled on `bulk-processor.ts`. Its renderer is the transliterated twin of `apps/api/src/campaigns/export-render.ts` (§3.4).

- [ ] **Step 4: Add the parity guard**

`packages/architecture-tests/src/export-render-parity.test.ts`, following `suppression-parity.test.ts` and `progress-parity.test.ts` exactly. Name the rule `ARCH-EXPORT-PARITY`.

- [ ] **Step 5: Register the queue in `apps/worker/src/main.ts` and enqueue the scan in `apps/scheduler/src/main.ts`**

A new `Worker(EXPORT_QUEUE, …)` beside `importWorker`/`bulkWorker`, plus an `export-scan` arm on the `campaign-execution` worker using `queued_export_jobs()` behind the `OUTBOX_DATABASE_URL` guard, and a fifth `queue.add('export-scan', …)` in the scheduler tick. Add both to `shutdown()`.

- [ ] **Step 6: Publish `export.completed` and add its notification rule**

`buildJobEvent`-shaped envelope on `job:{exportJobId}` with `dedupe: job_id` per `catalog/realtime-events.json`; a `notification-rules.ts` entry `{ sourceEvent: 'export.completed', type: 'export_completed', severity: 'success', category: 'export', wired: true }`; a `writeJobNotification` call mirroring `import-processor.ts:100`.

- [ ] **Step 7: Run the worker package and verify green, then commit**

```bash
git commit -m "M6-S3 CP8: export worker, export.completed finally wired, ARCH-EXPORT-PARITY (BR-HIS-003)"
```

### CP9 — download, expiry and audit, RED first

- [ ] **Step 1: Write the failing integration test**

`apps/api/test/integration/campaign-export-download.test.ts`: a completed export downloads as `text/csv` with a `Content-Disposition` filename and byte-identical content (Vietnamese included — R4); each successful download writes exactly one `audit_log` row with action `history.export.downloaded` and increments `downloaded_count`; a viewer receives 403; a job whose `expires_at` is in the past returns 410 and serves no bytes; another tenant's export id returns 404, not 403 (do not leak existence across tenants).

- [ ] **Step 2: Run, verify it fails, add `GET /campaigns/:id/exports/:exportId/file`, verify it passes**

Send the `Buffer` directly (R4). Do not `toString()` it.

- [ ] **Step 3: Commit**

```bash
git commit -m "M6-S3 CP9: export download with expiry and per-download audit (BR-HIS-007)"
```

### CP10 — the history screen, RED first

- [ ] **Step 1: Write the failing countdown unit test**

`apps/web/src/screens/history/history-countdown.test.ts`: `countdownFrom(serverTime, scheduledAtUtc)` returns the remainder computed from `serverTime`; passing a `serverTime` two hours behind the machine clock produces a countdown two hours longer, proving the client clock is not consulted (BR-HIS-004).

- [ ] **Step 2: Run, verify it fails, write `history-countdown.ts`, verify it passes**

- [ ] **Step 3: Write the failing screen test**

`apps/web/src/screens/history/HistoryScreen.test.tsx`: renders loading, empty, error and success states; a `scheduled` row shows "Chờ gửi" and no percentage; a `partial_failed` row shows the resend button and other rows do not; a user without `history:export` does not get an export button in the DOM at all.

- [ ] **Step 4: Run, verify it fails**

- [ ] **Step 5: Write `api/history.ts`, `HistoryScreen.tsx`, `HistoryFilterDialog.tsx`, `ResendConfirmDialog.tsx`, and swap the route**

Structure and class names verbatim from the approved handoff (§0(l)). Replace the `ComingSoon` element at `apps/web/src/app/AppRoutes.tsx:95-100`.

- [ ] **Step 6: Run the web package and the handoff-fidelity guard**

```bash
pnpm --filter @eow/web exec vitest run
pnpm --filter @eow/architecture-tests exec vitest run src/handoff-fidelity.test.ts
```

Both must be green. If fidelity fails, layer additive CSS after the untouched approved lines — the pattern M6-S2 established — rather than editing approved rules.

- [ ] **Step 7: Commit**

```bash
git commit -m "M6-S3 CP10: UI-HIS-001 send history screen replaces the ComingSoon placeholder (BR-HIS-001, BR-HIS-004)"
```

### CP11 — drawer wiring and contracts

- [ ] **Step 1: Wire the drawer's three inert affordances**

`CampaignProgressDrawer.tsx`: the status drill-down filter (BR-HIS-003), **Tạm dừng**/**Tiếp tục** (BR-SEND-009), **Tải báo cáo** (BR-HIS-003/007, hidden without `history:export`). Test each with the same RED-first cycle.

- [ ] **Step 2: Widen `contracts/openapi.yaml`**

The seven operations and four schemas listed in §4.

- [ ] **Step 3: Run the contract compatibility check**

```bash
pnpm run contracts:compat-check
```

Expected: this node's own paths are additive-only. The pre-existing M4-S2 findings M6-S2 already traced are out of scope — report, do not fix.

- [ ] **Step 4: Commit**

```bash
git commit -m "M6-S3 CP11: drawer drill-down/pause/export wiring and OpenAPI widening"
```

### CP12 — visual evidence, full-parallelism run, close

- [ ] **Step 1: Capture visual evidence at three viewports**

1440x900, 768x1024, 390x844, covering `/history`'s loading, empty, error, success, permission-denied and reconnecting states, the filter overlay, the resend confirm/success overlays, and the drawer's pause and export controls. Save under `.agents/runs/2026-08-10-eow-master-execplan/evidence/M6-S3-history-recovery/`.

- [ ] **Step 2: Individually inspect every captured image**

A green Playwright run is not evidence (D-78, D-104, reconfirmed twice since). Open each image and describe what it shows in the evidence record.

- [ ] **Step 3: Run every package at real parallelism**

```bash
pnpm --filter @eow/api exec vitest run --maxWorkers=3
```

and the same for `@eow/worker`, `@eow/web`, `@eow/architecture-tests`. R3's cross-tenant `export-scan` must survive this specifically. Compare the totals against CP0's 137/878/0/0 — a **skip** count above zero is a failure even under a green summary.

- [ ] **Step 4: Update `traceability.csv`**

Flip only rules whose evidence exists and has been re-run, filling `openapi_operation_ids`, `asyncapi_channels`, `migration_files`, `code_paths`, `test_files` and `log_or_metric_or_audit` for each.

- [ ] **Step 5: Update `state.json` to `completed` with the full evidence array, and validate**

```bash
python .agents/runs/2026-08-10-eow-master-execplan/validate_plan.py
```

- [ ] **Step 6: Write `M6-S3-HISTORY-RECOVERY-HANDOFF.md` for the next session**

Cover: what closed and what did not, the CP12 baseline numbers, any new `D-*` found during execution, and the state of `M6-S4-history-retention` and `M6-GATE`.

- [ ] **Step 7: Commit**

```bash
git commit -m "M6-S3-history-recovery: completed (6 rules)"
```

- [ ] **Step 8: Do not push**

`origin/main` is at `7d2eec0`, two nodes behind. Pushing requires separate explicit confirmation in the session that does it. No prior approval covers it.
