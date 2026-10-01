import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { QuotaOrgPublisher } from './quota-org-publisher.js';
import { QuotaService } from './quota.service.js';
import { QuotaController } from './quota.controller.js';

@Module({ imports: [NotificationsModule], controllers: [QuotaController], providers: [QuotaService, QuotaOrgPublisher], exports: [QuotaService] })
export class QuotaModule {}
