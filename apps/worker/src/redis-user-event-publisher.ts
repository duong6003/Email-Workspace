import type { Redis } from 'ioredis';
import type { NotificationEventPublisher } from './notification-writer.js';

export function userEventChannel(userId: string): string {
  return `eow:user:${userId}`;
}

export function createRedisUserEventPublisher(connection: Redis): NotificationEventPublisher {
  return async (event) => {
    const userId = typeof event.aggregate_id === 'string' ? event.aggregate_id : null;
    if (!userId) throw new Error('User realtime event requires aggregate_id.');
    await connection.publish(userEventChannel(userId), JSON.stringify(event));
  };
}
