import { describe, expect, it, vi } from 'vitest';
import { createRedisUserEventPublisher, userChannel } from './redis-user-publisher.js';

describe('redis user event publisher', () => {
  it('publishes notification hints to the affected user channel', async () => {
    const publish = vi.fn().mockResolvedValue(1);
    const event = { event_id: 'event-1', event_type: 'notification.read' as const, occurred_at: new Date().toISOString(), tenant_id: 'tenant-1', aggregate_id: 'user-1', version: 1, data: { notification_id: null, unread_count: 0 } };
    await createRedisUserEventPublisher({ publish } as never)(event);
    expect(userChannel('user-1')).toBe('eow:user:user-1');
    expect(publish).toHaveBeenCalledWith('eow:user:user-1', JSON.stringify(event));
  });
});
