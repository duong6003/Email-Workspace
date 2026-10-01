import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { WebhooksController } from './webhooks.controller.js';
import { WebhooksService } from './webhooks.service.js';

@Module({ imports: [RealtimeModule], controllers: [WebhooksController], providers: [WebhooksService] })
export class WebhooksModule {}
