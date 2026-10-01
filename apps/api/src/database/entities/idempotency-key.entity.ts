import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * Maps to the pre-existing idempotency_key table (database/migrations/
 * 002_identity_and_audit.sql). M2-S4 is the first node with a real
 * qualifying endpoint (BR-GEN-005: send/import/bulk-update job creation),
 * so this is the first TypeORM entity for it.
 */
@Entity({ name: 'idempotency_key' })
export class IdempotencyKeyEntity {
  @PrimaryColumn({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string;

  @PrimaryColumn({ type: 'text' })
  key!: string;

  @Column({ name: 'request_hash', type: 'text' })
  requestHash!: string;

  @Column({ name: 'resource_type', type: 'text' })
  resourceType!: string;

  @Column({ name: 'resource_id', type: 'uuid', nullable: true })
  resourceId!: string | null;

  @Column({ name: 'response_json', type: 'jsonb', nullable: true })
  responseJson!: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;
}
