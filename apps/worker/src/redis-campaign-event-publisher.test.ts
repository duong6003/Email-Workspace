import { describe, expect, it, vi } from 'vitest';
import { campaignChannel, createRedisCampaignEventPublisher, userChannel } from './redis-campaign-event-publisher.js';
import type { ProgressEvent, ResyncEvent } from './campaign-send/progress-event.js';

describe('redis-campaign-event-publisher', () => {
  it('campaignChannel names eow:campaign:{campaignId}', () => {
    expect(campaignChannel('c-1')).toBe('eow:campaign:c-1');
  });

  it('userChannel names eow:user:{userId}', () => {
    expect(userChannel('u-1')).toBe('eow:user:u-1');
  });

  it('routes rt.resync_required to the user channel, not the campaign channel', async () => {
    const publish = vi.fn().mockResolvedValue(1);
    const connection = { publish } as unknown as { publish: typeof publish };
    const publisher = createRedisCampaignEventPublisher(connection as never);

    const resync: ResyncEvent = {
      event_id: 'e-2', event_type: 'rt.resync_required', occurred_at: '2026-08-18T00:00:00.000Z',
      tenant_id: 't-1', aggregate_id: 'u-1', version: 0, data: { campaign_id: 'c-1' },
    };

    await publisher(resync);

    expect(publish).toHaveBeenCalledWith('eow:user:u-1', JSON.stringify(resync));
  });

  it('publishes the serialized event to the channel named after aggregate_id', async () => {
    const publish = vi.fn().mockResolvedValue(1);
    const connection = { publish } as unknown as { publish: typeof publish };
    const publisher = createRedisCampaignEventPublisher(connection as never);

    const event: ProgressEvent = {
      event_id: 'e-1', event_type: 'campaign.progress', occurred_at: '2026-08-18T00:00:00.000Z',
      tenant_id: 't-1', aggregate_id: 'c-1', version: 3,
      data: { campaign_id: 'c-1', execution_id: 'ex-1', status: 'sending', total: 10, actionable: 10, percent: 30, counts: { pending: 0, queued: 0, submitted: 3, delivered: 0, bounced: 0, failed: 0, skipped: 0, cancelled: 0 }, queued: 0, sent: 3, delivered: 0, failed: 0, eta: null },
    };

    await publisher(event);

    expect(publish).toHaveBeenCalledWith('eow:campaign:c-1', JSON.stringify(event));
  });

  it('throws when aggregate_id is missing (a campaign realtime event always names its campaign)', async () => {
    const publish = vi.fn().mockResolvedValue(1);
    const connection = { publish } as unknown as { publish: typeof publish };
    const publisher = createRedisCampaignEventPublisher(connection as never);

    await expect(publisher({ aggregate_id: null } as never)).rejects.toThrow();
  });
});
