import { Module } from '@nestjs/common';
import { RetentionController } from './retention.controller.js';
import { RetentionService } from './retention.service.js';
@Module({ controllers: [RetentionController], providers: [RetentionService], exports: [RetentionService] })
export class RetentionModule {}
