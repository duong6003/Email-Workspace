import { Module } from '@nestjs/common';
import { CampaignExportsController } from './exports.controller.js';
import { CampaignExportsService } from './exports.service.js';

/** BR-HIS-003/BR-HIS-007. Its own module (not folded into CampaignsModule) per ARCH-MODULE's one-module-per-controller-stem convention. */
@Module({ controllers: [CampaignExportsController], providers: [CampaignExportsService] })
export class CampaignExportsModule {}
