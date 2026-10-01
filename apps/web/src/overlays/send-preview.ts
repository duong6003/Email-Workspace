import type { AudienceResolution } from '../api/campaigns.js';
import type { Recipient } from '../api/recipients.js';

/**
 * apps/api/src/campaigns/audience-resolution.ts's resolveAudience() pushes
 * sample entries in query order, not actionable-first, so an all-skipped
 * prefix is possible even when the audience has actionable recipients
 * beyond the sample limit. Returning null in that case (rather than
 * silently falling back to a skipped entry) is deliberate -- see
 * SendPreviewPanel's noSampleRecipient state.
 */
export function pickPreviewRecipient(sample: readonly AudienceResolution['sample'][number][]): AudienceResolution['sample'][number] | null {
  return sample.find((entry) => entry.skipReason === null) ?? null;
}

/**
 * Mirrors apps/api/src/campaigns/recipient-variable-context.ts's real
 * send-time merge order exactly: campaign overrides seed the object, then
 * the recipient's actual fields are layered on top and win on a colliding
 * key. That file spreads `configuredValues` (which already contains
 * campaign overrides) first and `email`/`unsubscribe_url`/`first_name`/
 * `last_name`/`customData` after, so the recipient's own value beats an
 * override there -- a preview that resolved the opposite way would show an
 * override "winning" over data it will actually lose to at send time.
 *
 * One deliberate divergence: the server filters `customData` down to keys
 * present in the tenant's `customFieldDefinitions` before spreading them;
 * this function spreads all of `recipient.customData` unconditionally,
 * since the web client has no access to those definitions at this call
 * site. That's harmless here -- the template renderer only substitutes
 * placeholders it actually references, so a few extra unused keys in the
 * merge data don't change what gets rendered.
 *
 * `unsubscribe_url` is a best-effort reconstruction: the real one is built
 * from the server's WEB_ORIGIN config
 * (apps/api/src/campaigns/recipient-variable-context.ts's unsubscribeUrlFor),
 * which this client cannot read. `webOrigin` should be the browser's own
 * origin, which matches WEB_ORIGIN in every deployment this app targets.
 */
export function buildPreviewMergeData(
  recipient: Pick<Recipient, 'id' | 'email' | 'firstName' | 'lastName' | 'customData'>,
  variableOverrides: Readonly<Record<string, unknown>>,
  webOrigin: string,
): Record<string, unknown> {
  const recipientFields: Record<string, unknown> = {
    email: recipient.email,
    unsubscribe_url: `${webOrigin.replace(/\/$/, '')}/unsubscribe/${recipient.id}`,
  };
  if (recipient.firstName !== null) recipientFields.first_name = recipient.firstName;
  if (recipient.lastName !== null) recipientFields.last_name = recipient.lastName;
  for (const [key, value] of Object.entries(recipient.customData)) recipientFields[key] = value;
  return { ...variableOverrides, ...recipientFields };
}
