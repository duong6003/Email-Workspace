# Frontend form validation convention

Apply this convention to every editable form and action overlay.

1. Mark required controls with a red `*` immediately after the label. Do not add `Bắt buộc` or `Không bắt buộc` prose to field labels.
2. Show a short helper line before submission explaining the consequence of leaving the field empty.
3. Validate deterministic rules locally before sending a request. Keep the API authoritative for tenant, permission and business-state checks.
4. On failure, map RFC 9457 `fieldErrors` back to the matching control, set `aria-invalid`, and keep one concise summary alert.
5. Do not use a disabled primary action as the only explanation. Let the user invoke the action, reveal every blocker, and move focus to the first invalid field when practical.
6. Clear a field error when that field changes; do not clear unrelated errors.

Reusable helpers live in `apps/web/src/api/frontend-validation.ts`. The compose, sender configuration and template import flows are reference implementations.

## Overlay and action conventions

1. Build new dialogs with `apps/web/src/components/ModalFrame.tsx`; select `small`, `medium`, `large` or `workspace` by content density instead of defining local modal dimensions.
2. Use `apps/web/src/components/EntityActionMenu.tsx` for the `…` control. Keep the trigger icon-only, put text plus a semantic icon inside the menu and place destructive actions last with the danger tone.
3. An update dialog starts with editable fields and ends with the shared `Hủy` / primary confirmation convention. Destructive actions require a separate confirmation state or dialog.
4. When a value can inherit or override a higher-level value, use `apps/web/src/components/OverrideChoice.tsx`; do not invent a different toggle or radio layout per screen.
5. Dialog content must own vertical scrolling while the header and footer remain visible. Use `workspace` only for authoring surfaces that need a persistent context panel.
