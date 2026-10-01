import { DataSource, type DataSourceOptions } from 'typeorm';
import { AppUserEntity } from './entities/app-user.entity.js';
import { OutboxEventEntity } from './entities/outbox-event.entity.js';
import { TenantEntity } from './entities/tenant.entity.js';
import { UserSessionEntity } from './entities/user-session.entity.js';
import { LoginAttemptEntity } from './entities/login-attempt.entity.js';
import { PasswordResetTokenEntity } from './entities/password-reset-token.entity.js';
import { AuditLogEntity } from './entities/audit-log.entity.js';
import { RoleEntity } from './entities/role.entity.js';
import { PermissionEntity } from './entities/permission.entity.js';
import { RolePermissionEntity } from './entities/role-permission.entity.js';
import { UserRoleEntity } from './entities/user-role.entity.js';
import { RecipientEntity } from './entities/recipient.entity.js';
import { RecipientListEntity } from './entities/recipient-list.entity.js';
import { TagEntity } from './entities/tag.entity.js';
import { RecipientListMemberEntity } from './entities/recipient-list-member.entity.js';
import { RecipientTagEntity } from './entities/recipient-tag.entity.js';
import { CustomFieldDefinitionEntity } from './entities/custom-field-definition.entity.js';
import { ImportJobEntity } from './entities/import-job.entity.js';
import { ImportJobRowEntity } from './entities/import-job-row.entity.js';
import { BulkJobEntity } from './entities/bulk-job.entity.js';
import { BulkJobRowEntity } from './entities/bulk-job-row.entity.js';
import { IdempotencyKeyEntity } from './entities/idempotency-key.entity.js';
import { EmailTemplateEntity } from './entities/email-template.entity.js';
import { EmailTemplateVersionEntity } from './entities/email-template-version.entity.js';
import { TemplateTestSendEntity } from './entities/template-test-send.entity.js';
import { CampaignEntity } from './entities/campaign.entity.js';
import { CampaignSnapshotEntity } from './entities/campaign-snapshot.entity.js';
import { CampaignRecipientEntity } from './entities/campaign-recipient.entity.js';
import { SenderConfigEntity } from './entities/sender-config.entity.js';
import { SendingPolicyEntity } from './entities/sending-policy.entity.js';
import { QuotaReservationEntity } from './entities/quota-reservation.entity.js';
import { RetentionPolicyEntity } from './entities/retention-policy.entity.js';
import { NotificationEntity } from './entities/notification.entity.js';
import { UserNotificationEntity } from './entities/user-notification.entity.js';
import { NotificationPreferenceEntity } from './entities/notification-preference.entity.js';
import { DeadLetterEventEntity } from './entities/dead-letter-event.entity.js';
import { ConfiguredVariableEntity } from './entities/configured-variable.entity.js';
import { AssetEntity } from './entities/asset.entity.js';
import { ReusableBlockEntity } from './entities/reusable-block.entity.js';

export const entities = [
  TenantEntity,
  AppUserEntity,
  OutboxEventEntity,
  UserSessionEntity,
  LoginAttemptEntity,
  PasswordResetTokenEntity,
  AuditLogEntity,
  RoleEntity,
  PermissionEntity,
  RolePermissionEntity,
  UserRoleEntity,
  RecipientEntity,
  RecipientListEntity,
  TagEntity,
  RecipientListMemberEntity,
  RecipientTagEntity,
  CustomFieldDefinitionEntity,
  ImportJobEntity,
  ImportJobRowEntity,
  BulkJobEntity,
  BulkJobRowEntity,
  IdempotencyKeyEntity,
  EmailTemplateEntity,
  EmailTemplateVersionEntity,
  TemplateTestSendEntity,
  CampaignEntity,
  SenderConfigEntity,
  SendingPolicyEntity,
  QuotaReservationEntity,
  RetentionPolicyEntity,
  NotificationEntity,
  UserNotificationEntity,
  NotificationPreferenceEntity,
  CampaignSnapshotEntity,
  CampaignRecipientEntity,
  DeadLetterEventEntity,
  ConfiguredVariableEntity,
  AssetEntity,
  ReusableBlockEntity,
];

export function buildDataSourceOptions(databaseUrl: string): DataSourceOptions {
  return {
    type: 'postgres',
    url: databaseUrl,
    entities,
    synchronize: false,
    logging: false,
  };
}

export function createDataSource(databaseUrl: string): DataSource {
  return new DataSource(buildDataSourceOptions(databaseUrl));
}
