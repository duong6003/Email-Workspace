import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type ImportJobStatus = 'queued' | 'running' | 'completed' | 'partial_success' | 'failed';
export type ImportJobMode = 'create_only' | 'update_existing' | 'upsert';

/** M2-S4 (BR-IMP-001..007). See database/migrations/008_import_bulk_jobs.sql for the checkpointing design. */
@Entity({ name: 'import_job' })
@Index(['tenantId', 'createdAt'])
export class ImportJobEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string;

  @Column({ type: 'text', default: 'queued' })
  status!: ImportJobStatus;

  @Column({ type: 'text', default: 'upsert' })
  mode!: ImportJobMode;

  @Column({ name: 'file_name', type: 'text' })
  fileName!: string;

  /** Approved source-column -> destination-field mapping, persisted so the worker can resume after restart. */
  @Column({ name: 'mapping_json', type: 'jsonb', default: {} })
  mapping!: Record<string, string>;

  /** Object-storage adapter references; no raw file bytes are stored in PostgreSQL. */
  @Column({ name: 'source_file_ref', type: 'text', nullable: true })
  sourceFileRef!: string | null;

  @Column({ name: 'result_file_ref', type: 'text', nullable: true })
  resultFileRef!: string | null;

  @Column({ name: 'total_rows', type: 'integer', default: 0 })
  totalRows!: number;

  @Column({ name: 'processed_rows', type: 'integer', default: 0 })
  processedRows!: number;

  @Column({ name: 'succeeded_rows', type: 'integer', default: 0 })
  succeededRows!: number;

  @Column({ name: 'failed_rows', type: 'integer', default: 0 })
  failedRows!: number;

  @Column({ name: 'skipped_rows', type: 'integer', default: 0 })
  skippedRows!: number;

  @Column({ name: 'error_summary', type: 'jsonb', nullable: true })
  errorSummary!: Record<string, unknown> | null;

  @Column({ name: 'idempotency_key', type: 'text', nullable: true })
  idempotencyKey!: string | null;

  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @Column({ name: 'started_at', type: 'timestamptz', nullable: true })
  startedAt!: Date | null;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt!: Date | null;

  @Column({ name: 'last_progress_emitted_at', type: 'timestamptz', nullable: true })
  lastProgressEmittedAt!: Date | null;
}
