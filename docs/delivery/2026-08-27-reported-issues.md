# Reported issues — 2026-08-27

Eight items raised after reviewing the deployed build at `localhost:8080`. Each entry
records where the behaviour actually lives, so the next agent does not have to
re-locate it. Nothing here is fixed yet except item 2, which was already resolved.

---

## 1. The account chip logs you out on a single click

**Status:** confirmed, cause identified.

`apps/web/src/app/AppShell.tsx:184` renders the whole account chip as a logout button:

```tsx
<button className="profile" onClick={handleSignOut} disabled={signingOut} aria-label="Đăng xuất" title="Đăng xuất">
  <span>{initials}</span>
  <div><b>{displayName}</b><small>{role}</small></div>
  <i><UiIcon name="chevronDown" size={15} /></i>
</button>
```

The chevron-down icon is the conventional signal for "this opens a menu". The control
is labelled as logout, but it *looks* like a dropdown, so a click intended to open
account options signs the user out instead — with no confirmation and no way back
except logging in again.

**Fix direction:** make the chip open a menu (profile, theme, sign out) and move the
logout to an item inside it. `EntityActionMenu` already exists in
`apps/web/src/components/` and is the established pattern for this in the codebase.
If a menu is not wanted, remove the chevron and keep the destructive action explicit —
but a one-click, unconfirmed logout on the most-clicked corner of the header is the
underlying problem, not the icon.

---

## 2. Does a production deploy need mailpit?

**Status:** already resolved in commit `667e014`.

No. mailpit now sits behind the `dev` compose profile, so a production bring-up
(`docker compose --env-file .env up -d --build --wait`, no `--profile`) never starts it.
`SMTP_HOST` and `SMTP_FROM` became required variables in the same commit, so a
deployment that forgets them fails at `compose config` time instead of silently
routing real campaign mail into a dev catcher.

One wrinkle worth knowing: the `deploy:*` scripts in `package.json` all pass
`--profile dev`, so `pnpm deploy:up` still starts mailpit locally. That is deliberate
for developer convenience, but it means `pnpm deploy:up` is no longer a faithful
production simulation. Production uses the raw compose command without the profile.

---

## 3. Template import: suggest missing variables and route the user to add them

**Status:** feature request.

When an imported template references a variable that does not exist, the import
surfaces the problem but leaves the user to find where to define it. The request is to
(a) propose creating the missing variable, and (b) give a control that navigates
straight to the place it gets added.

**Where this lives:** `apps/api/src/templates/template-variables.ts` already classifies
tokens and reports `UNKNOWN_VARIABLE`; `template-analysis.ts` builds the catalogue that
distinguishes `system` / `custom` / `unknown` sources. The analyze endpoint already
returns `unknownVariables` with a `suggestedActions` array — check what that array
currently carries before designing new API surface, because the affordance may already
be half-built server-side. Variables can be defined per template
(`/templates/:templateId/variables`) or tenant-wide (`/global-variables`), so the
suggestion has to offer the right destination rather than assuming one.

---

## 4. Remove "Đã đồng bộ" from the header

**Status:** confirmed, trivial.

`apps/web/src/app/AppShell.tsx:172`:

```tsx
{isAutosaveCompose ? saveStateText[saveState] : 'Đã đồng bộ'}
```

Outside the autosave-compose screens the badge is a hardcoded string that reports
nothing — it says "synced" regardless of any actual state. On the autosave screens it
does carry real state (`saving` / `saved` / `conflict` / `error`, defined at line 72).

**Fix direction:** render the badge only when `isAutosaveCompose` is true, rather than
deleting the element outright — the autosave states are load-bearing. See the comment
at `apps/web/src/screens/templates/TemplateEditorScreen.tsx:158`, which documents the
coupling between `idle` and this label.

---

## 5. Login returns 204

**Status:** confirmed as intentional; needs a decision, not a fix.

`apps/api/src/auth/auth.controller.ts:28` declares `@HttpCode(204)` on `POST
/auth/login`. The handler sets session and CSRF cookies and returns no body. 204 with
`Set-Cookie` is valid HTTP and the web client works with it.

The question is whether it *should* be 200 with a body. Arguments for changing it: the
client currently has to issue a second `GET /auth/me` to learn who logged in, and 204
means "no content" which some proxies and client libraries treat as cacheable or
strip bodies from. Argument against: it is in the published contract
(`contracts/openapi.yaml`) and the compat-check gate treats a removed response status
as breaking, so changing it is a contract change requiring an ADR under AGENTS.md §5.

Decide the intent before touching it. If the goal is to remove the extra round-trip,
that is a real improvement; if the goal is only that 204 "looks wrong", it is not.

---

## 6. No preview when choosing a template while composing a campaign

**Status:** confirmed gap.

`apps/web/src/overlays/TemplatePickerOverlay.tsx` contains no preview code at all — it
lists templates by name and selects one. Meanwhile the template library
(`TemplatesScreen`) now renders real thumbnails, and `TemplatePreviewOverlay` already
implements a full preview against `POST /template-versions/:id/preview`.

**Fix direction:** the pieces exist. `TemplateThumbnail`
(`apps/web/src/screens/templates/TemplateThumbnail.tsx`) is self-contained — it takes a
`templateId` and a poster fallback, lazy-loads by viewport, and needs no props from the
library screen. Reusing it in the picker is likely a small change. Note the picker
filters to `status: 'published'` and holds `EmailTemplateSummary[]`, which no longer
carries `html`, so the thumbnail's own per-id fetch is exactly the right mechanism.

---

## 7. "Quay lại danh sách chiến dịch" button is misaligned

**Status:** confirmed location, layout not yet diagnosed.

`apps/web/src/screens/campaigns/CampaignDetailScreen.tsx:156`:

```tsx
<Link to="/campaigns" className="secondary-button">← Quay lại danh sách chiến dịch</Link>
```

It is a `<Link>` wearing `secondary-button` styling, so it inherits button padding but
not a button's layout context, and it sits outside the header block that aligns the
rest of the screen's controls.

There is a second instance at `apps/web/src/screens/compose/ComposeDraftScreen.tsx:422`
that *is* a real `<button>`, inside an error card. Whatever alignment rule is chosen
should cover both, or they will drift apart.

---

## 8. Recipient results do not update live in campaign detail

**Status:** confirmed gap, and narrower than it first appears.

`CampaignDetailScreen.tsx` already wires realtime: it subscribes to `campaign.progress`
(line 112), applies events through `applyProgressEvent` (`campaign-realtime.ts`), and
falls back to polling at `pollIntervalMs(realtimeStatus)` (line 97).

So the campaign's *progress counters* update live. What does not is the **recipient
results list** — the per-recipient delivery rows. There is a
`recipientRefreshTimer` in the cleanup at line 114, which suggests recipient refresh
was started but is either debounced too coarsely or not triggered by the progress
event.

**Fix direction:** read `applyProgressEvent` and the `recipientRefreshTimer` logic
first to establish whether the refresh is firing at all, before adding a new
subscription. Adding a second realtime path when the existing one is merely
mis-triggered would make the screen harder to reason about. Confirm against a real
send — the worker publishes progress per completed batch interval, so a campaign with
few recipients may legitimately produce only one event.

---

# Still open — 2026-08-31

Items 1, 4, 6 and 7 above are fixed and deployed. Item 2 was already resolved. What follows
is everything still outstanding, recorded here because it otherwise existed only in a
working session.

## A. Campaign-level "Gửi thử" — needs a decision, then it is small

`SendConfirmOverlay` now resolves a real recipient and the campaign's `variableOverrides`
into merge data (`buildPreviewMergeData` in `apps/web/src/overlays/send-preview.ts`) in order
to render the preview. `sendTemplateVersionTest(versionId, mergeData, idempotencyKey)`
accepts arbitrary merge data, and the server delivers the test only to the authenticated
actor. So a campaign test send is achievable **client-side with no new endpoint**: feed the
same object the preview already built into that call, from a control beside the preview.

The decision: there is no campaign-level test-send route, so the attempt is audited as
`template_test_send` against the template version, not against the campaign. Accept that
mismatch and it is a small change; reject it and it needs a new endpoint plus its own audit
action.

The two disabled placeholder buttons that used to sit in the compose page header were
removed (`b4d1f69`). "Gửi ngay" is deliberately not coming back — sending already exists via
"Xem lại & xác nhận gửi", and a one-click path around that step would bypass the recipient
counts and real-recipient preview the step exists to show.

## B. `POST /auth/login` returns 204 — intent needs settling

Detailed as item 5 above. Nothing is broken; the question is whether the extra
`GET /auth/me` round trip after login is worth removing by returning 200 with a body. It is
a published contract change and needs an ADR under AGENTS.md §5. Decide the intent before
touching it — "204 looks wrong" is not a reason.

## C. Import-time suggestion for missing variables

Item 3 above, unchanged and unstarted. No chip exists for it. Check what the analyze
endpoint's `unknownVariables[].suggestedActions` already carries before designing new API
surface — the affordance may be half-built server-side already.

## D. The preview's unsubscribe link is a guess — verify on a real send

`buildPreviewMergeData` reconstructs `unsubscribe_url` as
`` `${webOrigin}/unsubscribe/${recipient.id}` ``, because the browser cannot read the
server's `WEB_ORIGIN`, which
`apps/api/src/campaigns/recipient-variable-context.ts`'s `unsubscribeUrlFor` uses to build
the real one. If the server's shape differs, the preview shows a link no recipient will
receive.

No test can catch this — both sides would have to agree on a guess. Compare a preview
against an actual delivered email once, and if the shapes differ, either expose the pattern
to the client or drop the key from the preview merge data so it surfaces in `missingKeys`
instead of rendering something false.

## Delegated, not finished

A background session is implementing
`docs/superpowers/specs/2026-08-31-typed-variables-date-formatting-design.md` (typed
variables, date format and timezone; ADR-036). When it lands, merge it the way the two
previous worktrees were merged — see the `worktree-merge-procedure` memory.

## E. Saving the sending policy is blocked whenever its default sender is not verified

Found while verifying the typed-variables work (2026-08-31). Pre-existing; unrelated to that
change.

`PUT /sending-policy` rejects with 409 `SENDER_NOT_USABLE` when
`default_sender_config_id` points at a sender whose status is not `verified`. The settings
form resubmits the stored id along with every other field, so once the saved default falls
out of `verified` the whole screen locks: **no field on it can be saved**, including fields
that have nothing to do with sending — the tenant's default timezone among them, now that
it lives on the same row.

Confirmed in the data:

| Tenant | Policy points at a sender | That sender's status |
| --- | --- | --- |
| Demo Workspace | yes | `verified` — screen works |
| Acme Demo | yes | `disabled` — screen is locked |

Acme Demo holds 105 sender configs and **all 105 are disabled**, mostly debris from visual
and e2e runs. So the tenant cannot pick a different default either; there is nothing valid
to point at.

Two ways out, and they are not equivalent:

- **Data.** Verify or replace the default sender in that tenant. Fixes the symptom now,
  leaves the trap in place for the next tenant that disables its default.
- **Behaviour.** Only enforce `SENDER_NOT_USABLE` when the request actually *changes*
  `defaultSenderConfigId`. Resubmitting a value that is already stored is not the user
  choosing an unusable sender — it is the form echoing back what the server gave it. This
  removes the lock without weakening the rule that a campaign cannot be sent through an
  unverified sender, which is enforced separately at send time
  (`CampaignsService`, `SENDER_NOT_USABLE` on the send path).

The second is the real fix. Decide before touching it, because it does relax a guard.

Note on scope: an earlier report of this described it as affecting the "Demo" tenant. It
does not affect `Demo Workspace` — that tenant's `alta mail` sender is `verified`, recovered
using the "Kiểm tra kết nối" button unblocked in `f2c49e5`. The locked tenant is `Acme Demo`.

---

# Resolutions — 2026-08-31

## A. Campaign test send — done

`SendPreviewPanel` now carries a "Gửi thử cho tôi" control beside the preview, sending the
same merge data the frame rendered, so "it looked right" and "it arrived right" cannot
disagree. The server delivers only to the authenticated actor.

Accepted trade-off, stated rather than hidden: it is audited as a **template** test send.
No campaign-level test-send route exists, and giving it a campaign-scoped audit trail would
mean a new endpoint and a new audit action. Revisit if the audit trail matters more than the
cost.

## B. Login 204 — decided, no change

**Keep 204.** The extra `GET /auth/me` is not waste that a body would remove: `useSession`
drives `RequireAuth` and has to run anyway, on every route change, from cache or network.
Returning a body from login would create a second source of session truth alongside that
query, and the two could disagree — which is the class of bug that made login take two
attempts in the first place (a guard reading one state while another was in flight).

The round trip costs ~50ms against a login that spends 0.2–1.1s in argon2id by design. The
change would need a contract revision and an ADR under AGENTS.md §5. Not worth it for a
status code that is already correct: 204 with `Set-Cookie` is exactly what a login that
returns no content should send.

## C. Import-time suggestion for missing variables — done, and smaller than recorded

The entry above called this unstarted. It was mostly built: the template editor already
renders each undeclared variable as a button that opens the create-variable overlay with the
key filled in (`TemplateEditorScreen.tsx`).

What was missing was the route from import to there — an import that referenced undeclared
variables left the author with a toast and a search. Importing now navigates straight to the
editor when anything is undeclared, and stays on the library when nothing is.

## D. The preview's unsubscribe link — resolved into a larger finding

The guess is **structurally correct**. `unsubscribeUrlFor` in
`apps/api/src/campaigns/recipient-variable-context.ts` builds
`` `${webOrigin.replace(/\/$/, '')}/unsubscribe/${recipientId}` `` — character for character
what the client reconstructs. Nothing to fix in the preview.

But checking it surfaced something worse, which is **not** a preview problem:

- The deployed api runs with `WEB_ORIGIN=http://localhost:8080`, so a real send would put
  `http://localhost:8080/unsubscribe/<id>` in the email — a link no recipient can open.
- There is **no `/unsubscribe` route** in the web app. The router has login, campaigns,
  email, history, recipients, templates, settings, `/` and a catch-all; unsubscribe is not
  among them.
- There is **no unsubscribe endpoint** in the api. `recipient.unsubscribedAt` exists in the
  data model, so the column is ready, but nothing can set it from a link.

So `{{unsubscribe_url}}` renders a dead link today. For bulk email that is a compliance
exposure, not a cosmetic one. Whoever implements it should note that
`/unsubscribe/<recipientId>` puts a raw, enumerable UUID in a public URL — anyone holding or
guessing an id could unsubscribe that person. A signed, expiring token is the normal shape.

Out of scope here; recorded so it is not discovered by a regulator instead.

## E. Sending policy locked by an unverified default sender — fixed

`putPolicy` now gates only a *change* of `defaultSenderConfigId`. Resubmitting the stored id
is the form echoing back what the server supplied, not the operator choosing an unusable
sender. Newly pointing the policy at an unverified sender is still refused, and sending
through one is still refused at send time by `CampaignsService`, which is where it decides
anything. Both behaviours are pinned in `sender-config-http.test.ts`.

The data problem remains and is the user's call: `Acme Demo` holds 105 sender configs and
all 105 are disabled, mostly debris from visual and e2e runs. The screen is no longer locked,
but that tenant still has no usable sender.
