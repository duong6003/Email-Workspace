# Preview at send confirmation — design

**Status:** agreed with the product owner 2026-08-27. Ready to plan.

**Decision:** the email preview moves out of the compose screen's right-hand panel and
into the send-confirmation step, rendered from real campaign data rather than fictional
samples.

---

## Why

A preview answers one question: *is this the email these people will receive?* That
question is asked at the moment of committing to send, not while assembling the draft.
Today it sits in a tab beside the composer, and three things are wrong with it.

**It renders the wrong data.** `ComposePreviewPanel` in
`apps/web/src/screens/compose/ComposeDraftScreen.tsx` builds its merge data from two
hardcoded fictional recipients:

```ts
const { label: _label, initials: _initials, name: _name, ...mergeData } = PREVIEW_SAMPLES[sample];
void previewTemplateVersion(templateVersionId, mergeData)
```

`state.draft.settings.variableOverrides` is never passed. So a user who types a
campaign-specific value in the "Tùy chỉnh nội dung cho lượt gửi này" block on the left,
then opens the preview on the right, sees the template's default instead of the value
they just entered. The preview contradicts the form beside it. **This is a live defect,
not merely a design weakness — do not carry it into the new location.**

**The confirmation step already owns the numbers, and only lacks the picture.**
`SendConfirmOverlay` (`apps/web/src/overlays/SendConfirmOverlay.tsx`) already displays
`validation.completeCount`, `validation.missingCount`, `sendableCount`, `skippedCount`,
`totalSnapshot`, the sender address and the template name. It receives `campaignId` and
the whole `draft`, so `templateVersionId` and `settings.variableOverrides` are already in
scope — no prop changes are needed. Adding the render completes a readiness gate that is
otherwise numeric only.

**The compose panel's other tab has no target.** A campaign owns no content of its own;
the content is the pinned template version. Nothing on the compose screen accepts typed
`{{variables}}`, so the read-only "Biến dữ liệu" catalogue lists tokens with nowhere to
put them, and lists every system and recipient variable regardless of whether the chosen
template uses any of them.

## Three traps

**1. The two previews use different containment, and the richer one is the weaker one.**

| Component | Renders with |
| --- | --- |
| `TemplatePreviewOverlay` (in `TemplatesScreen.tsx:163`) | `dangerouslySetInnerHTML` |
| `ComposePreviewPanel` (in `ComposeDraftScreen.tsx:233`) | `<iframe sandbox="" srcDoc>` |

Reuse `TemplatePreviewOverlay`'s **layout** — the summary aside, the missing-key list,
the sample switcher — and keep the **iframe**. This is not only a sanitiser-defence
argument. With `dangerouslySetInnerHTML` the application's global CSS cascades into the
email markup, so the preview shows something no recipient will ever see. The iframe makes
the preview accurate as well as contained. While here, move
`TemplatePreviewOverlay` onto an iframe too.

**2. Render against a real recipient, with the campaign's overrides applied.**

The pieces exist; no new API surface is required:

```
POST /campaigns/:id/audience/preview   → AudienceResolution.sample[] (recipientId, email, displayName)
GET  /recipients/:id                   → that recipient's custom field values
POST /template-versions/:id/preview    → render with { ...recipientFields, ...variableOverrides }
```

`AudienceSampleEntry` carries no field values, which is why the second call is needed.
Decide precedence deliberately and state it in the UI: a campaign override is set *for
this send*, so it should win over the recipient's own value — but confirm that against
how the worker merges at send time (`apps/worker/src/campaign-send/`), because a preview
that resolves differently from the real send is worse than no preview.

**3. `missingKeys` must stay visible.** The server decides what is missing; hiding it
turns an email that cannot be rendered for a real recipient into one that looks complete.
The existing panel gets this right — keep it.

## Scope

1. Render the preview inside `SendConfirmOverlay`, beside the counts it already shows.
2. Drive it from a real audience recipient plus `settings.variableOverrides`.
3. Keep iframe containment; convert `TemplatePreviewOverlay` to an iframe as well.
4. Remove the "Xem trước" tab from the compose right-hand panel.
5. Decide the fate of the remaining "Biến dữ liệu" tab — see open questions.

## Open questions for the product owner

- **`ScheduleSendOverlay` too?** Scheduling is the other terminal commitment
  (queued vs scheduled are separate paths by design). A preview that guards only one of
  the two doors is a half-gate. Recommend including it; confirm before building.
- **What happens to "Biến dữ liệu"?** Either drop the tab and the panel with it, or
  repurpose it to show only the variables the *chosen template* requires together with
  how much of the audience can satisfy them. The second is more valuable and larger; it
  overlaps the counts `SendConfirmOverlay` already computes, so decide whether that
  belongs here at all.
- **Which recipient?** First actionable entry in the audience sample, or a picker over
  the sample. A picker costs little and lets an operator check a recipient they suspect
  has thin data.

## Out of scope

Reported issue #3 (suggesting missing variables during template import) is a different
surface — it lives in the template editor and touches
`apps/api/src/templates/template-variables.ts`. Keep it in its own session.

## Acceptance

- Typing a value in "Tùy chỉnh nội dung cho lượt gửi này" changes what the preview
  renders. This is the regression that motivated the work; pin it with a test.
- The preview shows a real recipient's data, and names that recipient on screen.
- `missingKeys` still surfaces.
- No email markup is injected into the application's DOM anywhere.
- The compose screen no longer has a "Xem trước" tab.
