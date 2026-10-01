import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'recipient_tag' })
export class RecipientTagEntity {
  @PrimaryColumn({ name: 'tag_id', type: 'uuid' })
  tagId!: string;

  @PrimaryColumn({ name: 'recipient_id', type: 'uuid' })
  recipientId!: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string;

  @Column({ name: 'joined_at', type: 'timestamptz' })
  joinedAt!: Date;

  @Column({ type: 'text' })
  source!: string;
}
