import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Backs BR-AUTH-002 (rotating session/refresh token). The session's opaque
 * secret is never stored directly — only its SHA-256 hash, in
 * refresh_token_hash — mirroring how a real refresh-token table has to work.
 */
@Entity({ name: 'user_session' })
export class UserSessionEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ name: 'refresh_token_hash', type: 'text', unique: true })
  refreshTokenHash!: string;

  @CreateDateColumn({ name: 'issued_at' })
  issuedAt!: Date;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ name: 'rotated_from', type: 'uuid', nullable: true })
  rotatedFrom!: string | null;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;

  @Column({ name: 'user_agent_hash', type: 'text', nullable: true })
  userAgentHash!: string | null;

  @Column({ name: 'ip_hash', type: 'text', nullable: true })
  ipHash!: string | null;
}
