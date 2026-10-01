import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';

export const ORG_CHANNEL_PREFIX = 'eow:org:';
export const orgChannel = (tenantId: string): string => `${ORG_CHANNEL_PREFIX}${tenantId}`;
export type OrgEventPublisher = (tenantId: string, envelope: unknown) => Promise<void>;

export function createRedisOrgEventPublisher(connection: Redis): OrgEventPublisher {
  return async (tenantId, envelope) => {
    await connection.publish(orgChannel(tenantId), JSON.stringify(envelope));
  };
}

@Injectable()
export class QuotaOrgPublisher implements OnModuleDestroy {
  private readonly connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: 1, lazyConnect: true });
  readonly publish = createRedisOrgEventPublisher(this.connection);
  constructor() { this.connection.on('error', () => undefined); }
  async onModuleDestroy(): Promise<void> { if (this.connection.status !== 'wait') await this.connection.quit(); }
}
