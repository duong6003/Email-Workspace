import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
export type SenderConfigStatus = 'pending' | 'verified' | 'failed' | 'disabled';
@Entity({ name: 'sender_config' })
@Index(['tenantId', 'status', 'updatedAt'])
export class SenderConfigEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'tenant_id', type: 'uuid' }) tenantId!: string;
  @Column() name!: string;
  @Column({ name: 'from_name', default: '' }) fromName!: string;
  @Column({ name: 'from_email' }) fromEmail!: string;
  @Column({ name: 'reply_to', type: 'text', nullable: true }) replyTo!: string | null;
  @Column({ type: 'text', default: 'smtp' }) provider!: 'smtp';
  @Column() host!: string;
  @Column({ type: 'integer', default: 1025 }) port!: number;
  @Column({ default: '' }) username!: string;
  @Column({ name: 'secret_ref' }) secretRef!: string;
  @Column({ type: 'text', default: 'pending' }) status!: SenderConfigStatus;
  @Column({ name: 'verified_at', type: 'timestamptz', nullable: true }) verifiedAt!: Date | null;
  @Column({ name: 'last_tested_at', type: 'timestamptz', nullable: true }) lastTestedAt!: Date | null;
  @Column({ name: 'created_by', type: 'uuid', nullable: true }) createdBy!: string | null;
  @Column({ name: 'updated_by', type: 'uuid', nullable: true }) updatedBy!: string | null;
  @CreateDateColumn({ name: 'created_at' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt!: Date;
  @Column({ name: 'deleted_at', type: 'timestamptz', nullable: true }) deletedAt!: Date | null;
}
