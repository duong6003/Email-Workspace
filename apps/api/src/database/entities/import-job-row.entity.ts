import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type ImportJobRowStatus = 'pending' | 'processing' | 'succeeded' | 'failed' | 'skipped';
export type ImportJobRowOutcome = 'created' | 'updated' | 'skipped';

/**
 * One row per parsed XLSX data row. Status is the checkpoint the worker's
 * claim/reclaim loop reads and writes -- see
 * database/migrations/008_import_bulk_jobs.sql's header comment.
 */
@Entity({ name: 'import_job_row' })
@Index(['jobId', 'status', 'rowNumber'])
export class ImportJobRowEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id!: string;

  @Column({ name: 'job_id', type: 'uuid' })
  jobId!: string;

  @Column({ name: 'row_number', type: 'integer' })
  rowNumber!: number;

  @Column({ name: 'raw_data', type: 'jsonb' })
  rawData!: Record<string, unknown>;

  @Column({ type: 'text', default: 'pending' })
  status!: ImportJobRowStatus;

  @Column({ type: 'text', nullable: true })
  error!: string | null;

  @Column({ name: 'recipient_id', type: 'uuid', nullable: true })
  recipientId!: string | null;

  @Column({ type: 'text', nullable: true })
  outcome!: ImportJobRowOutcome | null;

  @Column({ name: 'claimed_at', type: 'timestamptz', nullable: true })
  claimedAt!: Date | null;

  @Column({ name: 'processed_at', type: 'timestamptz', nullable: true })
  processedAt!: Date | null;
}
