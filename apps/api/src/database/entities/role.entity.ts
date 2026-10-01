import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Global role catalogue (BR-AUTH-003): admin, operator, viewer, seeded by
 * database/migrations/004_rbac.sql. Not tenant-owned — the set of roles the
 * system supports is fixed, only the assignment of a role to a user
 * (user_role) is tenant-scoped.
 */
@Entity({ name: 'role' })
export class RoleEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'text', unique: true })
  key!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text' })
  description!: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
