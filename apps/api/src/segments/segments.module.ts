import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { SegmentsController } from './segments.controller.js';
import { SegmentsService } from './segments.service.js';

@Module({ imports: [AuthModule], controllers: [SegmentsController], providers: [SegmentsService], exports: [SegmentsService] })
export class SegmentsModule {}
