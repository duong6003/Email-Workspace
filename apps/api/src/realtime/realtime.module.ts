import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { RealtimeGateway } from './realtime.gateway.js';
import { RedisCampaignPublisher } from './redis-campaign-publisher.js';
import { RedisUserPublisher } from './redis-user-publisher.js';

@Module({
  imports: [AuthModule],
  providers: [RealtimeGateway, RedisCampaignPublisher, RedisUserPublisher],
  exports: [RealtimeGateway, RedisCampaignPublisher, RedisUserPublisher],
})
export class RealtimeModule {}
