import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HealthModule } from './health/health.module.js';
import { CampaignsModule } from './campaigns/campaigns.module.js';
import { CampaignExportsModule } from './campaigns/exports.module.js';
import { RealtimeModule } from './realtime/realtime.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { HttpExceptionFilter } from './common/http-exception.filter.js';
import { PermissionGuard } from './common/guards/permission.guard.js';
import { AuditInterceptor } from './common/interceptors/audit.interceptor.js';
import { entities } from './database/data-source.js';
import { validateEnv } from './config/env.js';
import { AuthModule } from './auth/auth.module.js';
import { AuthGuard } from './auth/auth.guard.js';
import { RecipientsModule } from './recipients/recipients.module.js';
import { UnsubscribeModule } from './recipients/unsubscribe.module.js';
import { CustomFieldsModule } from './custom-fields/custom-fields.module.js';
import { JobsModule } from './jobs/jobs.module.js';
import { SegmentsModule } from './segments/segments.module.js';
import { TemplatesModule } from './templates/templates.module.js';
import { SenderConfigModule } from './sender-config/sender-config.module.js';
import { RetentionModule } from './retention/retention.module.js';
import { WebhooksModule } from './webhooks/webhooks.module.js';
import { QuotaModule } from './quota/quota.module.js';
import { DeadLetterModule } from './dead-letter/dead-letter.module.js';
import { ConfiguredVariablesModule } from './configured-variables/configured-variables.module.js';
import { AssetsModule } from './assets/assets.module.js';
import { ReusableBlocksModule } from './reusable-blocks/reusable-blocks.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    TypeOrmModule.forRootAsync({
      useFactory: () => ({
        type: 'postgres',
        url: process.env.DATABASE_URL,
        entities,
        synchronize: false,
        logging: false,
      }),
    }),
    AuthModule,
    CustomFieldsModule,
    RecipientsModule,
    UnsubscribeModule,
    JobsModule,
    SegmentsModule,
    TemplatesModule,
    SenderConfigModule,
    RetentionModule,
    HealthModule,
    CampaignsModule,
    CampaignExportsModule,
    NotificationsModule,
    RealtimeModule,
    WebhooksModule,
    QuotaModule,
    DeadLetterModule,
    ConfiguredVariablesModule,
    AssetsModule,
    ReusableBlocksModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
    // Deny-by-default RBAC (BR-AUTH-003/004): AuthGuard resolves the session
    // + permission set, PermissionGuard checks it. Both are global so every
    // route must opt in with @Public() or @RequirePermission() — order
    // matters, AuthGuard must run first to populate request.auth.
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
    // Convention-based audit logging (M1-S3 / BR-SEC-002): a no-op unless a
    // handler carries @AuditLog(...), so registering it globally does not
    // force every route to declare one.
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
})
export class AppModule {}
