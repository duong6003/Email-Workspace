import type { EntityManager } from 'typeorm';
import { DeadLetterEventEntity } from '../database/entities/dead-letter-event.entity.js';
import { TenantScopedRepository } from '../database/tenant-scoped.repository.js';
import type { DeadLetterListQueryDto } from './dto/dead-letter.dto.js';

export class DeadLetterRepository extends TenantScopedRepository<DeadLetterEventEntity> {
  constructor(
    private readonly manager: EntityManager,
    tenantId: string,
  ) {
    super(manager.getRepository(DeadLetterEventEntity), tenantId);
  }

  async list(query: DeadLetterListQueryDto): Promise<{ items: DeadLetterEventEntity[]; nextCursor: string | null }> {
    const builder = this.repository.createQueryBuilder('event')
      .where('event.tenant_id = :tenantId', { tenantId: this.tenantId })
      .orderBy('event.dead_lettered_at', 'DESC')
      .addOrderBy('event.id', 'DESC')
      .take(query.limit + 1);

    if (query.cursor) {
      const cursor = await this.findOne({ id: query.cursor });
      if (cursor) {
        builder.andWhere(
          '(event.dead_lettered_at < :cursorTime OR (event.dead_lettered_at = :cursorTime AND event.id < :cursorId))',
          { cursorTime: cursor.deadLetteredAt, cursorId: cursor.id },
        );
      }
    }

    const rows = await builder.getMany();
    const hasMore = rows.length > query.limit;
    const items = hasMore ? rows.slice(0, query.limit) : rows;
    return { items, nextCursor: hasMore ? items.at(-1)?.id ?? null : null };
  }

  get(id: string): Promise<DeadLetterEventEntity | null> {
    return this.findOne({ id });
  }

  async markReplayed(id: string): Promise<{ event: DeadLetterEventEntity | null; enqueued: boolean }> {
    const event = await this.get(id);
    if (!event) return { event: null, enqueued: false };

    let enqueued = false;
    if (event.source === 'outbox' && event.eventId) {
      const rows = await this.manager.query(
        `UPDATE outbox_event
         SET attempts = 0, last_error = NULL, dead_lettered_at = NULL
         WHERE tenant_id = $1 AND id = $2 AND dead_lettered_at IS NOT NULL
         RETURNING id`,
        [this.tenantId, event.eventId],
      ) as Array<{ id: string }>;
      enqueued = rows.length === 1;
    }

    const updateResult = await this.manager.query(
      `UPDATE dead_letter_event
       SET replay_count = replay_count + 1, replayed_at = now()
       WHERE tenant_id = $1 AND id = $2
       RETURNING id`,
      [this.tenantId, id],
    ) as [Array<{ id: string }>, number];
    const rows = Array.isArray(updateResult[0]) ? updateResult[0] : updateResult as unknown as Array<{ id: string }>;
    if (rows.length === 0) return { event: null, enqueued: false };
    return { event: await this.get(rows[0].id), enqueued };
  }
}
