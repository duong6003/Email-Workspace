import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import type { CampaignEventPublisher } from '../campaigns/progress-event.js';

/**
 * A publish-only ioredis client, separate from RealtimeGateway's own
 * subscriber connection (ioredis connections in subscriber mode cannot
 * issue PUBLISH). WebhooksService publishes through this rather than
 * calling RealtimeGateway.publish() directly (DEC-125): with more than one
 * API replica, a direct in-process call reaches only the sockets attached
 * to the replica that happened to receive the webhook, while every replica
 * subscribes to the same Redis channels (ADR-009's Redis adapter).
 * @Injectable so tests can override this provider with a capturing mock
 * instead of asserting against a real Redis round trip.
 */
@Injectable()
export class RedisCampaignPublisher implements OnModuleDestroy {
  private readonly connection: Redis;

  constructor() {
    this.connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: 1, lazyConnect: true });
    this.connection.on('error', () => undefined);
  }

  /**
   * Routes by event_type, matching apps/worker's own
   * redis-campaign-event-publisher.ts: campaign.progress's aggregate_id is
   * a campaign id (-> eow:campaign:{id}); rt.resync_required's aggregate_id
   * is a user id (-> eow:user:{id}) -- a resync targets specific users, not
   * everyone watching a campaign, so it cannot reuse the campaign channel.
   */
  publish: CampaignEventPublisher = async (event) => {
    const id = typeof event.aggregate_id === 'string' ? event.aggregate_id : null;
    if (!id) throw new Error('Campaign realtime event requires aggregate_id.');
    const channel = event.event_type === 'rt.resync_required' ? `eow:user:${id}` : `eow:campaign:${id}`;
    await this.connection.publish(channel, JSON.stringify(event));
  };

  async onModuleDestroy(): Promise<void> {
    if (this.connection.status !== 'wait') await this.connection.quit();
  }
}
