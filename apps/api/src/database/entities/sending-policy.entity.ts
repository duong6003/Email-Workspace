import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
@Entity({ name: 'sending_policy' })
export class SendingPolicyEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'tenant_id', type: 'uuid' }) tenantId!: string;
  @Column({ name: 'default_sender_config_id', type: 'uuid', nullable: true }) defaultSenderConfigId!: string | null;
  @Column({ name: 'reply_to', type: 'text', nullable: true }) replyTo!: string | null;
  @Column({ name: 'batch_size', type: 'int', default: 100 }) batchSize!: number;
  @Column({ name: 'max_attempts', type: 'int', default: 5 }) maxAttempts!: number;
  @Column({ name: 'tenant_rate_limit_per_minute', type: 'int', default: 600 }) tenantRateLimitPerMinute!: number;
  @Column({ name: 'send_quota_limit', type: 'int', nullable: true }) sendQuotaLimit!: number | null;
  @Column({ name: 'send_quota_period', type: 'text', default: 'month' }) sendQuotaPeriod!: 'day' | 'month';
  /** ADR-036: tenant default IANA zone for rendering typed variables. NULL keeps the pre-ADR-036 behaviour (UTC). */
  @Column({ name: 'default_timezone', type: 'text', nullable: true }) defaultTimezone!: string | null;
  @Column({ name: 'updated_by', type: 'uuid', nullable: true }) updatedBy!: string | null;
  @CreateDateColumn({ name: 'created_at' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt!: Date;
}
