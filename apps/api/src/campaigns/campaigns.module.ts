import { Module } from '@nestjs/common';
import { IdempotencyService } from '../common/idempotency.service.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { CampaignsController } from './campaigns.controller.js';
import { CampaignsService } from './campaigns.service.js';
import { QuotaModule } from '../quota/quota.module.js';

@Module({
  imports: [NotificationsModule, QuotaModule],
  controllers: [CampaignsController],
  providers: [CampaignsService, IdempotencyService],
  exports: [CampaignsService],
})
export class CampaignsModule {}
