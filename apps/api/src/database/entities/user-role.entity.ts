import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { RoleEntity } from './role.entity.js';
import { TenantEntity } from './tenant.entity.js';
import { AppUserEntity } from './app-user.entity.js';

/**
 * Tenant-owned assignment of a role to a user. Backfilled from the legacy
 * free-text app_user.role column by database/migrations/004_rbac.sql; a
 * user may hold more than one role, though the data migration assigns
 * exactly one (its prior app_user.role value, or 'viewer' if unrecognised).
 */
@Entity({ name: 'user_role' })
export class UserRoleEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string;

  @ManyToOne(() => TenantEntity)
  @JoinColumn({ name: 'tenant_id' })
  tenant?: TenantEntity;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @ManyToOne(() => AppUserEntity)
  @JoinColumn({ name: 'user_id' })
  user?: AppUserEntity;

  @Column({ name: 'role_id', type: 'uuid' })
  roleId!: string;

  @ManyToOne(() => RoleEntity)
  @JoinColumn({ name: 'role_id' })
  role?: RoleEntity;

  @CreateDateColumn({ name: 'assigned_at' })
  assignedAt!: Date;
}
