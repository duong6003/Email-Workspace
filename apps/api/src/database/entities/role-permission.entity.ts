import { Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { PermissionEntity } from './permission.entity.js';
import { RoleEntity } from './role.entity.js';

/** Grant of a permission to a role. Composite PK (role_id, permission_id). */
@Entity({ name: 'role_permission' })
export class RolePermissionEntity {
  @PrimaryColumn({ name: 'role_id', type: 'uuid' })
  roleId!: string;

  @PrimaryColumn({ name: 'permission_id', type: 'uuid' })
  permissionId!: string;

  @ManyToOne(() => RoleEntity)
  @JoinColumn({ name: 'role_id' })
  role?: RoleEntity;

  @ManyToOne(() => PermissionEntity)
  @JoinColumn({ name: 'permission_id' })
  permission?: PermissionEntity;
}
