# M5-S1 Sender Configuration Implementation Plan

Node: `M5-S1-sender-config` · Depends on: `M1-GATE` (closed) — **independent of M4**, which is why
it can run alongside M4-S2 and M6-S2.
Owns rules: **BR-CFG-001**, **BR-CFG-002**, **BR-CFG-003**, **BR-CFG-004**, **BR-CFG-005**, **BR-CFG-007**
Screens: `UI-CFG-001` (`/settings/senders`), `UI-CFG-002` (`/settings/policy`) — both
`not_inventoried` · Overlay: `sender`
Reserved: migration **020**, `DEC-061…065`, `D-51…55`

Read [`PARALLEL-EXECUTION-PROTOCOL.md`](PARALLEL-EXECUTION-PROTOCOL.md) first.

---

## 1. Outcome

A tenant admin can configure real sender identities, verify them, test the connection against a
real SMTP server, and set a default sending policy — with credentials that **never come back out
of the API and never reach a log or an audit row**.

This node is the one in the whole run where a mistake is a security incident rather than a bug.
BR-CFG-001's acceptance is explicit: `GET` returns masked metadata only; logs and audit contain no
credential. Treat every "just for debugging" print of a config object as a defect.

### The six rules

| Rule | Requirement |
|------|-------------|
| BR-CFG-001 | Admin configures sender identity/account; the secret lives in a secret store, referenced not embedded. `GET` returns masked metadata; no credential in log or audit. |
| BR-CFG-002 | A sender must be `verified` **and** active before use; campaign validation blocks `pending`/`failed`/`disabled`. |
| BR-CFG-003 | Admin can test the connection **without persisting a bad secret**. Finite timeout, safe error code, no password/token echoed, audit records the outcome. |
| BR-CFG-004 | `From` must belong to a verified sender identity; `Reply-To` is validated and may differ. Spoofed addresses rejected; message headers match configuration. |
| BR-CFG-005 | A common provider-adapter interface so SMTP/API providers swap without touching campaign domain code. The adapter normalises send result, error classification and webhook event. |
| BR-CFG-007 | Disabling a sender does not delete history; scheduled campaigns using it become `blocked`; history still shows the sender snapshot; owner is notified. |

### Hard non-goals

- **No sending.** M5-S3 sends campaigns; this node only proves a connection can be opened.
  `templates.service.ts` already sends test emails via nodemailer against Mailpit — reuse that
  transport knowledge; do not build a second sending path.
- **No quota.** BR-CFG-006 is M7-S1, deliberately excluded from this node's rule list.
- **No scheduling.** BR-CFG-007 says scheduled campaigns become `blocked` — but scheduling does not
  exist until M5-S2. Implement the *sender-side* state change and the rule that a disabled sender
  is unusable; record that the scheduled-campaign transition is verified by M5-S2 when there is
  something to transition. Do not fake a scheduled campaign to claim the clause.
- **No real secret manager.** There is none in this deployment. See §3.2 — this must be an explicit,
  recorded decision, not an unspoken shortcut.

---

## 2. Acceptance criteria

| # | Criterion | Rule | Proof layer |
|---|-----------|------|-------------|
| A1 | Creating a sender stores a secret reference; the plaintext secret is not in the row | BR-CFG-001 | integration + direct SQL inspection |
| A2 | `GET` (list and detail) never returns the secret in any field, at any nesting level — asserted by scanning the whole serialised response, not named fields | BR-CFG-001 | integration |
| A3 | No `audit_log` row and no log line produced by this module contains the secret | BR-CFG-001 | integration (query `audit_log`) |
| A4 | A `pending`/`failed`/`disabled` sender is rejected for use with a distinct, typed error | BR-CFG-002 | integration |
| A5 | Test-connection against real Mailpit succeeds; against a wrong port fails with a safe classified code and **no** credential echo, within a finite timeout | BR-CFG-003 | integration (real SMTP) |
| A6 | Test-connection with a bad secret does **not** persist that secret | BR-CFG-003 | integration |
| A7 | A `From` outside the verified identity is rejected; a differing valid `Reply-To` is accepted | BR-CFG-004 | unit + integration |
| A8 | Two adapters satisfy one interface; result/error classification is normalised across both | BR-CFG-005 | unit |
| A9 | Disabling a sender preserves history rows and blocks further use | BR-CFG-007 | integration |
| A10 | Cross-tenant read/write of a sender config is impossible | domain invariant | integration |
| A11 | `/settings/senders` and `/settings/policy` render all required states, including a real non-admin `permission_denied` | BR-AUTH-004 | e2e + **visual (Claude)** |

---

## 3. Locked design

### 3.1 Migration 020

New: `sender_config` (`id`, `tenant_id`, `name`, `from_name`, `from_email`, `reply_to`,
`provider` (`smtp` for MVP), `host`/`port`/`username` as needed, `secret_ref`,
`status` CHECK `('pending','verified','failed','disabled')`, `verified_at`, `last_tested_at`,
`created_by`, `updated_by`, `created_at`, `updated_at`, `deleted_at`) plus `sending_policy`
(tenant-scoped defaults for `UI-CFG-002`).

Every column added to any existing table needs a `DEFAULT` (protocol §5). New tables need
`GRANT SELECT, INSERT, UPDATE, DELETE ... TO eow_app` **and** an RLS policy using
`current_tenant_id()` — `016_template_test_sends.sql` is the template to copy, and M3-S3's review
found a migration shipped with **zero grants**, invisible to owner-connected tests. Add an
integration test that connects as `eow_app` (`testAppDatabaseUrl()` already exists for this).

Status vocabulary comes from BR-CFG-002's own words (`pending`/`failed`/`disabled` + `verified`) —
write the complete domain from the rule text on the first pass. This is the D-41 lesson: M4-S1
wrote a CHECK from "what this slice happens to write" and broke a sibling milestone's test.

### 3.2 Secrets — the decision that must be written down

BR-CFG-001 says "secret manager". This deployment has none: `compose.yaml` and `.env` are the
whole configuration surface, and adding a real secret manager is infrastructure no rule in this
run asks for and no approval covers.

Required shape regardless of choice: the **column is `secret_ref`, never `secret`**, so the schema
stays correct when a real manager arrives. For MVP the reference resolves through a small
`SecretStore` interface with one implementation reading an env-var-backed local store; the
interface is the seam a future manager plugs into (the same reasoning ADR-014 used for provider
adapters).

Encrypting the secret at rest in PostgreSQL with an env-held key is **not** meaningfully better
than the env store and adds a key-rotation problem this run cannot own — if that path is taken
anyway, say why in the decision. What is not acceptable is a plaintext `secret` column with a
comment promising to fix it later.

Storing a secret at all is a STOP-gate-adjacent area: AGENTS.md excludes "secrets, credentials or
paid external services outside configured local dev tooling". Local Mailpit is configured local
dev tooling and is fine. If the human asks for a real provider's credentials, that is a STOP gate.

### 3.3 Provider adapter (BR-CFG-005)

```
interface EmailProviderAdapter {
  testConnection(config): Promise<ProviderProbeResult>
  send(message): Promise<ProviderSendResult>       // used by M5-S3, defined here
  classifyError(error): ProviderErrorClass          // permanent | transient | auth | config
  parseWebhookEvent(payload): ProviderWebhookEvent  // shape only; M5-S4 consumes it
}
```

Only the SMTP implementation ships. A8 proves the interface is real by testing classification
against a second, in-memory fake adapter — not by shipping a second production provider. Defining
`send`/`parseWebhookEvent` now without implementing their consumers is deliberate: ADR-014's
adapter boundary is what keeps M5-S3/M5-S4 from rewriting the domain. Do not build the worker.

### 3.4 HTTP surface (reserved prefixes `/sender-configs*`, `/sending-policy*`)

| Method | Path | operationId | Permission |
|--------|------|-------------|------------|
| GET | `/sender-configs` | `listSenderConfigs` | `settings:manage` |
| POST | `/sender-configs` | `createSenderConfig` | `settings:manage` |
| GET | `/sender-configs/{senderConfigId}` | `getSenderConfig` | `settings:manage` |
| PATCH | `/sender-configs/{senderConfigId}` | `updateSenderConfig` | `settings:manage` |
| DELETE | `/sender-configs/{senderConfigId}` | `disableSenderConfig` | `settings:manage` |
| POST | `/sender-configs/{senderConfigId}/test-connection` | `testSenderConnection` | `settings:manage` |
| GET/PUT | `/sending-policy` | `getSendingPolicy` / `updateSendingPolicy` | `settings:manage` |

`settings:manage` is admin-only in `004_rbac.sql` — exactly matching BR-CFG-001's "Admin cấu hình".
DELETE is `disableSenderConfig`, not a hard delete: BR-CFG-007 requires history to survive.

`test-connection` accepts an unsaved candidate secret in its body so A6 is satisfiable, and it must
carry an `Idempotency-Key`-style guard or a short rate limit — an unauthenticated-adjacent probe
endpoint that opens arbitrary outbound connections is an SSRF-shaped risk. Restrict target host/port
to the configured allowlist or the tenant's own stored config; do not let the body name any host.
**That restriction is a security requirement, not a nicety — record it as a decision.**

---

## 4. Checkpoints

Each ends with a commit and an inbox section. Codex writes none of the four shared artifacts.

**CP1 — migration 020 + entities**, applied and proven idempotent, with the `eow_app` grant/RLS
test (§3.1).
**CP2 — secret store + adapter interface, RED first.** Pure units: masking, `From`/`Reply-To`
validation (A7), error classification (A8).
**CP3 — CRUD service/controller, RED first.** A1/A2/A3/A4/A9/A10 against real PostgreSQL. A2's
assertion scans the whole serialised response for the secret substring.
**CP4 — test-connection against real Mailpit.** A5/A6, finite timeout, safe classification, audit
row with outcome and no credential.
**CP5 — contract.** One additive OpenAPI edit, committed immediately (protocol §3.3).
**CP6 — web.** `/settings/senders` and `/settings/policy` replacing the `ComingSoon` placeholders,
plus the `sender` overlay (handoff `action-overlays.tsx` L102-105: `.choice-list` radio rows with
avatar/name/email and a default badge). This node is the **only** one permitted to edit
`AppRoutes.tsx`/`nav.ts` (protocol §3.4).
**CP7 — VISUAL HANDOFF.** Capture block as a patch proposal in the inbox; do not run or judge it;
stop.
**CP8 — Claude.** Captures, image inspection, artifact merge, independent re-verification, close.

---

## 5. Risks

| Risk | Mitigation |
|------|-----------|
| A secret leaks into a response, log or audit row | A2/A3 assert on the serialised whole, not named fields. Any new logging in this module is reviewed as a security change. |
| `test-connection` becomes an SSRF primitive | Host/port restricted to configured allowlist or the tenant's own config; rate-limited; recorded decision (§3.4). |
| Status vocabulary written from this slice's needs only | Taken verbatim from BR-CFG-002 on the first pass — the D-41 lesson. |
| Migration ships without grants/RLS | Explicit `eow_app`-connected test, the gap M3-S3's review found. |
| Scope creep into sending | `send()` is defined on the interface and left unimplemented here by design; no worker code. |
