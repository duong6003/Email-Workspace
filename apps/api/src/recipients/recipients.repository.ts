import type { EntityManager } from 'typeorm';
import { TenantScopedRepository } from '../database/tenant-scoped.repository.js';
import { RecipientEntity } from '../database/entities/recipient.entity.js';

export type RecipientListFilter = {
  search?: string;
  status?: string[];
  listIds?: string[];
  tagIds?: string[];
  cursor?: string;
  limit: number;
};

export type RecipientListResult = {
  items: RecipientEntity[];
  nextCursor: string | null;
  total: number;
};

type Cursor = { createdAt: string; id: string };

function encodeCursor(row: RecipientEntity): string {
  return Buffer.from(JSON.stringify({ createdAt: row.createdAt.toISOString(), id: row.id } satisfies Cursor)).toString('base64url');
}

function decodeCursor(cursor: string): Cursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Cursor;
    if (typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Extends TenantScopedRepository (BR-GEN-002 enforcement point) with the
 * recipient-specific queries M2-S1 needs: case-insensitive duplicate lookup
 * (BR-REC-001), search/filter/keyset pagination (BR-REC-007/008), and soft
 * delete (BR-GEN-006).
 *
 * Deliberately a plain class, NOT a NestJS DI provider: RecipientsService
 * constructs `new RecipientsRepository(manager, tenantId)` per call,
 * with tenantId read directly from the controller's already-guarded
 * request.auth.tenantId. Constructor-injecting the former REQUEST-scoped
 * TenantContext into another REQUEST-scoped provider caused a real,
 * reproduced false 401 (AuthGuard had not populated request.auth yet when
 * that provider's constructor ran).
 * This explicit-parameter pattern sidesteps that DI-ordering hazard
 * entirely and matches how
 * apps/api/test/integration/tenant-scoped-repository.test.ts already
 * exercises the base class.
 */
export class RecipientsRepository extends TenantScopedRepository<RecipientEntity> {
  constructor(manager: EntityManager, tenantId: string) {
    super(manager.getRepository(RecipientEntity), tenantId);
  }

  /** BR-REC-001: case-insensitive duplicate check among *active* (non-soft-deleted) recipients. */
  async findActiveByNormalizedEmail(normalizedEmail: string): Promise<RecipientEntity | null> {
    return this.repository
      .createQueryBuilder('recipient')
      .where('recipient.tenant_id = :tenantId', { tenantId: this.tenantId })
      .andWhere('recipient.normalized_email = :normalizedEmail', { normalizedEmail: normalizedEmail.toLowerCase().trim() })
      .andWhere('recipient.deleted_at IS NULL')
      .getOne();
  }

  async findActiveById(id: string): Promise<RecipientEntity | null> {
    return this.repository
      .createQueryBuilder('recipient')
      .where('recipient.tenant_id = :tenantId', { tenantId: this.tenantId })
      .andWhere('recipient.id = :id', { id })
      .andWhere('recipient.deleted_at IS NULL')
      .getOne();
  }

  /** M4-S3: batch-loads full recipient rows for an already-resolved actionable id set (variable validation). */
  async findByIds(ids: readonly string[]): Promise<RecipientEntity[]> {
    if (ids.length === 0) return [];
    return this.repository
      .createQueryBuilder('recipient')
      .where('recipient.tenant_id = :tenantId', { tenantId: this.tenantId })
      .andWhere('recipient.id IN (:...ids)', { ids })
      .getMany();
  }

  async list(filter: RecipientListFilter): Promise<RecipientListResult> {
    const base = this.repository
      .createQueryBuilder('recipient')
      .where('recipient.tenant_id = :tenantId', { tenantId: this.tenantId })
      .andWhere('recipient.deleted_at IS NULL');

    if (filter.search) {
      base.andWhere(
        '(recipient.normalized_email ILIKE :search OR recipient.first_name ILIKE :search OR recipient.last_name ILIKE :search OR recipient.department ILIKE :search)',
        { search: `%${filter.search.toLowerCase()}%` },
      );
    }
    if (filter.status && filter.status.length > 0) {
      base.andWhere('recipient.subscription_status IN (:...status)', { status: filter.status });
    }
    // BR-SEG-007: selected list/tag controls use the same tenant master data
    // as the recipient form and table. Values within one category match any;
    // combining list and tag categories narrows the result set.
    if (filter.listIds && filter.listIds.length > 0) {
      base.andWhere(
        `EXISTS (
          SELECT 1 FROM recipient_list_member list_member
          JOIN recipient_list list ON list.id = list_member.list_id
            AND list.tenant_id = list_member.tenant_id AND list.deleted_at IS NULL
          WHERE list_member.tenant_id = :tenantId
            AND list_member.recipient_id = recipient.id
            AND list_member.list_id IN (:...listIds)
        )`,
        { listIds: filter.listIds },
      );
    }
    if (filter.tagIds && filter.tagIds.length > 0) {
      base.andWhere(
        `EXISTS (
          SELECT 1 FROM recipient_tag tag_member
          JOIN tag ON tag.id = tag_member.tag_id
            AND tag.tenant_id = tag_member.tenant_id AND tag.deleted_at IS NULL
          WHERE tag_member.tenant_id = :tenantId
            AND tag_member.recipient_id = recipient.id
            AND tag_member.tag_id IN (:...tagIds)
        )`,
        { tagIds: filter.tagIds },
      );
    }

    const total = await base.getCount();

    const query = base.clone().orderBy('recipient.created_at', 'DESC').addOrderBy('recipient.id', 'DESC').take(filter.limit + 1);

    if (filter.cursor) {
      const decoded = decodeCursor(filter.cursor);
      if (decoded) {
        query.andWhere('(recipient.created_at, recipient.id) < (:cursorCreatedAt, :cursorId)', {
          cursorCreatedAt: decoded.createdAt,
          cursorId: decoded.id,
        });
      }
    }

    const rows = await query.getMany();
    const hasMore = rows.length > filter.limit;
    const items = hasMore ? rows.slice(0, filter.limit) : rows;

    return {
      items,
      nextCursor: hasMore ? encodeCursor(items[items.length - 1]) : null,
      total,
    };
  }

  /** BR-GEN-006: never a hard DELETE. Row (and any campaign_recipient snapshot referencing it) stays queryable for history/audit. */
  async softDelete(id: string): Promise<void> {
    await this.repository
      .createQueryBuilder()
      .update(RecipientEntity)
      .set({ deletedAt: () => 'now()' })
      .where('tenant_id = :tenantId', { tenantId: this.tenantId })
      .andWhere('id = :id', { id })
      .andWhere('deleted_at IS NULL')
      .execute();
  }
}
