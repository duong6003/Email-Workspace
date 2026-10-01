import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Backs BR-AUTH-005 (lockout/throttling). tenant_id is nullable (003) so an
 * attempt against an email that resolves to no tenant can still be recorded
 * for email-keyed lockout counting without fabricating a tenant.
 */
@Entity({ name: 'login_attempt' })
export class LoginAttemptEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'tenant_id', type: 'uuid', nullable: true })
  tenantId!: string | null;

  @Column({ type: 'text' })
  email!: string;

  @CreateDateColumn({ name: 'occurred_at' })
  occurredAt!: Date;

  @Column({ type: 'text' })
  outcome!: 'success' | 'failure';

  @Column({ name: 'ip_hash', type: 'text', nullable: true })
  ipHash!: string | null;
}
