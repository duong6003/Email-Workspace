import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type EmailTemplateStatus = 'draft' | 'published' | 'archived';

export type EmailTemplateOrigin = 'imported' | 'builder';

@Entity({ name: 'email_template' })
@Index(['tenantId', 'deletedAt'])
export class EmailTemplateEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text', default: 'draft' })
  status!: EmailTemplateStatus;

  @Column({ name: 'draft_subject', type: 'text', default: '' })
  draftSubject!: string;

  @Column({ name: 'draft_html', type: 'text', default: '' })
  draftHtml!: string;

  @Column({ name: 'draft_text_body', type: 'text', default: '' })
  draftTextBody!: string;

  @Column({ name: 'draft_validation_json', type: 'jsonb', default: { warnings: [], errors: [], changes: [] } })
  draftValidationJson!: Record<string, unknown>;

  /** Who owns the content model. 'builder' rows also carry projectData. */
  @Column({ type: 'text', default: 'imported' })
  origin!: EmailTemplateOrigin;

  /**
   * Opaque component tree for builder-origin templates. The API never reads
   * it — draftHtml stays the only content used to render and send (ADR-019).
   */
  @Column({ name: 'project_data', type: 'jsonb', nullable: true })
  projectData!: Record<string, unknown> | null;

  /** Optimistic concurrency for the draft. Not the published version number. */
  @Column({ name: 'draft_revision', type: 'int', default: 1 })
  draftRevision!: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @Column({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;
}
