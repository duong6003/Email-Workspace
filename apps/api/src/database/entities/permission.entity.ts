import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Global permission catalogue (BR-AUTH-004), seeded by
 * database/migrations/004_rbac.sql. Keys are the strings
 * apps/api/src/common/permissions.ts and apps/web's nav/route guards check
 * against (e.g. 'campaign:manage', 'settings:manage').
 */
@Entity({ name: 'permission' })
export class PermissionEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'text', unique: true })
  key!: string;

  @Column({ type: 'text' })
  description!: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
