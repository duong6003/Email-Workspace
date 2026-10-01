# M4-S3 Variable Policy Implementation Plan

Node: `M4-S3-variable-policy` · Depends on: `M4-S2-audience` (closed), `M3-S2-variables` (closed)
Owns rules: **BR-CMP-004**, **BR-CMP-005**, **BR-CMP-006**, **BR-CMP-008**, **BR-TPL-008** (reallocated from M3, DEC-049)
Overlay: `sendConfirm` · Screen: extends `UI-EMAIL-001` (compose)
Solo execution (no Codex split for this node — same as M4-S2).

---

## 1. What this slice turns from definition into fact

M4-S2 resolves *who* gets the campaign. M3-S2 already knows *which variables* a
published template references and their required/optional/default schema
(`variable_schema_json`), and `apps/api/src/templates/template-variable-renderer.ts`
already renders a template against one merge-data context, blocking on missing
required keys outside preview mode. Nothing yet runs that renderer across a
*real, resolved audience* to answer "how many of these people are actually
sendable", and nothing gates a send action on the answer. That is this slice.

### The five rules, in their own words

| Rule | What it actually requires |
|------|---------------------------|
| BR-CMP-004 | Backend checks required variables across the whole resolved audience before send/schedule. Returns `complete_count`, `missing_count`, and a breakdown by variable and by sample recipient. |
| BR-CMP-005 | Never silently send an empty required variable. The operator can only: fix the data, rely on a valid default, or explicitly confirm excluding the people missing it. Default is **block**. The decision is audited. |
| BR-CMP-006 | An optional variable missing uses the template's default; with no default it renders empty. Preview and the actual message use the **same render engine** and produce the same result. |
| BR-CMP-008 | The review screen shows sender, subject, audience counts, exclusions, variable issues, send time and timezone. The primary CTA is enabled only when P0 validation passes; the operator must explicitly confirm any skippable warning. |
| BR-TPL-008 | Marketing/bulk email requires a resolvable `unsubscribe_url` (and, at actual send time, a `List-Unsubscribe` header) when policy requires it. Validation blocks schedule/send if missing. Transactional campaigns follow their own policy. |

The binding sentence, same shape as M4-S2's: **the validation matrix must be
computed by the exact renderer the real send will use.** `renderTemplateVariables`
already exists and is already proven correct by M3-S3's preview/test-send paths —
this slice's job is to call it once per actionable recipient, not to reinvent it.

### Hard non-goals

- **No snapshot, no `campaign_recipient` rows.** M4-S4 freezes audience + template
  version + variable-policy result into an immutable send set. This slice computes
  and records a policy *decision*; it does not materialise per-recipient rows.
- **No real send/schedule action.** `ComposeDraftScreen`'s "Gửi thử"/"Hẹn giờ gửi"/
  "Gửi ngay" buttons are still M4-S1-era disabled mocks — there is no schedule/send
  endpoint anywhere yet (that is M5-S2/M5-S3). BR-CMP-008's CTA is real UI wired to
  real validation data, but its terminal action cannot call a real send API that
  does not exist. Matches M4-S1's own explicit non-goal for the same buttons.
- **No `List-Unsubscribe` MIME header.** DEC-049 already decided this: M5-S3-send
  emits the transport header; M4-S3 only makes the policy decision and resolves the
  underlying `unsubscribe_url` value the header will reference.
- **No public unsubscribe redemption endpoint.** Searched the full 118-rule catalog
  (`catalog/ba-rules.json`) for anything requiring a recipient-facing "click to
  unsubscribe" page: nothing. `BR-REC-004` is the *opposite* direction (Admin-only
  re-activation) and `BR-TPL-008` only requires the *variable* to resolve, not that
  clicking it round-trips through a real endpoint yet. Building one now would be
  inventing scope no rule asks for — recorded as a decision (§3.4), not silently
  skipped.
- **No sender validation.** M5-S1. The review screen shows whatever `sender_json`
  the draft already carries (`fromName`/`fromEmail`, from M4-S1) as-is.
- **No transactional campaign type.** Nothing in the campaign schema, the 118-rule
  catalog, or any node's scope distinguishes a "transactional" campaign from a
  marketing/bulk one — every campaign this product can compose today goes through
  the same `/email/compose` flow. BR-TPL-008's "transactional campaign có policy
  riêng" clause names a surface that does not exist; recorded as a decision (§3.4)
  rather than fabricated.

---

## 2. Acceptance criteria

| # | Criterion | Rule | Proof layer |
|---|-----------|------|-------------|
| A1 | A resolved audience with every actionable recipient having all required variables reports `missingCount: 0`, `completeCount == actionable` | BR-CMP-004 | integration |
| A2 | A resolved audience where some recipients lack a required custom-field variable reports the correct per-variable breakdown and a bounded sample naming the missing key(s) | BR-CMP-004 | integration |
| A3 | An optional variable with a template default renders the default; with no default renders empty — proven via the same `renderTemplateVariables` call the matrix uses | BR-CMP-006 | unit (existing renderer coverage) + integration (matrix uses it) |
| A4 | `unsubscribe_url` resolves to a real, unique, non-empty value for every actionable recipient; the matrix treats it as a required system check independent of whether the template text references the token | BR-TPL-008 | integration |
| A5 | The matrix is computed by calling the exported `renderTemplateVariables`/`recipientVariableContext` functions, not a duplicated implementation — proven by a test that the matrix's per-recipient missing-key result matches a direct call to the renderer for the same recipient | BR-CMP-004, BR-CMP-006 | unit |
| A6 | Accepting the "exclude recipients with missing variables" resolution persists an audited decision on the draft; a subsequent read of the draft reflects it | BR-CMP-005 | integration |
| A7 | `sendConfirm` shows real sender, subject, resolved audience counts, exclusion counts, variable-issue counts, and the draft's scheduled time/timezone fields | BR-CMP-008 | e2e + visual (Claude) |
| A8 | The CTA is disabled while any P0 validation (missing required variable with no accepted resolution, missing `unsubscribe_url`) is outstanding, and enabled once resolved or explicitly accepted | BR-CMP-008 | e2e |
| A9 | Cross-tenant campaign/template ids never leak into another tenant's validation result | domain invariant | integration |

---

## 3. Locked design

### 3.1 Reshaping the arch_contracts stub

`contracts/openapi.yaml` already has a placeholder from the `arch_contracts` phase:
`POST /templates/{templateId}/validate-audience` (operationId `validateTemplateAudience`,
bare 200/403, no request body). It does not fit: validation needs a resolved
*campaign* audience (list/tag/exclusion selectors, from M4-S2) plus the campaign's
chosen template version — a template id alone cannot produce either. Reshaped to
`POST /campaigns/{campaignId}/validate-audience`, matching M4-S2's own
`/campaigns/{campaignId}/audience/preview` precedent (campaign-scoped, POST because
the audience selectors being validated may not be saved yet). The old path is
removed in the same commit, not left dangling. Recorded as a decision (§3.4) since
it changes a committed (if unimplemented) contract shape.

### 3.2 Variable-matrix computation

```
validateCampaignAudience(tenantId, campaignId) -> VariableValidationResult
```

Reuses M4-S2's `resolveAudience()` to get the actionable set (never re-implements
eligibility), then for each actionable recipient (bounded — see §3.3) builds a
context via a new pure function:

```
recipientVariableContext(recipient, customFieldDefinitions) -> Record<string, unknown>
```

`{ email, first_name: firstName, last_name: lastName, unsubscribe_url: unsubscribeUrlFor(tenantId, recipientId), ...customData mapped by each definition's fieldKey }`
— the same key vocabulary `SYSTEM_TEMPLATE_VARIABLES`/`RESERVED_CUSTOM_FIELD_KEYS`
already establish, so a key that resolves in this context is exactly a key that
would resolve in the real send.

Each context is passed straight into the existing `renderTemplateVariables(template,
schema, context)` in non-preview mode (bug-for-bug identical to what M5-S3 will
call later) to get `missingKeys` per recipient (via a wrapper that always returns
`missingKeys` instead of throwing, since the matrix needs the full picture, not a
first-failure).

```
VariableValidationResult {
  totalActionable: number
  completeCount: number
  missingCount: number
  missingByVariable: { key: string; label: string; count: number }[]
  unsubscribeUrlIssue: boolean   // true only if generation itself fails (config), not a per-recipient case
  sample: { recipientId, email, missingKeys: string[] }[]   // bounded, mirrors M4-S2's AudienceResolution.sample
}
```

`unsubscribe_url` is folded into the same per-recipient context (so a missing
`unsubscribe_url` shows up in `missingKeys`/`missingByVariable` like any other
required key) — BR-TPL-008 does not need a parallel code path, just a system key
that is always populated by `recipientVariableContext` rather than possibly
absent like a custom field.

### 3.3 `unsubscribe_url` generation

`unsubscribeUrlFor(tenantId, recipientId) = `${WEB_ORIGIN}/unsubscribe/${recipientId}``
— a real, unique, deterministic value per recipient, generated with existing
config (`WEB_ORIGIN`, already required). No new secret, no signing: nothing
redeems this URL yet (§ non-goals), so a signed/HMAC token would be securing an
endpoint that does not exist — premature per this run's own DEC-056 precedent
("don't build infrastructure for a capability that doesn't exist yet"). The path
shape is deliberately stable so a future redemption-endpoint node does not need to
reissue every previously-generated link.

### 3.4 BR-CMP-005's "accepted resolution path"

No snapshot exists yet to record skip reasons into (M4-S4). The accepted-resolution
decision is instead persisted on the draft itself, additively, inside the existing
`settings_json` column (no new migration — mirrors DEC-056's reasoning):

```
CampaignSettings { cc?, bcc?, audienceWaiver?: { acceptedAt: string; acceptedBy: string; missingVariableRecipientIds: string[] } }
```

Setting it goes through the *existing* `updateCampaignDraft` PATCH (no new mutation
endpoint) with a new audit log action (`campaign.audience_waiver_accepted`), which
satisfies "quyết định được audit" without inventing send/snapshot infrastructure.
`validateCampaignAudience`'s response includes whether the current draft already
has a waiver and whether it still covers the current `missingKeys` set (a draft
edit that changes the audience must invalidate a stale waiver — checked by
comparing the waiver's recorded recipient-id set against the fresh validation's
own missing-recipient set).

### 3.5 Recorded decisions carried into EXECPLAN §20

- The `arch_contracts`-era stub reshape (§3.1).
- BR-TPL-008's "transactional campaign có policy riêng" clause: no transactional
  campaign type exists anywhere in this catalog or schema; the marketing/bulk
  clause is what this slice closes, the transactional clause is recorded as N/A
  to the current product surface, not fabricated.
- No public unsubscribe redemption endpoint built (non-goals, above) — named gap,
  no owning node yet, same honesty standard as M4-S2's DEC-057 (`suppressed`).
- `unsubscribe_url` generation is unsigned/unauthenticated by design until a real
  redemption endpoint exists to need it.

---

## 4. HTTP surface (reserved prefix `/campaigns/{campaignId}/validate-audience`)

| Method | Path | operationId | Permission | Returns |
|--------|------|-------------|------------|---------|
| POST | `/campaigns/{campaignId}/validate-audience` | `validateCampaignAudience` | `content:manage` | 200 `VariableValidationResult` |

Read-only/side-effect-free (reads the *saved* draft's audience/template, unlike
M4-S2's preview which takes an unsaved audience in the body — this one has nothing
new to preview, the draft is already the source of truth once a template is
chosen). Empty body. 404 if the draft has no `templateId`/`templateVersionId` yet
(cannot validate variables with nothing to render) — the UI only offers `sendConfirm`
once a template is attached, matching M4-S1/M3's own precedent for template-gated
actions.

---

## 5. Checkpoints

**CP1 — `recipientVariableContext` + `unsubscribeUrlFor`, RED first.** Pure unit
tests: system keys, custom-field mapping, missing-field omission (never `null`
injected for an absent custom field — must be genuinely absent so the renderer's
own missing-check fires), `unsubscribe_url` always present and unique per recipient.

**CP2 — `validateCampaignAudience` service, RED first.** Real PostgreSQL: reuses
`resolveAudience`, builds a context per actionable recipient, calls
`renderTemplateVariables`, aggregates. A2/A4/A9 are first-class tests.

**CP3 — HTTP + waiver persistence.** `validateCampaignAudience` endpoint;
`updateCampaignDraft` accepts `settings.audienceWaiver`, audited; staleness check
when the audience changes after a waiver was recorded.

**CP4 — contract.** OpenAPI: remove the stale `validate-audience` template stub,
add the reshaped campaign-scoped path additively for everything else,
`openapi-compat-check` (expected to flag the *removal* as breaking against the
stub — record why that specific removal is acceptable: the stub was never
implemented, so nothing real depends on its shape), regenerate `packages/contracts`.

**CP5 — web.** `sendConfirm` overlay ported from the handoff, wired to real
validation data; CTA gating per BR-CMP-008; enabling the "Gửi ngay" trigger button
on `ComposeDraftScreen` to open it (still no real terminal send action — the CTA's
click target stays a recorded non-goal, matching M4-S1's mock buttons).

**CP6 — VISUAL EVIDENCE (Claude, solo, same as M4-S2 CP6/CP7 combined).** Capture,
individually inspect, close BR-CMP-004/005/006/008 and BR-TPL-008 in traceability,
update screen-catalog.yaml, record decisions, re-verify, close the node.
