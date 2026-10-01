import { describe, expect, it, vi } from 'vitest';
import { createRedisUserEventPublisher, userEventChannel } from './redis-user-event-publisher.js';

describe('redis user event publisher', () => {
  it('publishes a notification hint to the target user room channel', async () => {
    const publish = vi.fn().mockResolvedValue(1);
    const event = { aggregate_id: 'user-1', event_type: 'notification.created' };
    await createRedisUserEventPublisher({ publish } as never)(event);
    expect(userEventChannel('user-1')).toBe('eow:user:user-1');
    expect(publish).toHaveBeenCalledWith('eow:user:user-1', JSON.stringify(event));
  });
});
