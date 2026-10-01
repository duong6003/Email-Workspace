import { Module } from '@nestjs/common';
import { SenderConfigController } from './sender-config.controller.js';
import { SenderConfigService } from './sender-config.service.js';
import { IdempotencyService } from '../common/idempotency.service.js';
@Module({ controllers: [SenderConfigController], providers: [SenderConfigService, IdempotencyService], exports: [SenderConfigService] })
export class SenderConfigModule {}
