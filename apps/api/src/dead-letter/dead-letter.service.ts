import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { IdempotencyService } from '../common/idempotency.service.js';
import { runInTenantContext } from '../database/tenant-transaction.js';
import type { DeadLetterEventEntity } from '../database/entities/dead-letter-event.entity.js';
import { DeadLetterRepository } from './dead-letter.repository.js';
import type { DeadLetterListQueryDto } from './dto/dead-letter.dto.js';

export type DeadLetterReplayActor = { actorId: string; traceId: string };

export type DeadLetterEventView = {
  id: string;
  source: 'outbox' | 'job';
  eventId: string | null;
  eventType: string;
  aggregateType: string | null;
  aggregateId: string | null;
  payload: Record<string, unknown>;
  attempts: number;
  lastError: string | null;
  deadLetteredAt: Date;
  replayedAt: Date | null;
  replayCount: number;
};

function view(event: DeadLetterEventEntity): DeadLetterEventView {
  return {
    id: event.id,
    source: event.source,
    eventId: event.eventId,
    eventType: event.eventType,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    payload: event.payload,
    attempts: event.attempts,
    lastError: event.lastError,
    deadLetteredAt: event.deadLetteredAt,
    replayedAt: event.replayedAt,
    replayCount: event.replayCount,
  };
}

@Injectable()
export class DeadLetterService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly idempotency: IdempotencyService,
  ) {}

  list(tenantId: string, query: DeadLetterListQueryDto): Promise<{ items: DeadLetterEventView[]; nextCursor: string | null }> {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const result = await new DeadLetterRepository(manager, tenantId).list(query);
      return {
        items: result.items.map(view),
        nextCursor: result.nextCursor,
      };
    });
  }

  get(tenantId: string, id: string): Promise<DeadLetterEventView> {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const event = await new DeadLetterRepository(manager, tenantId).get(id);
      if (!event) throw new NotFoundException('Dead-letter event was not found.');
      return view(event);
    });
  }

  replay(tenantId: string, id: string, idempotencyKey: string, actor: DeadLetterReplayActor): Promise<{ id: string; enqueued: boolean; replayCount: number }> {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const repository = new DeadLetterRepository(manager, tenantId);
      if (!await repository.get(id)) throw new NotFoundException('Dead-letter event was not found.');

      const result = await this.idempotency.run(
        manager,
        tenantId,
        idempotencyKey,
        'dead_letter_replay',
        { deadLetterEventId: id },
        async () => {
          const replayed = await repository.markReplayed(id);
          if (!replayed.event) throw new NotFoundException('Dead-letter event was not found.');
          return { id, enqueued: replayed.enqueued, replayCount: replayed.event.replayCount };
        },
      );
      return result.value;
    });
  }
}
