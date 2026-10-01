import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type TemplateVariableSchema = {
  required: string[];
  optional: string[];
  defaults?: Record<string, unknown>;
  configured?: Record<string, {
    label: string;
    scope: 'global' | 'template';
    allowCampaignOverride: boolean;
  }>;
};

@Entity({ name: 'email_template_version' })
@Index(['tenantId', 'templateId', 'version'], { unique: true })
export class EmailTemplateVersionEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string;

  @Column({ name: 'template_id', type: 'uuid' })
  templateId!: string;

  @Column({ type: 'integer' })
  version!: number;

  @Column({ type: 'text' })
  subject!: string;

  @Column({ type: 'text' })
  html!: string;

  @Column({ name: 'text_body', type: 'text' })
  textBody!: string;

  @Column({ name: 'required_variables', type: 'text', array: true, default: () => "'{}'" })
  requiredVariables!: string[];

  @Column({ name: 'variable_schema_json', type: 'jsonb' })
  variableSchemaJson!: TemplateVariableSchema;

  @Column({ name: 'content_hash', type: 'text' })
  contentHash!: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @Column({ name: 'published_at', type: 'timestamptz' })
  publishedAt!: Date;

  /** Null for versions published before the column existed — the actor is not
   *  recoverable for those, and audit_log is pruned by retention. */
  @Column({ name: 'published_by', type: 'uuid', nullable: true })
  publishedBy!: string | null;
}
