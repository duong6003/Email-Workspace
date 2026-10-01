import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ name: 'notification' })
@Index(['tenantId', 'createdAt'])
export class NotificationEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'tenant_id', type: 'uuid' }) tenantId!: string;
  @Column({ type: 'text' }) type!: string;
  @Column({ type: 'text' }) severity!: 'info' | 'success' | 'warning' | 'critical';
  @Column({ type: 'text' }) title!: string;
  @Column({ type: 'text' }) body!: string;
  @Column({ name: 'entity_type', type: 'text', nullable: true }) entityType!: string | null;
  @Column({ name: 'entity_id', type: 'uuid', nullable: true }) entityId!: string | null;
  @Column({ name: 'source_event_id', type: 'text', nullable: true }) sourceEventId!: string | null;
  @Column({ name: 'message_key', type: 'text', default: 'notification.generic' }) messageKey!: string;
  @Column({ name: 'params_json', type: 'jsonb', default: {} }) paramsJson!: Record<string, unknown>;
  @Column({ name: 'deep_link_route', type: 'text', nullable: true }) deepLinkRoute!: string | null;
  @Column({ name: 'group_key', type: 'text', nullable: true }) groupKey!: string | null;
  @Column({ name: 'batch_window_seconds', type: 'integer', default: 300 }) batchWindowSeconds!: number;
  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true }) expiresAt!: Date | null;
  @CreateDateColumn({ name: 'created_at' }) createdAt!: Date;
}
