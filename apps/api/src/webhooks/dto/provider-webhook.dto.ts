export type ProviderWebhookResult = {
  status: 'applied' | 'duplicate' | 'ignored' | 'unmatched';
  eventId: string | null;
};
