import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'recipient_list_member' })
export class RecipientListMemberEntity {
  @PrimaryColumn({ name: 'list_id', type: 'uuid' })
  listId!: string;

  @PrimaryColumn({ name: 'recipient_id', type: 'uuid' })
  recipientId!: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string;

  @Column({ name: 'joined_at', type: 'timestamptz' })
  joinedAt!: Date;

  @Column({ type: 'text' })
  source!: string;
}
