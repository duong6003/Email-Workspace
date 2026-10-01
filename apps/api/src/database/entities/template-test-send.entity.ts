import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ name: 'template_test_send' })
@Index(['tenantId', 'createdAt'])
export class TemplateTestSendEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string;

  @Column({ name: 'template_version_id', type: 'uuid' })
  templateVersionId!: string;

  @Column({ name: 'actor_id', type: 'uuid' })
  actorId!: string;

  @Column({ name: 'recipient_email', type: 'text' })
  recipientEmail!: string;

  @Column({ type: 'text' })
  status!: 'sending' | 'sent' | 'failed';

  @Column({ name: 'sent_at', type: 'timestamptz', nullable: true })
  sentAt!: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
