import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ name: 'dead_letter_event' })
@Index(['tenantId', 'deadLetteredAt', 'id'])
export class DeadLetterEventEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'tenant_id', type: 'uuid' }) tenantId!: string;
  @Column({ type: 'text' }) source!: 'outbox' | 'job';
  @Column({ name: 'event_id', type: 'uuid', nullable: true }) eventId!: string | null;
  @Column({ name: 'event_type', type: 'text' }) eventType!: string;
  @Column({ name: 'aggregate_type', type: 'text', nullable: true }) aggregateType!: string | null;
  @Column({ name: 'aggregate_id', type: 'uuid', nullable: true }) aggregateId!: string | null;
  @Column({ type: 'jsonb' }) payload!: Record<string, unknown>;
  @Column({ type: 'integer' }) attempts!: number;
  @Column({ name: 'last_error', type: 'text', nullable: true }) lastError!: string | null;
  @Column({ name: 'dead_lettered_at', type: 'timestamptz' }) deadLetteredAt!: Date;
  @Column({ name: 'replayed_at', type: 'timestamptz', nullable: true }) replayedAt!: Date | null;
  @Column({ name: 'replay_count', type: 'integer', default: 0 }) replayCount!: number;
}
