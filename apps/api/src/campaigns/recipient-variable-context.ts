import type { CustomFieldDefinitionEntity } from '../database/entities/custom-field-definition.entity.js';
import type { RecipientEntity } from '../database/entities/recipient.entity.js';
import { issueUnsubscribeToken } from '../recipients/unsubscribe-token.js';

/**
 * Where an unsubscribe link points and what authorises it.
 *
 * One object rather than a bare `webOrigin` string so the secret cannot be
 * forgotten at a call site: ADR-049 made the link a real capability, and a
 * signature that some caller can omit is not one. Every function that builds
 * recipient context takes this, and `tsc` finds anyone who does not.
 */
export type LinkContext = {
  webOrigin: string;
  /** `SESSION_SECRET`; `unsubscribe-token.ts` derives a purpose-scoped key from it rather than using it directly. */
  unsubscribeSecret: string;
};

/**
 * BR-TPL-008: a real, unique, per-recipient value, SIGNED since ADR-049.
 *
 * It used to be a bare recipient id, and the comment here justified that with
 * "nothing redeems this URL yet, so signing it would secure a capability that
 * does not exist". That was true and it inverted the moment ADR-049 built the
 * redemption route: recipient ids travel in API responses, exports, logs and
 * forwarded mail, so an unsigned link would let anyone holding one unsubscribe
 * that person.
 *
 * Nothing breaks by requiring a signature now. The unsigned links already sent
 * never resolved -- there was no route at all -- so there is no working link to
 * keep working.
 */
export function unsubscribeUrlFor(links: LinkContext, recipientId: string): string {
  return `${links.webOrigin.replace(/\/$/, '')}/unsubscribe/${issueUnsubscribeToken(recipientId, links.unsubscribeSecret)}`;
}

/**
 * Builds the same context shape apps/api/src/templates/template-variable-renderer.ts
 * expects, from a real recipient row -- the single place that maps a
 * recipient to "what would this template actually render for them".
 * A key is present only when the recipient genuinely has a value for it
 * (BR-CMP-004/006): an absent custom field or a null name is omitted, not
 * injected as null/undefined, so the renderer's own missing-key check is
 * the one source of truth for "missing".
 */
export function recipientVariableContext(
  recipient: Pick<RecipientEntity, 'id' | 'email' | 'firstName' | 'lastName' | 'customData'>,
  customFieldDefinitions: readonly Pick<CustomFieldDefinitionEntity, 'fieldKey'>[],
  links: LinkContext,
  configuredValues: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const context: Record<string, unknown> = {
    ...configuredValues,
    email: recipient.email,
    unsubscribe_url: unsubscribeUrlFor(links, recipient.id),
  };
  if (recipient.firstName !== null) context.first_name = recipient.firstName;
  if (recipient.lastName !== null) context.last_name = recipient.lastName;
  for (const field of customFieldDefinitions) {
    if (Object.prototype.hasOwnProperty.call(recipient.customData, field.fieldKey)) {
      context[field.fieldKey] = recipient.customData[field.fieldKey];
    }
  }
  return context;
}
