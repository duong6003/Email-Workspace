export type CampaignCompletenessInput = {
  name: string;
  subject: string;
  templateVersionId: string | null;
  sender: {
    senderConfigId?: string | null;
    fromEmail?: string;
  };
  audience: {
    listIds?: string[];
    tagIds?: string[];
    recipientIds?: string[];
  };
};

/**
 * A draft's send-readiness score is intentionally derived once on the server.
 * Selector references are only checked for presence: M4-S2/M5-S1 own their
 * resolution and validity respectively.
 */
export function campaignCompleteness(draft: CampaignCompletenessInput): number {
  const hasAudience = [draft.audience.listIds, draft.audience.tagIds, draft.audience.recipientIds]
    .some((ids) => (ids?.length ?? 0) > 0);
  const hasSender = Boolean(draft.sender.senderConfigId || draft.sender.fromEmail?.trim());

  return [
    Boolean(draft.name.trim()),
    Boolean(draft.subject.trim()),
    Boolean(draft.templateVersionId),
    hasSender,
    hasAudience,
  ].filter(Boolean).length * 20;
}
