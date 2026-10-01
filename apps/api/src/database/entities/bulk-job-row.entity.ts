import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type BulkJobRowStatus = 'pending' | 'processing' | 'succeeded' | 'failed' | 'skipped';

@Entity({ name: 'bulk_job_row' })
@Index(['jobId', 'status', 'recipientId'])
export class BulkJobRowEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id!: string;

  @Column({ name: 'job_id', type: 'uuid' })
  jobId!: string;

  @Column({ name: 'recipient_id', type: 'uuid' })
  recipientId!: string;

  @Column({ type: 'text', default: 'pending' })
  status!: BulkJobRowStatus;

  @Column({ type: 'text', nullable: true })
  error!: string | null;

  @Column({ name: 'claimed_at', type: 'timestamptz', nullable: true })
  claimedAt!: Date | null;

  @Column({ name: 'processed_at', type: 'timestamptz', nullable: true })
  processedAt!: Date | null;
}
