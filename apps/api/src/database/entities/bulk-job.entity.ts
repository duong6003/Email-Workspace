import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type BulkJobStatus = 'queued' | 'running' | 'completed' | 'partial_success' | 'failed';
export type BulkJobAction = 'add_tag' | 'remove_tag' | 'add_list' | 'remove_list' | 'set_custom_data' | 'export' | 'delete';

/**
 * M2-S4 (BR-REC-009, BR-CF-004..008). selectionSnapshot is the frozen id
 * list resolved at confirmation time -- BR-CF-005's "processed không vượt
 * resolved_count" guarantee. See database/migrations/008_import_bulk_jobs.sql.
 */
@Entity({ name: 'bulk_job' })
@Index(['tenantId', 'createdAt'])
export class BulkJobEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string;

  @Column({ type: 'text', default: 'queued' })
  status!: BulkJobStatus;

  @Column({ type: 'text' })
  action!: BulkJobAction;

  @Column({ name: 'action_payload', type: 'jsonb' })
  actionPayload!: Record<string, unknown>;

  @Column({ name: 'selection_snapshot', type: 'jsonb' })
  selectionSnapshot!: string[];

  @Column({ name: 'resolved_count', type: 'integer' })
  resolvedCount!: number;

  @Column({ name: 'processed_rows', type: 'integer', default: 0 })
  processedRows!: number;

  @Column({ name: 'succeeded_rows', type: 'integer', default: 0 })
  succeededRows!: number;

  @Column({ name: 'failed_rows', type: 'integer', default: 0 })
  failedRows!: number;

  @Column({ name: 'skipped_rows', type: 'integer', default: 0 })
  skippedRows!: number;

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
