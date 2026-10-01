import type { Redis } from 'ioredis';
import type { CampaignEventPublisher } from './campaign-send/progress-event.js';

/** Same shape as redis-job-event-publisher.ts's jobChannel/createRedisJobEventPublisher. */
export function campaignChannel(campaignId: string): string {
  return `eow:campaign:${campaignId}`;
}

/**
 * rt.resync_required targets a specific user, not everyone watching a
 * campaign (realtime.gateway.ts's own CP7 finding) -- so it cannot reuse
 * campaignChannel/the campaign:{id} room. Its own aggregate_id carries the
 * target user's id, not the campaign's (the affected campaign is named in
 * data.campaign_id instead).
 */
export function userChannel(userId: string): string {
  return `eow:user:${userId}`;
}

/**
 * Routes by event_type, not by treating every event's aggregate_id as a
 * campaign id: campaign.progress's aggregate_id is a campaign id (->
 * eow:campaign:{id}), rt.resync_required's aggregate_id is a user id (->
 * eow:user:{id}). Conflating the two would publish a resync event to a
 * "campaign" channel keyed on a user id -- a channel nothing subscribes to.
 */
export function createRedisCampaignEventPublisher(connection: Redis): CampaignEventPublisher {
  return async (event) => {
    const id = typeof event.aggregate_id === 'string' ? event.aggregate_id : null;
    if (!id) throw new Error('Campaign realtime event requires aggregate_id.');
    const channel = event.event_type === 'rt.resync_required' ? userChannel(id) : campaignChannel(id);
    await connection.publish(channel, JSON.stringify(event));
  };
}
