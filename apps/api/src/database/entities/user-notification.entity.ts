import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'user_notification' })
export class UserNotificationEntity {
  @PrimaryColumn({ name: 'notification_id', type: 'uuid' }) notificationId!: string;
  @PrimaryColumn({ name: 'user_id', type: 'uuid' }) userId!: string;
  @Column({ name: 'tenant_id', type: 'uuid' }) tenantId!: string;
  @Column({ name: 'read_at', type: 'timestamptz', nullable: true }) readAt!: Date | null;
  @Column({ name: 'archived_at', type: 'timestamptz', nullable: true }) archivedAt!: Date | null;
  @Column({ name: 'action_state', type: 'text', default: 'open' }) actionState!: 'open' | 'resolved' | 'expired';
}
