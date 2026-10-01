import { Brackets, type EntityManager } from 'typeorm';
import { NotificationEntity } from '../database/entities/notification.entity.js';
import { UserNotificationEntity } from '../database/entities/user-notification.entity.js';
import { TenantScopedRepository } from '../database/tenant-scoped.repository.js';

export class NotificationsRepository extends TenantScopedRepository<NotificationEntity> {
  constructor(private readonly manager: EntityManager, tenantId: string) { super(manager.getRepository(NotificationEntity), tenantId); }
  listForUser(userId: string, unread: boolean, limit: number, cursor?: string): Promise<Array<NotificationEntity & { readAt: Date | null; actionState: string }>> {
    const query = this.manager.createQueryBuilder(NotificationEntity, 'n')
      .innerJoin(UserNotificationEntity, 'un', 'un.notification_id = n.id AND un.tenant_id = n.tenant_id')
      .where('n.tenant_id = :tenantId AND un.user_id = :userId', { tenantId: this.tenantId, userId })
      .andWhere(new Brackets((expiry) => expiry.where('n.expires_at IS NULL').orWhere('n.expires_at > now()')))
      .orderBy('n.created_at', 'DESC').addOrderBy('n.id', 'DESC').limit(limit)
      .select(['n.id AS id', 'n.type AS type', 'n.severity AS severity', 'n.title AS title', 'n.body AS body', 'n.entity_type AS entityType', 'n.entity_id AS entityId', 'n.message_key AS messageKey', 'n.params_json AS paramsJson', 'n.deep_link_route AS deepLinkRoute', 'n.created_at AS createdAt', 'un.read_at AS readAt', 'un.action_state AS actionState']);
    if (unread) query.andWhere('un.read_at IS NULL');
    if (cursor) {
      const decoded = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
      if (decoded.length !== 2 || !decoded[0] || !decoded[1]) throw new Error('Invalid notification cursor.');
      query.andWhere('(n.created_at, n.id) < (CAST(:cursorCreatedAt AS timestamptz), CAST(:cursorId AS uuid))', { cursorCreatedAt: decoded[0], cursorId: decoded[1] });
    }
    return query.getRawMany();
  }
  async unreadCount(userId: string): Promise<{ count: string }> {
    return (await this.manager.createQueryBuilder(UserNotificationEntity, 'un').select('COUNT(*)', 'count').where('un.tenant_id = :tenantId AND un.user_id = :userId AND un.read_at IS NULL', { tenantId: this.tenantId, userId }).getRawOne()) ?? { count: '0' };
  }
  async updateForUser(userId: string, notificationId: string, values: Partial<UserNotificationEntity>): Promise<boolean> {
    const result = await this.manager.createQueryBuilder().update(UserNotificationEntity).set(values).where('tenant_id = :tenantId AND user_id = :userId AND notification_id = :notificationId', { tenantId: this.tenantId, userId, notificationId }).execute();
    return Boolean(result.affected);
  }
}
