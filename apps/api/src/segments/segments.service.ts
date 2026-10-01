import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import { RecipientListEntity } from '../database/entities/recipient-list.entity.js';
import { TagEntity } from '../database/entities/tag.entity.js';
import { appendAuditLog } from '../common/audit-writer.js';
import type { CreateRecipientListDto, CreateTagDto, SegmentListQueryDto, UpdateRecipientListDto, UpdateTagDto } from './dto/segment.dto.js';
import { RecipientListsRepository, TagsRepository } from './segments.repository.js';
import { runInTenantContext } from '../database/tenant-transaction.js';

type Cursor = { name: string; id: string };
type SegmentRow = { id: string; tenant_id: string; name: string; description?: string | null; color?: string; created_at: Date; updated_at: Date; member_count: string | number };

export type RecipientListResponse = { id: string; name: string; description: string | null; memberCount: number; createdAt: Date; updatedAt: Date };
export type TagResponse = { id: string; name: string; color: string; memberCount: number; createdAt: Date; updatedAt: Date };
export type RecipientSegmentsResponse = { lists: RecipientListResponse[]; tags: TagResponse[] };
export type SegmentActor = { actorId: string | null; traceId: string };

function encodeCursor(row: { name: string; id: string }): string {
  return Buffer.from(JSON.stringify({ name: row.name, id: row.id } satisfies Cursor)).toString('base64url');
}

function decodeCursor(value: string): Cursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Cursor;
    return typeof parsed.name === 'string' && typeof parsed.id === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

function listResponse(row: SegmentRow): RecipientListResponse {
  return { id: row.id, name: row.name, description: row.description ?? null, memberCount: Number(row.member_count), createdAt: row.created_at, updatedAt: row.updated_at };
}

function tagResponse(row: SegmentRow): TagResponse {
  return { id: row.id, name: row.name, color: row.color!, memberCount: Number(row.member_count), createdAt: row.created_at, updatedAt: row.updated_at };
}

/**
 * Tenant-scoped list/tag master data. The service uses explicit tenant ids
 * (rather than a request-scoped repository) to avoid the documented
 * AuthGuard ordering hazard in the recipient module.
 */
@Injectable()
export class SegmentsService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async listLists(tenantId: string, query: SegmentListQueryDto) {
    return this.listCatalog('recipient_list', tenantId, query, false);
  }

  async listTags(tenantId: string, query: SegmentListQueryDto) {
    return this.listCatalog('tag', tenantId, query, true);
  }

  async getList(tenantId: string, id: string): Promise<RecipientListResponse> {
    const row = await this.getCatalogRow('recipient_list', tenantId, id, false);
    if (!row) throw new NotFoundException('Recipient list not found.');
    return listResponse(row);
  }

  async getTag(tenantId: string, id: string): Promise<TagResponse> {
    const row = await this.getCatalogRow('tag', tenantId, id, true);
    if (!row) throw new NotFoundException('Tag not found.');
    return tagResponse(row);
  }

  /** BR-SEG-007 / BR-REC-005/006: one master-data source for recipient form/table consumers. */
  async recipientSegments(tenantId: string, recipientId: string): Promise<RecipientSegmentsResponse> {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const recipient = await manager.query('SELECT 1 FROM recipient WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL', [recipientId, tenantId]);
      if (recipient.length === 0) throw new NotFoundException('Recipient not found.');
      const [lists, tags] = await Promise.all([
        manager.query(
        `SELECT list.id, list.tenant_id, list.name, list.description, list.created_at, list.updated_at, count(recipient.id)::int AS member_count
         FROM recipient_list list
         JOIN recipient_list_member member ON member.list_id = list.id AND member.tenant_id = list.tenant_id AND member.recipient_id = $1
         LEFT JOIN recipient recipient ON recipient.id = member.recipient_id AND recipient.tenant_id = list.tenant_id AND recipient.deleted_at IS NULL
         WHERE list.tenant_id = $2 AND list.deleted_at IS NULL
         GROUP BY list.id ORDER BY list.name ASC, list.id ASC`,
        [recipientId, tenantId],
      ),
        manager.query(
        `SELECT tag.id, tag.tenant_id, tag.name, tag.color, tag.created_at, tag.updated_at, count(recipient.id)::int AS member_count
         FROM tag
         JOIN recipient_tag member ON member.tag_id = tag.id AND member.tenant_id = tag.tenant_id AND member.recipient_id = $1
         LEFT JOIN recipient recipient ON recipient.id = member.recipient_id AND recipient.tenant_id = tag.tenant_id AND recipient.deleted_at IS NULL
         WHERE tag.tenant_id = $2 AND tag.deleted_at IS NULL
         GROUP BY tag.id ORDER BY tag.name ASC, tag.id ASC`,
        [recipientId, tenantId],
      ),
      ]);
      return { lists: (lists as SegmentRow[]).map(listResponse), tags: (tags as SegmentRow[]).map(tagResponse) };
    });
  }

  async createList(tenantId: string, body: CreateRecipientListDto): Promise<RecipientListResponse> {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const repository = new RecipientListsRepository(manager, tenantId);
      try {
        const saved = await repository.save({ name: body.name.trim(), description: body.description?.trim() || null });
      return { id: saved.id, name: saved.name, description: saved.description, memberCount: 0, createdAt: saved.createdAt, updatedAt: saved.updatedAt };
      } catch (error) {
        this.throwNameConflict(error, 'Recipient list');
      }
    });
  }

  async createTag(tenantId: string, body: CreateTagDto): Promise<TagResponse> {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const repository = new TagsRepository(manager, tenantId);
      try {
        const saved = await repository.save({ name: body.name.trim(), color: body.color });
      return { id: saved.id, name: saved.name, color: saved.color, memberCount: 0, createdAt: saved.createdAt, updatedAt: saved.updatedAt };
      } catch (error) {
        this.throwNameConflict(error, 'Tag');
      }
    });
  }

  async updateList(tenantId: string, id: string, body: UpdateRecipientListDto): Promise<RecipientListResponse> {
    await runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const repository = new RecipientListsRepository(manager, tenantId);
      const existing = await this.getListEntity(manager, tenantId, id);
      existing.name = body.name?.trim() ?? existing.name;
      if (body.description !== undefined) existing.description = body.description?.trim() || null;
      try { await repository.save(existing); } catch (error) { this.throwNameConflict(error, 'Recipient list'); }
    });
    return this.getList(tenantId, id);
  }

  async updateTag(tenantId: string, id: string, body: UpdateTagDto): Promise<TagResponse> {
    await runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const repository = new TagsRepository(manager, tenantId);
      const existing = await this.getTagEntity(manager, tenantId, id);
      existing.name = body.name?.trim() ?? existing.name;
      if (body.color !== undefined) existing.color = body.color;
      try { await repository.save(existing); } catch (error) { this.throwNameConflict(error, 'Tag'); }
    });
    return this.getTag(tenantId, id);
  }

  async addListMembers(tenantId: string, listId: string, recipientIds: string[]): Promise<void> {
    await runInTenantContext(this.dataSource, tenantId, async (manager) => {
      await this.getListEntity(manager, tenantId, listId);
      await this.addMembers(manager, 'recipient_list_member', 'list_id', tenantId, listId, recipientIds);
    });
  }

  async removeListMembers(tenantId: string, listId: string, recipientIds: string[]): Promise<void> {
    await runInTenantContext(this.dataSource, tenantId, async (manager) => {
      await this.getListEntity(manager, tenantId, listId);
      await this.removeMembers(manager, 'recipient_list_member', 'list_id', tenantId, listId, recipientIds);
    });
  }

  async addTagMembers(tenantId: string, tagId: string, recipientIds: string[]): Promise<void> {
    await runInTenantContext(this.dataSource, tenantId, async (manager) => {
      await this.getTagEntity(manager, tenantId, tagId);
      await this.addMembers(manager, 'recipient_tag', 'tag_id', tenantId, tagId, recipientIds);
    });
  }

  async removeTagMembers(tenantId: string, tagId: string, recipientIds: string[]): Promise<void> {
    await runInTenantContext(this.dataSource, tenantId, async (manager) => {
      await this.getTagEntity(manager, tenantId, tagId);
      await this.removeMembers(manager, 'recipient_tag', 'tag_id', tenantId, tagId, recipientIds);
    });
  }

  /** BR-SEG-005: soft delete the list and only its memberships. */
  async removeList(tenantId: string, id: string, actor?: SegmentActor): Promise<void> {
    await runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const scheduledBindings = await manager.query(
        `SELECT 1
         FROM campaign campaign
         JOIN campaign_snapshot snapshot ON snapshot.campaign_id = campaign.id
           AND snapshot.tenant_id = campaign.tenant_id
           AND snapshot.superseded_at IS NULL
         WHERE campaign.tenant_id = $1 AND campaign.status = 'scheduled'
           AND (
             snapshot.audience_query_json @> jsonb_build_object('listIds', jsonb_build_array($2::uuid))
             OR snapshot.audience_query_json @> jsonb_build_object('include', jsonb_build_object('listIds', jsonb_build_array($2::uuid)))
             OR snapshot.audience_query_json @> jsonb_build_object('excludeListIds', jsonb_build_array($2::uuid))
           )
         LIMIT 1`,
        [tenantId, id],
      );
      if (scheduledBindings.length > 0) {
        throw new ConflictException({ code: 'LIST_IN_SCHEDULED_CAMPAIGN', message: 'This list is used by a scheduled campaign and cannot be deleted.' });
      }
      const [rows] = (await manager.query('UPDATE recipient_list SET deleted_at = now(), updated_at = now() WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL RETURNING id', [id, tenantId])) as [Array<{ id: string }>, number];
      if (rows.length === 0) throw new NotFoundException('Recipient list not found.');
      const membershipResult = await manager.query('DELETE FROM recipient_list_member WHERE tenant_id = $1 AND list_id = $2', [tenantId, id]);
      if (actor) await appendAuditLog(manager, { tenantId, actorId: actor.actorId, action: 'recipient_list.deleted', entityType: 'recipient_list', entityId: id, traceId: actor.traceId, metadata: { removedMembershipCount: membershipResult[1] ?? 0 } });
    });
  }

  /** BR-SEG-006: soft delete the tag and only its memberships. */
  async removeTag(tenantId: string, id: string, actor?: SegmentActor): Promise<void> {
    await runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const [rows] = (await manager.query('UPDATE tag SET deleted_at = now(), updated_at = now() WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL RETURNING id', [id, tenantId])) as [Array<{ id: string }>, number];
      if (rows.length === 0) throw new NotFoundException('Tag not found.');
      const membershipResult = await manager.query('DELETE FROM recipient_tag WHERE tenant_id = $1 AND tag_id = $2', [tenantId, id]);
      if (actor) await appendAuditLog(manager, { tenantId, actorId: actor.actorId, action: 'tag.deleted', entityType: 'tag', entityId: id, traceId: actor.traceId, metadata: { removedMembershipCount: membershipResult[1] ?? 0 } });
    });
  }

  private async listCatalog(table: 'recipient_list' | 'tag', tenantId: string, query: SegmentListQueryDto, includeColor: boolean) {
    return runInTenantContext(this.dataSource, tenantId, (manager) => this.listCatalogWithManager(manager, table, tenantId, query, includeColor));
  }

  private async listCatalogWithManager(manager: EntityManager, table: 'recipient_list' | 'tag', tenantId: string, query: SegmentListQueryDto, includeColor: boolean) {
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    const columns = includeColor ? 'segment.id, segment.tenant_id, segment.name, segment.color, segment.created_at, segment.updated_at' : 'segment.id, segment.tenant_id, segment.name, segment.description, segment.created_at, segment.updated_at';
    const memberTable = table === 'tag' ? 'recipient_tag' : 'recipient_list_member';
    const memberKey = table === 'tag' ? 'tag_id' : 'list_id';
    const countValues: unknown[] = [tenantId];
    const baseFilters = ['segment.tenant_id = $1', 'segment.deleted_at IS NULL'];
    if (query.search) { countValues.push(`%${query.search}%`); baseFilters.push(`segment.name ILIKE $${countValues.length}`); }
    const countRows = await manager.query(`SELECT count(*)::int AS count FROM ${table} segment WHERE ${baseFilters.join(' AND ')}`, countValues);
    const values = [...countValues];
    const filters = [...baseFilters];
    if (cursor) { values.push(cursor.name, cursor.id); filters.push(`(segment.name, segment.id) > ($${values.length - 1}, $${values.length})`); }
    const where = filters.join(' AND ');
    values.push(query.limit + 1);
    const rows = await manager.query(
      `SELECT ${columns}, count(recipient.id)::int AS member_count
       FROM ${table} segment
       LEFT JOIN ${memberTable} member ON member.${memberKey} = segment.id AND member.tenant_id = segment.tenant_id
       LEFT JOIN recipient recipient ON recipient.id = member.recipient_id AND recipient.tenant_id = segment.tenant_id AND recipient.deleted_at IS NULL
       WHERE ${where}
       GROUP BY segment.id
       ORDER BY segment.name ASC, segment.id ASC
       LIMIT $${values.length}`,
      values,
    ) as SegmentRow[];
    const hasMore = rows.length > query.limit;
    const items = hasMore ? rows.slice(0, query.limit) : rows;
    const responses = includeColor ? items.map((row) => tagResponse(row)) : items.map((row) => listResponse(row));
    return { items: responses, nextCursor: hasMore ? encodeCursor(items.at(-1)!) : null, total: Number(countRows[0]?.count ?? 0) };
  }

  private async getCatalogRow(table: 'recipient_list' | 'tag', tenantId: string, id: string, includeColor: boolean): Promise<SegmentRow | null> {
    return runInTenantContext(this.dataSource, tenantId, (manager) => this.getCatalogRowWithManager(manager, table, tenantId, id, includeColor));
  }

  private async getCatalogRowWithManager(manager: EntityManager, table: 'recipient_list' | 'tag', tenantId: string, id: string, includeColor: boolean): Promise<SegmentRow | null> {
    const columns = includeColor ? 'segment.id, segment.tenant_id, segment.name, segment.color, segment.created_at, segment.updated_at' : 'segment.id, segment.tenant_id, segment.name, segment.description, segment.created_at, segment.updated_at';
    const memberTable = table === 'tag' ? 'recipient_tag' : 'recipient_list_member';
    const memberKey = table === 'tag' ? 'tag_id' : 'list_id';
    const rows = await manager.query(
      `SELECT ${columns}, count(recipient.id)::int AS member_count
       FROM ${table} segment
       LEFT JOIN ${memberTable} member ON member.${memberKey} = segment.id AND member.tenant_id = segment.tenant_id
       LEFT JOIN recipient recipient ON recipient.id = member.recipient_id AND recipient.tenant_id = segment.tenant_id AND recipient.deleted_at IS NULL
       WHERE segment.id = $1 AND segment.tenant_id = $2 AND segment.deleted_at IS NULL
       GROUP BY segment.id`,
      [id, tenantId],
    ) as SegmentRow[];
    return rows[0] ?? null;
  }

  private async getListEntity(manager: EntityManager, tenantId: string, id: string): Promise<RecipientListEntity> {
    const entity = await new RecipientListsRepository(manager, tenantId).findActiveById(id);
    if (!entity) throw new NotFoundException('Recipient list not found.');
    return entity;
  }

  private async getTagEntity(manager: EntityManager, tenantId: string, id: string): Promise<TagEntity> {
    const entity = await new TagsRepository(manager, tenantId).findActiveById(id);
    if (!entity) throw new NotFoundException('Tag not found.');
    return entity;
  }

  private async addMembers(manager: EntityManager, table: 'recipient_list_member' | 'recipient_tag', key: 'list_id' | 'tag_id', tenantId: string, segmentId: string, recipientIds: string[]): Promise<void> {
    const uniqueRecipientIds = [...new Set(recipientIds)];
    await manager.query(
      `INSERT INTO ${table} (tenant_id, ${key}, recipient_id, source)
       SELECT $1, $2, recipient.id, 'manual' FROM recipient
       WHERE recipient.tenant_id = $1 AND recipient.id = ANY($3) AND recipient.deleted_at IS NULL
       ON CONFLICT (${key}, recipient_id) DO NOTHING`,
      [tenantId, segmentId, uniqueRecipientIds],
    );
  }

  private async removeMembers(manager: EntityManager, table: 'recipient_list_member' | 'recipient_tag', key: 'list_id' | 'tag_id', tenantId: string, segmentId: string, recipientIds: string[]): Promise<void> {
    await manager.query(`DELETE FROM ${table} WHERE tenant_id = $1 AND ${key} = $2 AND recipient_id = ANY($3)`, [tenantId, segmentId, [...new Set(recipientIds)]]);
  }

  private throwNameConflict(error: unknown, label: string): never {
    const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: unknown }).code : undefined;
    if (code === '23505') throw new ConflictException(`${label} name already exists.`);
    throw error;
  }
}
