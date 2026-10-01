import { Module } from '@nestjs/common';
import { IdempotencyService } from '../common/idempotency.service.js';
import { TemplatesController } from './templates.controller.js';
import { TemplatesService } from './templates.service.js';

@Module({ controllers: [TemplatesController], providers: [TemplatesService, IdempotencyService] })
export class TemplatesModule {}
