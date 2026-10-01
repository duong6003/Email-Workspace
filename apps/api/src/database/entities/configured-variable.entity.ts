import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

import type { CustomFieldType } from './custom-field-definition.entity.js';

export type ConfiguredVariableScope = 'global' | 'template';

@Entity({ name: 'configured_variable' })
@Index(['tenantId', 'templateId', 'createdAt'])
export class ConfiguredVariableEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'tenant_id', type: 'uuid' }) tenantId!: string;
  @Column({ type: 'text' }) scope!: ConfiguredVariableScope;
  @Column({ name: 'template_id', type: 'uuid', nullable: true }) templateId!: string | null;
  @Column({ name: 'variable_key', type: 'text' }) variableKey!: string;
  @Column({ type: 'text' }) label!: string;
  /** ADR-036: configured variables were untyped free text, so nothing recorded that one was a date. */
  @Column({ name: 'data_type', type: 'text', default: 'text' }) dataType!: CustomFieldType;
  @Column({ name: 'enum_options', type: 'jsonb', nullable: true }) enumOptions!: string[] | null;
  @Column({ type: 'text', nullable: true }) format!: string | null;
  @Column({ type: 'text', nullable: true }) timezone!: string | null;
  @Column({ name: 'default_value', type: 'jsonb', nullable: true }) defaultValue!: unknown;
  @Column({ type: 'boolean', default: false }) required!: boolean;
  @Column({ name: 'allow_campaign_override', type: 'boolean', default: false }) allowCampaignOverride!: boolean;
  @CreateDateColumn({ name: 'created_at' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt!: Date;
}
