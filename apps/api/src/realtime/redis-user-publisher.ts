import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import type { NotificationRealtimeEvent } from './notification-event.js';

export const USER_CHANNEL_PREFIX = 'eow:user:';
export const userChannel = (userId: string): string => `${USER_CHANNEL_PREFIX}${userId}`;
export type UserEventPublisher = (event: NotificationRealtimeEvent) => Promise<void>;

export function createRedisUserEventPublisher(connection: Pick<Redis, 'publish'>): UserEventPublisher {
  return async (event) => {
    await connection.publish(userChannel(event.aggregate_id), JSON.stringify(event));
  };
}

@Injectable()
export class RedisUserPublisher implements OnModuleDestroy {
  private readonly connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: 1, lazyConnect: true });
  readonly publish = createRedisUserEventPublisher(this.connection);
  constructor() { this.connection.on('error', () => undefined); }
  async onModuleDestroy(): Promise<void> { if (this.connection.status !== 'wait') await this.connection.quit(); }
}
