# M4-S2 Audience Resolution Implementation Plan

Node: `M4-S2-audience` · Depends on: `M4-S1-campaign-draft` (closed), `M2-S2-lists-tags` (closed)
Owns rules: **BR-SEG-008**, **BR-SEG-009**, **BR-CMP-002**, **BR-CMP-003**, **BR-CMP-009**, **BR-REC-003**
Overlay: `recipientPicker` · Screen: `UI-EMAIL-001` (extends M4-S1's compose surface)
Reserved: migration **019** (likely unused), `DEC-056…060`, `D-46…50`

Read [`PARALLEL-EXECUTION-PROTOCOL.md`](PARALLEL-EXECUTION-PROTOCOL.md) first — it governs
shared-file access, the inbox pattern, and the visual handoff. It is not optional context.

---

## 1. What this slice turns from definition into fact

M4-S1 deliberately stored `audience_json` as an **opaque, shape-validated document** and never
resolved it. This slice resolves it: list/tag/recipient references plus exclusions become a
concrete, deduplicated, eligibility-filtered set of recipients with real counts.

### The six rules, in their own words

| Rule | What it actually requires |
|------|---------------------------|
| BR-SEG-008 | Multiple lists/tags union together, deduplicated by `recipient_id`. One recipient in several sources receives **one** message. |
| BR-SEG-009 | Exclusion by list/tag/recipient. Anything in both include and exclude is excluded, and the preview **states the reason**. |
| BR-CMP-002 | Dedup by `recipient_id` **and** `normalized_email`. `total_unique` is correct; one recipient yields at most one `campaign_recipient`. |
| BR-CMP-003 | Before send, drop `unsubscribed`, `paused`, hard-bounced, deleted and suppressed. Preview returns actionable/skipped **with a reason per skip**; skipped never enters the sending queue. |
| BR-CMP-009 | Over-quota / over-limit audiences cannot schedule or send. API returns 422/429 carrying `limit`, `current`, `requested` and remediation guidance. |
| BR-REC-003 | Status is `active`/`paused`/`unsubscribed`/`bounced`; only `active` is eligible. The preview classifies and excludes, showing the reason. |

The single sentence that binds them: **the preview must be the same computation the send path
will use.** A preview that is merely a good estimate is the defect this slice exists to prevent.

### Hard non-goals

- **No send, no schedule, no snapshot.** M4-S4 freezes the audience; M5 sends it. The mock
  `schedule`/`send`/`cancel`/`progress` handlers stay untouched and stay obviously mock.
- **No missing-variable matrix.** That is M4-S3 (`validate-audience` returns the variable
  matrix; this slice returns the audience). Both touch the word "validate" — keep them separate.
- **No sender validation.** M5-S1.
- **No quota *enforcement* infrastructure.** BR-CFG-006 and the reservation/release machinery are
  M7-S1. This slice reads a configured tenant limit and refuses over it; it does not build a
  quota ledger. Record that boundary explicitly (DEC).
- **No `campaign_recipient` rows.** Materialising the audience is snapshot work (M4-S4). This
  slice computes and returns; it persists nothing per recipient.

---

## 2. Acceptance criteria

| # | Criterion | Rule | Proof layer |
|---|-----------|------|-------------|
| A1 | Two lists sharing a recipient yield that recipient once | BR-SEG-008, BR-CMP-002 | integration (real PostgreSQL) |
| A2 | Two different recipient rows with the same `normalized_email` collapse to one | BR-CMP-002 | integration |
| A3 | A recipient in both an included list and an excluded tag is excluded, with reason `excluded_by_tag` | BR-SEG-009 | integration |
| A4 | Each of `paused`, `unsubscribed`, `bounced`, soft-deleted is skipped with its own distinct reason | BR-CMP-003, BR-REC-003 | integration |
| A5 | Both identities hold, asserted arithmetically rather than eyeballed: `totalUnique + deduplicated == totalMatched`, and `actionable + skipped == totalUnique` | BR-CMP-002/003 | integration |
| A6 | Over-limit audience returns 422 carrying `limit`, `current`, `requested` | BR-CMP-009 | integration (HTTP) |
| A7 | Cross-tenant list/tag ids in an audience definition never contribute recipients | domain invariant | integration |
| A8 | The preview result is produced by one shared function, proven by a test that calls it from both the preview path and a send-path-shaped caller | all | unit + integration |
| A9 | `recipientPicker` overlay resolves a real audience and shows real counts and skip reasons | BR-SEG-008/009 | e2e |
| A10 | Compose shows the real audience summary in place of M4-S1's "Chưa chọn người nhận" | BR-CMP-002 | e2e + **visual (Claude)** |

---

## 3. Locked design

### 3.1 No new table (and why 019 is probably unused)

Everything needed already exists: `recipient` (with `subscription_status` CHECK-constrained to
`active|paused|unsubscribed|bounced`, `unsubscribed_at`, `deleted_at`, and a generated
`normalized_email` unique per tenant — all from `006_recipient_extensions.sql`), plus
`recipient_list_member` and `recipient_tag` from `010_recipient_lists_tags.sql`.

Audience resolution is therefore a **query**, not a schema change. Migration 019 stays reserved
and unused unless a real need appears — and if one does, it is additive with defaults (§5 of the
protocol). Do not invent a `campaign_audience` cache table: a cached audience that can disagree
with the live one is precisely the class of bug M4-S4's snapshot exists to make impossible, and
duplicating it here would create two sources of truth before the authoritative one exists.

The one thing worth checking rather than assuming: whether an index is missing for the
union/exclusion query shape. Measure with `EXPLAIN` against a realistically sized tenant before
adding one; if an index is genuinely needed, that is 019's legitimate use.

### 3.2 The resolver, and the "suppressed" gap

```
resolveAudience(tenantId, audience: AudienceDefinition, limits) -> AudienceResolution
```

```
AudienceResolution {
  totalMatched:  number   // rows matched by include sources, before dedup
  totalUnique:   number   // the real audience size, after both dedup rules
  deduplicated:  number   // matched rows that collapsed into an already-seen person
  actionable:    number   // eligible to send
  skipped:       number   // totalUnique - actionable
  skippedByReason: { reason: SkipReason, count: number }[]
  sample:        { recipientId, email, displayName, status, skipReason|null }[]  // bounded preview page
  limit:         { limit: number, current: number, requested: number } | null
}
```

`SkipReason` is a closed union, one reason per exclusion cause, each independently testable:
`excluded_by_list`, `excluded_by_tag`, `excluded_by_recipient`, `status_paused`,
`status_unsubscribed`, `status_bounced`, `deleted`.

**Correction made during CP1, recorded rather than quietly applied.** An earlier draft of this
plan listed `duplicate` as a skip reason and asserted `actionable + skipped == totalMatched`.
Both were wrong, and writing the test exposed it: BR-CMP-002's "một recipient chỉ có một
campaign_recipient" describes *merging* several matches into one person, so a collapsed row was
never a second person to exclude — counting it as `skipped` double-counts, and the identity it
implied cannot hold once `totalMatched` includes duplicate rows. Deduplication is now reported
separately as `deduplicated`, `duplicate` is not a skip reason, and the two identities in A5 are
what actually hold.

**Precedence between causes is deliberate and tested:** `deleted` → status → exclusion. An
unsubscribed recipient is reported as unsubscribed even when the operator also excluded them,
because BR-CMP-003/BR-REC-003 are P0 compliance rules and operator intent (BR-SEG-009) must not
be able to mask a compliance fact in a preview.

**A second correction, found in CP2's integration test.** `recipient`'s email uniqueness
(`006_recipient_extensions.sql`) is a *partial* index, `WHERE deleted_at IS NULL` — two active
rows can never share a `normalized_email`, so BR-CMP-002's duplicate-email scenario can only
arise from a soft-deleted recipient's email being reused (BR-GEN-006), with the deleted row's
list/tag membership still present. `resolveAudience()` keeps the *first* candidate it sees for a
duplicate identity — so if the SQL result ordered the deleted row before the reused active one,
the real, reachable recipient would be reported as `deleted`, silently dropping someone who
should receive the campaign. Fixed by ordering the candidate query `(deleted IS NOT NULL) ASC,
recipient_id ASC` so an active row always wins the identity over a deleted one sharing its email.
This is a caller *contract*, not an implementation detail: anything that produces candidates for
`resolveAudience()` must order active-over-deleted for shared identities, or duplicate handling
silently favours whichever row happens to come first.

**Recorded gap — decide it, do not silently drop it.** BR-CMP-003 names five exclusion causes:
unsubscribed, paused, hard-bounced, deleted, **and suppressed**. The first four map to existing
data. There is no suppression list anywhere in the schema, in `catalog/ba-rules.json`, or in any
node's scope. Options: (a) treat `bounced` as the suppression mechanism for MVP and record that
reading; (b) declare `suppressed` unimplementable in this slice and reallocate it, the way
DEC-044/045/046/049 reallocated rules before. **Recommended: (b)** — write the decision, name the
future owner, and do not let a rule's fifth clause quietly evaporate. Whichever is chosen, the
skip-reason union must not pretend a `suppressed` reason exists if nothing can produce it.

### 3.3 Where the limit comes from

BR-CMP-009 says "vượt quota hoặc giới hạn tenant". No quota ledger exists until M7-S1. For this
slice the limit is a **configured ceiling** (environment-schema value with a documented default,
added to `.env.deploy.example` **and** `docs/deployment/environment-variables.md` together, per
AGENTS.md §2). 422 is the response for exceeding a static configured limit; 429 belongs with
rate-limited quota consumption, which this slice does not build — say so in the decision rather
than implementing a 429 path with nothing behind it.

### 3.4 HTTP surface (reserved prefix `/campaigns/{campaignId}/audience`)

| Method | Path | operationId | Permission | Returns |
|--------|------|-------------|------------|---------|
| POST | `/campaigns/{campaignId}/audience/preview` | `previewCampaignAudience` | `content:manage` | 200 `AudienceResolution` |

POST, not GET: the body carries the audience definition being *edited*, which may not yet be
saved to the draft — the picker must preview before committing. Idempotent and side-effect free
despite the verb; state that in the OpenAPI description so no future reader mistakes it for a
mutation. CSRF still applies (state-changing method), matching every other POST in this codebase.

Saving the chosen audience is already possible — `updateCampaignDraft` with `audience` — and needs
no new endpoint. Do not add one.

---

## 4. Checkpoints

Each ends with a commit and an inbox section (protocol §4). Codex does **not** write `state.json`,
`traceability.csv`, `screen-catalog.yaml` or `EXECPLAN.md`.

**CP1 — resolver, RED first.** Pure/unit-testable dedup + eligibility classification over injected
rows, before any SQL. Watch RED (module missing). Covers A1-A5's logic in isolation.

**CP2 — real query, RED first.** Repository query over `recipient_list_member`/`recipient_tag`/
`recipient` with tenant scoping and exclusions, against real PostgreSQL. A7 (cross-tenant) is a
first-class test, not an afterthought. Assert the arithmetic identity in A5 explicitly.

**CP3 — HTTP + limit.** `previewCampaignAudience` wired with `ZodValidationPipe`, `CsrfGuard`,
`@RequirePermission`, RFC 9457 problem for the 422 with `limit`/`current`/`requested` in the
problem body (not just the message string).

**CP4 — contract.** OpenAPI additively, in one edit, committed immediately (protocol §3.3);
`openapi-compat-check` proof; regenerate `packages/contracts`; append to `contract-shape.check.ts`.

**CP5 — web.** `recipientPicker` overlay ported from the handoff's real DOM
(`action-overlays.tsx` L106-109: `.recipient-mode-tabs` with Danh sách / Theo tag / Excel modes)
into `apps/web/src/overlays/RecipientPickerOverlay.tsx`, wired to the real preview endpoint, and
the compose screen's recipient field showing the real resolved summary instead of the placeholder.
The handoff's Excel mode belongs to M2-S4's import flow — reuse it or record why not; do not build
a third import path.

**CP6 — VISUAL HANDOFF (protocol §1).** Write the `visual-capture.spec.ts` block as a patch
proposal **in the inbox file**, do not apply it, do not run it, do not judge output, do not fill
`states_covered`. Set inbox status `ready-for-visual-handoff` and stop.

**CP7 — Claude.** Apply the capture patch, run it, inspect every image, fix racing/mislabelled
captures, merge inbox → shared artifacts, close `BR-SEG-008/009`, `BR-CMP-002/003/009`,
`BR-REC-003`, re-verify independently, close the node.

---

## 5. Risks

| Risk | Mitigation |
|------|-----------|
| Preview and send-path diverge | One exported resolver; A8 asserts both callers get identical output. This is the whole point of the slice. |
| Dedup by email breaks a legitimate case | `normalized_email` is already unique per tenant among non-deleted rows (006), so cross-row email collisions are rare by construction — test the soft-deleted-reuse case explicitly rather than assuming. |
| Unbounded preview response | `sample` is a bounded page (mirror `templateListQuerySchema`'s 50/100 shape); counts are aggregates, not row dumps. M4-S1's D-42-adjacent B.2 finding was exactly an unbounded list. |
| Silent scope creep into M4-S3 | No variable logic in this node. If a test needs a template, it needs one because of audience, not variables. |
| `suppressed` quietly dropped | §3.2 forces an explicit recorded decision. |
