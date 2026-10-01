import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type RecipientSubscriptionStatus = 'active' | 'paused' | 'unsubscribed' | 'bounced';

/**
 * M2-S1 (BR-REC-001..010, BR-GEN-006). normalizedEmail is a DB-generated
 * STORED column (see database/migrations/006_recipient_extensions.sql) --
 * marked { insert: false, update: false } here so TypeORM never tries to
 * write it itself.
 */
@Entity({ name: 'recipient' })
@Index(['tenantId', 'deletedAt'])
export class RecipientEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string;

  @Column({ type: 'text' })
  email!: string;

  @Column({ name: 'normalized_email', type: 'text', insert: false, update: false, select: true })
  normalizedEmail!: string;

  @Column({ name: 'first_name', type: 'text', nullable: true })
  firstName!: string | null;

  @Column({ name: 'last_name', type: 'text', nullable: true })
  lastName!: string | null;

  @Column({ type: 'text', nullable: true })
  phone!: string | null;

  @Column({ type: 'text', nullable: true })
  department!: string | null;

  @Column({ type: 'text', nullable: true })
  title!: string | null;

  @Column({ type: 'text', nullable: true })
  location!: string | null;

  @Column({ name: 'subscription_status', type: 'text', default: 'active' })
  subscriptionStatus!: RecipientSubscriptionStatus;

  @Column({ name: 'custom_data', type: 'jsonb', default: {} })
  customData!: Record<string, unknown>;

  @Column({ type: 'bigint', default: 0 })
  version!: number;

  @Column({ name: 'unsubscribed_at', type: 'timestamptz', nullable: true })
  unsubscribedAt!: Date | null;

  @Column({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
