import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * MC-UI-004 reusable block (migration 075). Owned by the TENANT, not by whoever
 * saved it (plan §S5 Task 26): `tenantId` is the scope and `createdBy` is
 * attribution only -- nothing authorizes off it.
 *
 * `node` is a `Node` subtree from the builder's own document model, and the API
 * never parses it, the same contract `email_template.project_data` carries
 * (ADR-019). Storing HTML instead would open a second path onto the canvas that
 * the component tree knows nothing about (ADR-037 §3).
 */
@Entity({ name: 'reusable_block' })
@Index(['tenantId', 'name'])
export class ReusableBlockEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'tenant_id', type: 'uuid' }) tenantId!: string;
  @Column({ type: 'text' }) name!: string;
  @Column({ type: 'jsonb' }) node!: unknown;
  /** Who saved it. Nullable and unconstrained, following 072's `published_by`: under tenant ownership, removing that person changes nothing about the block. */
  @Column({ name: 'created_by', type: 'uuid', nullable: true }) createdBy!: string | null;
  @CreateDateColumn({ name: 'created_at' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt!: Date;
}
