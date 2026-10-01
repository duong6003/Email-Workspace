import { Module } from '@nestjs/common';
import { IdempotencyService } from '../common/idempotency.service.js';
import { DeadLetterController } from './dead-letter.controller.js';
import { DeadLetterService } from './dead-letter.service.js';

@Module({ controllers: [DeadLetterController], providers: [DeadLetterService, IdempotencyService] })
export class DeadLetterModule {}
