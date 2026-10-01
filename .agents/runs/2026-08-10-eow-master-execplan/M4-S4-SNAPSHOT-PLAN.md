# M4-S4 Campaign Snapshot Implementation Plan

Node: `M4-S4-snapshot` · Depends on: `M4-S3-variable-policy` (completed), `M4-S2-audience` (completed), `M4-S1-campaign-draft` (completed)
Owns rules: **BR-CMP-007**, **BR-CMP-010**, **BR-TPL-001** (reallocated from M3, DEC-046), **BR-TPL-012** (reallocated from M3, DEC-046), **BR-CF-008** (reallocated into M4, DEC-044)
Overlay: `sendConfirm` (terminal action becomes real) + `sendSuccess` (minimal) · Screen: extends `UI-EMAIL-001` (compose)
Reserved: migration **022**, decisions **DEC-079…085**, defects **D-79…84**
Solo execution (no Codex split for this node — same as M4-S2/M4-S3).

---

## 1. What this slice turns from definition into fact

M4-S1 gave campaigns durable drafts. M4-S2 answers *who* the campaign resolves to,
live. M4-S3 answers *whether every one of those people can actually be rendered*,
live. Every one of those answers is recomputed on each request against current
data — which is exactly the property that makes them useless as a send contract.
This slice is the moment a campaign stops being a query over live data and becomes
a fixed set of rows.

`campaign_snapshot` and `campaign_recipient` have existed since `001_initial.sql`,
with grants (`011_app_role.sql`) and RLS (`012_rls.sql`) already in place. **Nothing
in the codebase has ever written a row to either table.** `CampaignsService.send()`
is still M4-S1's in-memory mock (`campaigns.service.ts`, the `progress`/`schedule`/
`send`/`cancel` tail) and `SendConfirmOverlay`'s primary CTA is a deliberate mock
that calls `onClose()`. That mock tail is what this slice replaces.

### The five rules, in their own words

| Rule | What it actually requires |
|------|---------------------------|
| BR-CMP-007 | On send/schedule confirmation, freeze the recipient list *and* the merge data used for that send. Recipient/list/tag/custom-field data changing afterwards must not change the campaign. Refreshing requires an explicit cancel-then-new-snapshot transition — not an in-place update. |
| BR-CMP-010 | A double-click or a network retry must not create two campaign executions. The same Idempotency-Key returns the same campaign/job. The UI CTA must show loading and be disabled during the request. |
| BR-TPL-001 | A campaign only sends from a published version or a valid snapshot; editing a template draft afterwards does not change a campaign that already used the old version. |
| BR-TPL-012 | The campaign snapshots the template version **and the merge schema** at confirmation time. Changing the template afterwards does not change the snapshotted campaign's content. |
| BR-CF-008 | A bulk custom-field update run after a campaign has snapshotted does not silently change that campaign's merge data. The UI warns; getting new data requires cancelling / refreshing the audience. |

The binding sentence, same shape as M4-S2's and M4-S3's: **the frozen merge data
must be produced by the exact chain that validation already showed the operator,
and the frozen content must be produced by the exact renderer the real send will
use.** `resolveActionableRecipientIds` → `recipientVariableContext` →
`renderTemplateVariables` already exist and are already proven by M4-S2/M4-S3/M3-S3.
This slice's job is to call that chain once and *persist its output*, never to
recompute or reimplement any part of it. A freeze that re-derives eligibility or
re-implements rendering is the precise defect class this node exists to prevent.

### Hard non-goals

- **No real dispatch, no worker, no message delivery.** M5-S3-send owns the
  validate→freeze→partition→send→aggregate DAG, batching, retries and Mailpit
  arrival. This slice freezes the input to that DAG and stops. The campaign lands
  in `queued` and nothing consumes it yet — deliberately visible, not pretended.
- **No `BR-SEND-012`.** The handoff flagged this as an open question. Answered
  against the authoritative source: `traceability.csv` records `BR-SEND-012,P0,M5`
  — milestone M5, not M4. `implementation-inventory.yaml:265/288` bundles it under
  an `immutable_snapshot` area, which is why it *looks* like this node's, but the
  CSV is authoritative (the run's own convention, and the same check D-74 exists
  to enforce). `content_hash` and worker-side deterministic render belong to
  M5-S3-send. Recorded as DEC-079, not silently skipped.
- **No real scheduling.** `POST /campaigns/{id}/schedule` stays M4-S1's mock.
  BR-CMP-007's acceptance says "send/schedule", but M5-S2-schedule owns UTC+IANA
  storage, delayed BullMQ jobs, misfire policy and reschedule. The freeze is built
  as one reusable service function so M5-S2 wires the *same* function to schedule
  rather than growing a second freeze path (DEC-080).
- **No campaign state machine.** BR-SEND-001 (transition outside the machine
  returns 409, every transition timestamped with actor/system reason) is M5. This
  slice performs exactly two transitions — `draft → queued` on freeze and
  `queued → draft` on cancel-to-refresh — and does not build a general machine.
- **No durable send notification.** BR-NOT-001 is M6 and already `closed` by
  M6-S2-notification-center. Emitting a durable notification row from the freeze
  would reopen a closed rule's surface from a node that does not own it. The
  `sendSuccess` confirmation this slice adds is an in-overlay success state only.
- **No `campaign_execution` table.** `catalog/entities.json` lists
  `campaign_executions (idempotency_key)` — that is M5-S3's execution ledger. This
  slice's idempotency is the existing `idempotency_key` table via
  `IdempotencyService`, exactly as `bulk_job`/`import_job` already use it. Building
  an execution ledger with no executor is DEC-056's "don't build infrastructure for
  a capability that doesn't exist yet" all over again.
- **No D-78 fix.** The open tablet-CSS defect on `SenderSettingsScreen.tsx` remains
  Codex's, per DEC-071/073/078. Unrelated to this node.

---

## 2. Acceptance criteria

| # | Criterion | Rule | Test case | Proof layer |
|---|-----------|------|-----------|-------------|
| A1 | Confirming send freezes, in one transaction: one `campaign_snapshot` row (template version, sender, audience query, policy result) and one `campaign_recipient` row per resolved recipient (sendable *and* skipped, each with its reason) | BR-CMP-007 | TC-CMP-007 | integration |
| A2 | The frozen `merge_data_json` for each recipient is byte-identical to the context `computeCampaignVariableValidation` would build for that recipient at the same instant — proven by calling the exported context builder directly and comparing, not by re-asserting expected keys | BR-CMP-007, BR-TPL-012 | TC-CMP-007 | integration |
| A3 | Editing a recipient's custom-field data (single or bulk) after the freeze leaves every `campaign_recipient.merge_data_json` and `email_snapshot` unchanged | BR-CMP-007, BR-CF-008 | TC-CF-013 | integration |
| A4 | Adding a recipient to, or removing one from, a list the campaign targeted after the freeze does not change the frozen recipient set | BR-CMP-007 | TC-CMP-007 | integration |
| A5 | `UPDATE` or `DELETE` against a frozen `campaign_snapshot` row, and any attempt to change a `campaign_recipient`'s frozen columns, is rejected by a PostgreSQL trigger with ERRCODE `55000` | BR-CMP-007, BR-TPL-012 | TC-CMP-007 | integration |
| A6 | `PATCH /campaigns/{id}` on a frozen (`queued`) campaign is rejected at both the service layer (409) and the DB trigger layer — neither alone is trusted | BR-CMP-007, BR-CF-008 | TC-CF-013 | integration |
| A7 | Publishing template v2 after a campaign froze against v1 leaves that campaign's `template_version_id` and every `email_snapshot` on v1's content; a *new* campaign can select v2; v1 itself remains unmodifiable | BR-TPL-001, BR-TPL-012 | TC-TPL-001, TC-TPL-012, TC-TPL-015 | integration |
| A8 | Editing the template *draft* (not publishing) after the freeze changes nothing about the frozen campaign | BR-TPL-001 | TC-TPL-001 | integration |
| A9 | Two concurrent `POST /campaigns/{id}/send` with the same `Idempotency-Key` produce exactly one snapshot and one recipient set; both responses reference the same `snapshotId` | BR-CMP-010, BR-GEN-005 | TC-CMP-016 | integration |
| A10 | The same `Idempotency-Key` with a materially different campaign payload returns 409 | BR-CMP-010, BR-GEN-005 | TC-CMP-016 | integration |
| A11 | `POST /campaigns/{id}/send` without an `Idempotency-Key` header is rejected 400 (matching `bulk-jobs.controller.ts`'s precedent) | BR-GEN-005 | TC-CMP-016 | integration |
| A12 | The `sendConfirm` CTA is disabled and shows a loading label for the whole duration of the send request; a second click during flight issues no second request | BR-CMP-010 | TC-CMP-010 | e2e + visual |
| A13 | Cancelling a frozen campaign returns it to `draft`, marks the snapshot `superseded_at`, and leaves the superseded snapshot and its recipient rows readable and still immutable; a subsequent freeze creates a *new* snapshot rather than mutating the old one | BR-CMP-007, BR-CF-008 | TC-CMP-007, TC-CF-008 | integration |
| A14 | The compose screen visibly warns that a frozen campaign's data will not refresh on its own, and offers the cancel-to-refresh transition | BR-CF-008 | TC-CF-008, TC-CF-013 | e2e + visual (Claude) |
| A15 | A freeze is refused (422) when P0 validation is outstanding — missing required variables with no valid waiver — reusing M4-S3's `validateAudience` result rather than a second gate | BR-CMP-005 (already closed; not re-claimed), BR-CMP-007 | integration |
| A16 | Cross-tenant campaign/snapshot/recipient ids never leak: a snapshot is unreadable and unfreezable from another tenant | domain invariant | integration |
| A17 | A freeze whose audience exceeds `CAMPAIGN_AUDIENCE_LIMIT` is refused 422 with the same shape `previewAudience` returns — the freeze path re-checks rather than assuming preview blocked it (R1) | BR-CMP-007 | integration |

---

## 3. Locked design

### 3.1 Migration 022 — `022_campaign_snapshot.sql`

Next free number is **022** (`019` is a reserved-but-unused hole from M4-S2 per
DEC-056; `020_sender_config.sql` and `021_notification_center.sql` are the highest
entries in `database/migrations.lock.json`). Both tables already exist from `001`,
already have `GRANT`s and RLS, so this is additive columns plus constraints plus
triggers — **not** new tables, and no `GRANT`/RLS block is needed for them.

```sql
-- M4-S4 -- campaign snapshot: the frozen send set. Both tables were published by
-- 001_initial.sql with grants (011) and RLS (012) and have never been written to,
-- so added NOT NULL columns need no backfill and no DEFAULT-then-drop dance.

ALTER TABLE campaign_snapshot
  ADD COLUMN IF NOT EXISTS variable_schema_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS total_snapshot integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sendable_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS skipped_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS frozen_by uuid REFERENCES app_user(id),
  ADD COLUMN IF NOT EXISTS superseded_at timestamptz;

-- BR-CMP-007's "refresh yêu cầu hủy và tạo snapshot mới": one *live* snapshot per
-- campaign, but superseded ones are retained as immutable history. 001's blanket
-- UNIQUE(campaign_id) would have made a second snapshot impossible, i.e. would have
-- made the rule's own refresh transition unimplementable.
ALTER TABLE campaign_snapshot DROP CONSTRAINT IF EXISTS campaign_snapshot_campaign_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_campaign_snapshot_live
  ON campaign_snapshot (campaign_id) WHERE superseded_at IS NULL;

ALTER TABLE campaign_recipient
  ADD COLUMN IF NOT EXISTS snapshot_id uuid NOT NULL REFERENCES campaign_snapshot(id),
  ADD COLUMN IF NOT EXISTS email_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS eligibility text NOT NULL DEFAULT 'sendable',
  ADD COLUMN IF NOT EXISTS skipped_reason text;

ALTER TABLE campaign_recipient
  ADD CONSTRAINT campaign_recipient_eligibility_known
    CHECK (eligibility IN ('sendable', 'skipped')),
  ADD CONSTRAINT campaign_recipient_skipped_reason_known
    CHECK (
      (eligibility = 'sendable' AND skipped_reason IS NULL)
      OR (eligibility = 'skipped' AND skipped_reason IN (
        'deleted', 'status_paused', 'status_unsubscribed', 'status_bounced',
        'excluded_by_list', 'excluded_by_tag', 'excluded_by_recipient',
        'missing_required_variable'
      ))
    );

-- Per-snapshot, not per-campaign: a refreshed snapshot re-freezes the same people.
ALTER TABLE campaign_recipient DROP CONSTRAINT IF EXISTS campaign_recipient_campaign_id_recipient_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_campaign_recipient_snapshot
  ON campaign_recipient (snapshot_id, recipient_id);
CREATE INDEX IF NOT EXISTS idx_campaign_recipient_snapshot_eligibility
  ON campaign_recipient (tenant_id, snapshot_id, eligibility);

-- Immutability. 015_template_versions.sql's trigger raises unconditionally
-- (BEFORE UPDATE OR DELETE, body is a bare RAISE) because a published version has
-- no legal mutation at all. A snapshot has exactly one -- superseding -- so this
-- function must inspect OLD/NEW instead of raising blind.
CREATE OR REPLACE FUNCTION campaign_snapshot_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Campaign snapshots are immutable and cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.superseded_at IS NOT NULL OR NEW.superseded_at IS NULL THEN
    RAISE EXCEPTION 'A campaign snapshot may only be superseded once, and nothing else may change'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.campaign_id IS DISTINCT FROM NEW.campaign_id
    OR OLD.template_version_id IS DISTINCT FROM NEW.template_version_id
    OR OLD.sender_json IS DISTINCT FROM NEW.sender_json
    OR OLD.audience_query_json IS DISTINCT FROM NEW.audience_query_json
    OR OLD.policy_result_json IS DISTINCT FROM NEW.policy_result_json
    OR OLD.variable_schema_json IS DISTINCT FROM NEW.variable_schema_json
    OR OLD.total_snapshot IS DISTINCT FROM NEW.total_snapshot
    OR OLD.sendable_count IS DISTINCT FROM NEW.sendable_count
    OR OLD.skipped_count IS DISTINCT FROM NEW.skipped_count
    OR OLD.frozen_at IS DISTINCT FROM NEW.frozen_at THEN
    RAISE EXCEPTION 'Campaign snapshot content is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER campaign_snapshot_immutable_trigger
BEFORE UPDATE OR DELETE ON campaign_snapshot
FOR EACH ROW EXECUTE FUNCTION campaign_snapshot_immutable();

-- campaign_recipient's send-progress columns (status, provider_message_id,
-- last_error_code, updated_at) stay writable -- M5-S3 owns them. Only the frozen
-- half is locked.
CREATE OR REPLACE FUNCTION campaign_recipient_snapshot_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Frozen campaign recipients cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.snapshot_id IS DISTINCT FROM NEW.snapshot_id
    OR OLD.campaign_id IS DISTINCT FROM NEW.campaign_id
    OR OLD.recipient_id IS DISTINCT FROM NEW.recipient_id
    OR OLD.merge_data_json IS DISTINCT FROM NEW.merge_data_json
    OR OLD.email_snapshot IS DISTINCT FROM NEW.email_snapshot
    OR OLD.eligibility IS DISTINCT FROM NEW.eligibility
    OR OLD.skipped_reason IS DISTINCT FROM NEW.skipped_reason THEN
    RAISE EXCEPTION 'Frozen campaign recipient data is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER campaign_recipient_snapshot_immutable_trigger
BEFORE UPDATE OR DELETE ON campaign_recipient
FOR EACH ROW EXECUTE FUNCTION campaign_recipient_snapshot_immutable();

-- BR-CMP-007's other half: 017's campaign_no_edit_after_send() only guards
-- 'sending'/'completed'. A frozen campaign sits in 'queued', which that trigger
-- lets straight through -- so today a PATCH could still rewrite audience_json out
-- from under a snapshot. Extended, not replaced (forward-only: 017 is untouched).
CREATE OR REPLACE FUNCTION campaign_no_edit_after_send()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('queued', 'validating', 'scheduled', 'sending', 'completed')
    AND (
      OLD.name IS DISTINCT FROM NEW.name
      OR OLD.subject IS DISTINCT FROM NEW.subject
      OR OLD.template_id IS DISTINCT FROM NEW.template_id
      OR OLD.template_version_id IS DISTINCT FROM NEW.template_version_id
      OR OLD.sender_json IS DISTINCT FROM NEW.sender_json
      OR OLD.audience_json IS DISTINCT FROM NEW.audience_json
      OR OLD.settings_json IS DISTINCT FROM NEW.settings_json
    ) THEN
    RAISE EXCEPTION 'Campaign content cannot be edited after it has been frozen for sending'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
```

`app_user` is the table `001_initial.sql` creates (not `users`), so `frozen_by uuid
REFERENCES app_user(id)` is the correct FK spelling. `018_campaign_status_values.sql`
already widened `campaign_status_known` to admit `queued`/`validating`, so §3.3's
status transition needs no CHECK change.

`022_campaign_snapshot.sql` is applied via the compose-defined migrate service —
`docker compose run --rm migrate` — never `docker exec`/`docker cp` against the
running postgres container (the handoff's tool-anomaly mitigation). Then
`database/migrations.lock.json` gets its checksum entry and `ARCH-MIGRATION` is
re-run **standalone**, not merely as a typecheck side effect.

### 3.2 Entities

Two new TypeORM entities, both registered in `apps/api/src/database/data-source.ts`'s
`entities` array (the array is the single registration point; forgetting it is a
silent runtime failure, not a compile error):

```ts
// campaign-snapshot.entity.ts
@Entity({ name: 'campaign_snapshot' })
export class CampaignSnapshotEntity {
  id, tenantId, campaignId, templateVersionId,
  senderJson: CampaignSender,
  audienceQueryJson: CampaignAudience,
  policyResultJson: SnapshotPolicyResult,
  variableSchemaJson: TemplateVariableSchema,
  totalSnapshot, sendableCount, skippedCount,
  frozenBy: string | null, frozenAt: Date, supersededAt: Date | null,
}

// campaign-recipient.entity.ts
export type CampaignRecipientEligibility = 'sendable' | 'skipped';
export type CampaignRecipientSkipReason = AudienceSkipReason | 'missing_required_variable';
export type FrozenEmail = { subject: string; html: string; textBody: string };
@Entity({ name: 'campaign_recipient' })
export class CampaignRecipientEntity {
  id, tenantId, campaignId, snapshotId, recipientId,
  mergeDataJson: Record<string, unknown>,
  emailSnapshot: FrozenEmail,
  eligibility: CampaignRecipientEligibility,
  skippedReason: CampaignRecipientSkipReason | null,
  status, providerMessageId, lastErrorCode, updatedAt,
}
```

`CampaignRecipientSkipReason` is deliberately `AudienceSkipReason | 'missing_required_variable'`
— it reuses M4-S2's union verbatim rather than restating it, so a future reason
added to the audience resolver cannot silently diverge from what a snapshot can
record. `missing_required_variable` is the eighth value, and it is the *only* one
this node introduces: it is the durable form of M4-S3's waiver decision
(BR-CMP-005), which until now existed only as `settings_json.audienceWaiver` on
the draft. `suppressed` remains absent, per DEC-057.

`policy_result_json` records the M4-S3 validation outcome as frozen at that instant:

```ts
type SnapshotPolicyResult = {
  totalActionable: number; completeCount: number; missingCount: number;
  missingByVariable: MissingVariableBreakdown[];
  waiver: CampaignAudienceWaiver | null;
  webOrigin: string;   // unsubscribe_url generation input; changing config later must not silently reinterpret frozen data
};
```

### 3.3 The freeze

One exported function, in a new `apps/api/src/campaigns/campaign-snapshot.ts`,
mirroring how `campaign-variable-validation.ts` orchestrates I/O and delegates
every decision:

```ts
export async function freezeCampaignSnapshot(
  manager: EntityManager, tenantId: string, campaign: CampaignEntity,
  actor: CampaignActor, webOrigin: string,
): Promise<FrozenSnapshot>
```

Two signature facts to respect, both verified against source rather than assumed:

- `CampaignActor` (`{actorId: string | null; traceId: string}`) is currently exported
  from `campaigns.service.ts:36`. `CampaignsService` will import
  `campaign-snapshot.ts`, so importing `CampaignActor` back out of the service would
  close a cycle. Move the type to `campaigns.types.ts` (or co-locate it in
  `campaign-snapshot.ts` and re-export from the service) as the first step of CP2.
- `renderTemplateVariables(template, schema, context)` called **without** options is
  strict mode: it returns `{code: 'MISSING_REQUIRED_VARIABLE', missingKeys}` rather
  than throwing, and `'code' in rendered` is how `variable-validation.ts:47` detects
  it. The freeze uses strict mode and must apply the same `'code' in rendered` check
  — a recipient that renders to a `code` object is a `missing_required_variable`
  skip, never an `email_snapshot`. Do not pass `{mode: 'preview'}`: preview mode
  substitutes defaults for missing required keys and would freeze content the
  operator was never shown as valid.

Sequence, all inside the caller's single `runInTenantContext` transaction:

1. `findActiveById(id, /* lock */ true)` — pessimistic write lock on the campaign
   row, the same lock `updateDraft`/`acceptAudienceWaiver` already take. This is
   what makes step 6's status flip and the snapshot insert atomic with respect to a
   concurrent PATCH.
2. Guard: campaign must be `draft`; anything else → 409. No template version → 422.
   Audience larger than `CAMPAIGN_AUDIENCE_LIMIT` → 422, re-applying
   `previewAudience`'s check (R1: that check lives in `previewAudience` only and is
   **not** on the path a send takes).
3. `AudienceCandidatesRepository.findCandidates(...)` **once**. The candidate rows
   feed both the eligibility classification and the recipient load — resolving the
   audience twice would be the exact "preview and send disagree" defect M4-S2's
   `resolveAudience` docstring warns about. Immediately re-check
   `resolution.totalUnique` against `CAMPAIGN_AUDIENCE_LIMIT` and throw 422 if it is
   exceeded — the existing limit check lives only inside `previewAudience()`
   (`campaigns.service.ts:102-114`), which the freeze does not call, so this is not
   inherited for free and must be repeated explicitly here.
4. `resolveAudience(candidates, {sampleLimit})` for the counts, and
   `resolveActionableRecipientIds(candidates)` for the sendable set. Both are
   existing exports sharing one `classify()`; neither is reimplemented here. Skipped
   people and their reasons come from the same candidate pass.
5. `computeCampaignVariableValidation(manager, tenantId, campaign, webOrigin)` for
   the policy result. If `missingCount > 0` and the draft's waiver does not cover
   the current missing set (`waiverStatus !== 'valid'`, computed exactly as
   `validateAudience` does), throw 422 — A15. When the waiver *is* valid, each
   missing recipient is frozen as `eligibility: 'skipped'`,
   `skipped_reason: 'missing_required_variable'` rather than dropped, so the
   snapshot records who was excluded and why.
6. For each sendable recipient: `recipientVariableContext(recipient, customFields, webOrigin)`
   → `mergeDataJson`, and `renderTemplateVariables(templateVersion, schema, context)`
   → `emailSnapshot`. Same two functions, same arguments, same order as validation.
   A skipped recipient gets `mergeDataJson` recorded (it is evidence of *why* they
   were skipped) and an empty `emailSnapshot`.
7. Insert one `campaign_snapshot`, then bulk-insert `campaign_recipient` rows.
8. `campaign.status = 'queued'`, `version += 1`.
9. `appendAuditLog(manager, { action: 'campaign.snapshot_frozen', entityType: 'campaign',
   entityId: campaign.id, metadata: { snapshotId, totalSnapshot, sendableCount, skippedCount } })`
   — this is the exact evidence family `traceability-plan.yaml` §5 already anticipates
   for BR-CMP-007 ("`audit_log.action = campaign.snapshot_frozen` with `campaign_id`
   + row count").
10. `appendOutboxEvent(manager, { eventType: 'campaign.snapshot_frozen',
    aggregateType: 'campaign', aggregateId, aggregateVersion: BigInt(newVersion), payload })`
    — the `campaign.state_changed` channel already exists in `contracts/asyncapi.yaml`,
    and the outbox writer's `ON CONFLICT DO NOTHING` on
    `(aggregate_type, aggregate_id, aggregate_version, event_type)` makes a replay
    a safe no-op. No consumer exists yet; the row is the durable record M5-S3 will
    pick up, exactly as `bulk-update.job.created` did before its worker existed.

`status: 'queued'` — not `sending` (no worker), not `scheduled` (no schedule). It
means precisely "frozen, awaiting a dispatcher", and `018_campaign_status_values.sql`
already widened the CHECK to admit it. DEC-081.

### 3.4 Idempotency (BR-CMP-010)

`POST /campaigns/{campaignId}/send` requires an `Idempotency-Key` header, rejecting
400 when absent — the same hard requirement `bulk-jobs.controller.ts:30-32` already
imposes, and the `IdempotencyKey` parameter component in `contracts/openapi.yaml`
is already `required: true`. The freeze runs inside
`IdempotencyService.run(manager, tenantId, key, 'campaign_snapshot', payload, create)`,
with the payload canonicalized to what actually determines the send:

```ts
{ campaignId, version, templateVersionId, senderJson, audienceJson, settingsJson }
```

`version` is in the payload deliberately: an operator who edits the draft and
re-sends with a stale key gets 409 rather than a silent replay of the older
snapshot. `IdempotencyService.run<T extends {id: string}>` requires an `id` on the
returned value, so `create` returns the snapshot row shape with `id = snapshotId`;
the controller maps it to the response DTO.

The concurrency guarantee is the one `IdempotencyService` already documents and
`import-jobs`/`bulk-jobs` already rely on: `INSERT … ON CONFLICT DO NOTHING` is the
mutex, so only the request that won the placeholder insert runs `create`. A9 tests
this against real PostgreSQL with two genuinely concurrent requests, not two
sequential ones.

### 3.5 Cancel-to-refresh (BR-CMP-007's second half, BR-CF-008)

`POST /campaigns/{campaignId}/cancel` gets real behaviour, scoped strictly to the
pre-dispatch case:

- Campaign in `queued` with a live snapshot → set `campaign_snapshot.superseded_at = now()`
  (the single legal UPDATE the trigger permits), campaign back to `draft`,
  `version += 1`, audit `campaign.snapshot_superseded`.
- The superseded snapshot and all its `campaign_recipient` rows stay in place,
  readable and still immutable — cancelling is not deleting evidence.
- The partial unique index `uq_campaign_snapshot_live` then admits a fresh freeze,
  and `uq_campaign_recipient_snapshot` (per-snapshot, not per-campaign) admits the
  same people again under the new snapshot id.
- Any other status → 409. Cancelling a campaign that is actually mid-send is
  M5-S3's problem and is explicitly not attempted here.

This is the literal implementation of "refresh yêu cầu hủy và tạo snapshot mới":
there is no in-place refresh path at all, by construction. DEC-082 records why
`001`'s blanket `UNIQUE(campaign_id)` had to be narrowed to a partial index —
left as-is it would have made the rule's own required transition impossible.

### 3.6 Web surface

`SendConfirmOverlay`'s primary CTA stops calling `onClose()` and calls
`sendCampaign(campaignId, idempotencyKey)`. Per BR-CMP-010's UI clause:

- The `Idempotency-Key` is generated **once per overlay mount** via `crypto.randomUUID()`
  held in a `useRef` — not per click. A key regenerated on each click would make
  the double-click case create two snapshots, i.e. would defeat the exact rule.
- `sending` state disables the CTA and both footer buttons, swaps the label to
  `Đang gửi…`, and blocks the backdrop/Escape close path. A11y: the button keeps
  `aria-busy`.
- Success replaces the overlay body with a minimal `sendSuccess` state (frozen
  counts + a "Đóng" action). This is an in-overlay confirmation, not a durable
  notification (§1 non-goals).
- Failure surfaces the RFC 9457 problem detail through the existing `ApiError` path
  and re-enables the CTA — the same key is retried, so a retry after a network
  failure replays rather than double-creating.

`ComposeDraftScreen` gains a frozen banner when `draft.status !== 'draft'`: every
field goes read-only, and a "Hủy để chỉnh sửa lại" action calls cancel and returns
the draft to editable. Its copy must state plainly that recipient/custom-field
changes made from now on will not reach this campaign — that sentence *is*
BR-CF-008's "UI cảnh báo" and A14 verifies it visually, not just structurally.

### 3.7 Recorded decisions (carried into EXECPLAN §20)

- **DEC-079** — `BR-SEND-012` is M5, not this node. `traceability.csv` (authoritative)
  vs `implementation-inventory.yaml`'s `immutable_snapshot` bundling; the same
  citation-check discipline D-74 established.
- **DEC-080** — the freeze is wired to `/send` only; `/schedule` stays a mock for
  M5-S2 to wire to the *same* `freezeCampaignSnapshot`, so BR-CMP-007's "send/schedule"
  is closed for the half that has a real trigger and explicitly deferred for the half
  that does not, rather than faked.
- **DEC-081** — frozen campaigns land in `queued`, not `sending`/`scheduled`.
- **DEC-082** — narrowing `001`'s `UNIQUE(campaign_id)` on `campaign_snapshot` to a
  partial unique index on live snapshots, and moving `campaign_recipient`'s
  uniqueness from `(campaign_id, recipient_id)` to `(snapshot_id, recipient_id)`.
- **DEC-083** — `campaign_recipient.email_snapshot` stores fully rendered content
  per recipient rather than a hash; `content_hash` is BR-SEND-012's (M5-S3).
  Bounded by the existing `CAMPAIGN_AUDIENCE_LIMIT`; see §5 R1.
- **DEC-084** — skipped recipients are frozen as rows with reasons, not omitted, so
  `sendable + skipped = total_snapshot` holds in the snapshot itself (which is what
  M5-S3's BR-SEND-002 "counts cộng lại bằng total_snapshot" will need).
- **DEC-085** — `017`'s `campaign_no_edit_after_send()` is extended to cover
  `queued`/`validating`/`scheduled`; without it a frozen campaign's `audience_json`
  was still PATCH-able, which would have left BR-CMP-007 enforced at the service
  layer only. Recorded because it is a behaviour change to an already-published
  trigger's function body (the migration file itself stays untouched — forward-only).

---

## 4. HTTP surface

| Method | Path | operationId | Permission | Returns |
|--------|------|-------------|------------|---------|
| POST | `/campaigns/{campaignId}/send` | `sendCampaign` | `campaign:manage` | 202 `CampaignSnapshotAccepted` |
| POST | `/campaigns/{campaignId}/cancel` | `cancelCampaign` | `campaign:manage` | 202 `CampaignSnapshotAccepted` (superseded form) |
| GET | `/campaigns/{campaignId}/snapshot` | `getCampaignSnapshot` | `campaign:read` | 200 `CampaignSnapshot` / 404 |

Both mutating routes gain `@UseGuards(CsrfGuard)` — the current mock `send`/`cancel`
handlers have none, which is fine for a method that returns a literal and not fine
for one that writes rows. The permission split already in
`campaigns.controller.ts:66-69` (`campaign:manage` for send/cancel, `campaign:read`
for progress) is kept as-is.

`GET /snapshot` exists so the frozen set is observable without waiting for M5's
progress machinery — A3/A7's "did it actually stay the same" assertions read it,
and the frozen banner uses its counts. It returns the *live* snapshot; superseded
ones are reachable only through the DB (no history endpoint is in this node's scope —
M6-S3-history-recovery owns history surfaces).

New schemas in `contracts/openapi.yaml`, all additive:

```yaml
CampaignSnapshotAccepted:
  {campaignId, snapshotId, status, totalSnapshot, sendableCount, skippedCount, frozenAt, idempotencyReplayed}
CampaignSnapshot:
  {id, campaignId, templateVersionId, sender, audienceQuery, policyResult,
   totalSnapshot, sendableCount, skippedCount, frozenAt, supersededAt,
   skippedByReason: [{reason: CampaignRecipientSkipReason, count}]}
CampaignRecipientSkipReason:
  enum: [...AudienceSkipReason values..., missing_required_variable]
```

`sendCampaign`'s existing bare `202: Snapshot frozen and graph accepted` is
*replaced* by a described 202 with a body, plus `400/403/404/409/422` problem
responses and the existing `IdempotencyKey` parameter `$ref`. That is a
compatibility question `openapi-compat-check` will judge: adding a response body
and required header to a previously bodyless, header-less operation. Expect it to
flag the newly-required `Idempotency-Key`; the justification (the operation was
never implemented, so no client depends on the header-free shape — the same
argument M4-S3 §3.1/CP4 already made for its stub removal) goes in the checkpoint
note, not silently past the check.

---

## 5. Risks

| # | Risk | Mitigation |
|---|------|------------|
| R1 | `email_snapshot` stores full rendered HTML per recipient. `CAMPAIGN_AUDIENCE_LIMIT` defaults to **100 000** (`config/env.ts:24`), so the worst case is 100 000 rendered bodies in one transaction — a real row-size and write-volume cost | The ceiling is checked in `previewAudience` only (`campaigns.service.ts:102-114`) — **the freeze path does not inherit it**, so `freezeCampaignSnapshot` must re-apply the same 422 check against `resolution.totalUnique` itself rather than assume M4-S2 already blocked it. CP2 measures wall-clock and row size at 1 000 and 10 000 recipients and records both numbers whatever they are; if untenable, the fallback is content-hash + shared body, which is BR-SEND-012's territory anyway (DEC-083) |
| R2 | The freeze does N renders inside one transaction — a long transaction holding a pessimistic lock, N up to the R1 ceiling | The lock is on one campaign row only and the operation is operator-initiated and infrequent, but at 100 000 that is not a safe assumption. If CP2's measurement is poor, the render loop moves outside the transaction (contexts and renders are pure functions of already-loaded data) leaving only the inserts inside. Decide on the measurement, not in advance |
| R3 | A stale `settings_json.audienceWaiver` could freeze recipients as `missing_required_variable` that the operator never actually reviewed | Reuses `validateAudience`'s exact `waiverStatus` computation — `stale` blocks the freeze at 422 the same as `none` does. Tested as its own case in CP3 |
| R4 | Extending `campaign_no_edit_after_send()` to `queued`/`scheduled` could break an existing M4-S1/M4-S2 test that PATCHes a non-draft campaign | Full suite is re-run at CP1 and again at CP7; any such test is a genuine finding about pre-existing behaviour, to be reported and resolved explicitly rather than by weakening the trigger |
| R5 | Two entities registered in `data-source.ts` but a missing migration application on the dev DB yields confusing "column does not exist" failures that look like code bugs | Migration applied via `docker compose run --rm migrate` at CP1 *before* any entity is written, and `ARCH-MIGRATION` run standalone — per the handoff's tool-anomaly mitigation |
| R6 | The tool-output anomaly (twice reproduced, still unexplained) could report a clean test run that never happened | Every "clean" claim in this node is backed by a raw log file read with a native Windows path (`cygpath -w`), never a `tail`-piped summary; a result that contradicts a just-verified fact triggers a tool/shape switch, not a retry |

---

## 6. Checkpoints

**CP1 — migration 022 + entities, RED first.** Write the failing integration test
first: a hand-inserted `campaign_snapshot` row that an `UPDATE` must be unable to
change and a `DELETE` must be unable to remove (expect ERRCODE `55000`), plus a
`campaign_recipient` row whose `merge_data_json` is locked while `status` remains
writable. Then write `022_campaign_snapshot.sql` (§3.1), apply via
`docker compose run --rm migrate`, add the checksum to
`database/migrations.lock.json`, add both entities and register them in
`data-source.ts`, re-run `ARCH-MIGRATION` standalone. Full suite green (raw log,
not piped). Closes A5.

**CP2 — `freezeCampaignSnapshot`, RED first.** Real PostgreSQL. A1/A2/A15/A16 are
first-class tests, plus A17. A2 specifically asserts the frozen `merge_data_json` equals a
direct `recipientVariableContext(...)` call for the same recipient — the "computed
by the same chain, not a parallel one" proof, mirroring M4-S3's A5. Includes the R1/R2
timing measurement at a realistic audience size, recorded in the checkpoint note
whatever the number is.

**CP3 — HTTP send + idempotency + cancel/refresh.** `sendCampaign`, `cancelCampaign`,
`getCampaignSnapshot` on the controller with `CsrfGuard` and the existing permission
decorators; `IdempotencyService` wiring (note: `CampaignsModule` currently provides
only `CampaignsService` — `IdempotencyService` must be added to its providers, the
same way `JobsModule`, `TemplatesModule` and `SenderConfigModule` all already do).
A9/A10/A11/A13 tested against real infrastructure,
A9 with genuinely concurrent requests. R3's stale-waiver case tested here.

**CP4 — post-freeze immutability end to end.** A3/A4/A6/A7/A8: bulk-update a custom
field after freezing and assert every frozen row is untouched (TC-CF-013's literal
`department='Sales'` → `'Marketing'` scenario); publish template v2 and assert the
old campaign still renders v1 (TC-TPL-015); edit the template draft and assert
nothing moves (TC-TPL-001). This is the checkpoint that actually closes the node's
headline rules, and it deliberately exercises both the service guard and the DB
trigger separately — a single passing path through one of them is not evidence for
the other.

**CP5 — contract.** OpenAPI additions per §4, `openapi-compat-check` (with the
`Idempotency-Key` finding explicitly justified in writing), `redocly bundle`, and
`pnpm contracts:generate` to regenerate `packages/contracts/src/openapi.d.ts` —
never hand-edited.

**CP6 — web.** `apps/web/src/api/campaigns.ts` gains `sendCampaign` / `cancelCampaign` /
`getCampaignSnapshot`; `SendConfirmOverlay` gets the real terminal action with the
mount-scoped idempotency key, loading/disabled states and the `sendSuccess` state;
`ComposeDraftScreen` gets the frozen banner and cancel-to-refresh. A12/A14 e2e specs
added to `apps/web/e2e/visual-capture.spec.ts` following the existing M4-S3 block's
`seedVariablePolicyFixture`/`createDraftWithFixture` helpers.

**CP7 — VISUAL EVIDENCE + close (Claude, solo).** Capture at 3 viewports × the
states this node adds (sendConfirm idle / sending / success / error, compose frozen
banner, post-cancel editable) into
`evidence/visual/M4-S4-snapshot/production/`. **Individually inspect every image** —
a green Playwright run is not evidence (D-78's whole lesson). Then: close
BR-CMP-007 / BR-CMP-010 / BR-TPL-001 / BR-TPL-012 / BR-CF-008 in `traceability.csv`
with real `code_paths`/`test_files`/`migration_files`/`openapi_operation_ids`/
`log_or_metric_or_audit` values; mark `sendConfirm` and `sendSuccess` in
`screen-catalog.yaml`/`ui-inventory.yaml`; record DEC-079…085 in EXECPLAN §20 and
the migration row in §10; re-run the full suite plus `openapi-compat-check`,
`redocly bundle` and `ARCH-MIGRATION` standalone; only then flip
`M4-S4-snapshot` to `completed` and re-evaluate `M4-GATE`.

> `M4-GATE`'s own success conditions ("All 19 M4 rules closed", "23 test cases
> mapped and executing", "UI-EMAIL-001/002 at 3 viewports with all 6 required
> states", "re-rendering a frozen snapshot yields identical output") become
> satisfiable only after CP7. The gate is a separate node and is **not** flipped by
> this plan — evidence before status.
