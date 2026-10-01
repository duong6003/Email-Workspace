import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ name: 'quota_reservation' })
export class QuotaReservationEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'tenant_id', type: 'uuid' }) tenantId!: string;
  @Column({ name: 'campaign_id', type: 'uuid' }) campaignId!: string;
  @Column({ name: 'snapshot_id', type: 'uuid', nullable: true }) snapshotId!: string | null;
  @Column({ name: 'period_key', type: 'text' }) periodKey!: string;
  @Column({ type: 'int' }) amount!: number;
  @Column({ type: 'int', default: 0 }) consumed!: number;
  @Column({ type: 'text', default: 'held' }) state!: 'held' | 'released';
  @CreateDateColumn({ name: 'created_at' }) createdAt!: Date;
  @Column({ name: 'released_at', type: 'timestamptz', nullable: true }) releasedAt!: Date | null;
}
