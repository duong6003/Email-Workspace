import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type CustomFieldType = 'text' | 'number' | 'date' | 'boolean' | 'enum';

/**
 * M2-S3 (BR-CF-001/002/003/009). Maps to the `custom_field_definition`
 * table created by 001_initial.sql and extended by
 * database/migrations/007_custom_fields.sql. Column names (field_key,
 * data_type) match the pre-existing published schema rather than the
 * `key`/`type` names this slice's own planning docs assumed before that
 * schema was discovered -- see 007's migration comment / EXECPLAN DEC-033.
 */
@Entity({ name: 'custom_field_definition' })
export class CustomFieldDefinitionEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string;

  @Column({ name: 'field_key', type: 'text' })
  fieldKey!: string;

  @Column({ type: 'text' })
  label!: string;

  @Column({ name: 'data_type', type: 'text' })
  dataType!: CustomFieldType;

  @Column({ type: 'boolean', default: false })
  required!: boolean;

  @Column({ name: 'default_value', type: 'jsonb', nullable: true })
  defaultValue!: unknown;

  @Column({ name: 'enum_options', type: 'jsonb', nullable: true })
  enumOptions!: string[] | null;

  /** BR-CF-009: when true, this field's recipient-level value is masked ("***") in audit_log rows. */
  @Column({ type: 'boolean', default: false })
  sensitive!: boolean;

  /** ADR-036: presentation pattern (dates only today, e.g. dd/MM/yyyy). NULL means the product default. */
  @Column({ type: 'text', nullable: true })
  format!: string | null;

  /** ADR-036: IANA zone; NULL falls back to sending_policy.default_timezone, then UTC. */
  @Column({ type: 'text', nullable: true })
  timezone!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
