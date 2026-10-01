import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity({ name: 'notification_preference' })
export class NotificationPreferenceEntity {
  @PrimaryColumn({ name: 'tenant_id', type: 'uuid' }) tenantId!: string;
  @PrimaryColumn({ name: 'user_id', type: 'uuid' }) userId!: string;
  @PrimaryColumn({ type: 'text' }) category!: string;
  @Column({ type: 'boolean', default: true }) enabled!: boolean;
  @Column({ type: 'boolean', default: true }) muteable!: boolean;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt!: Date;
}
