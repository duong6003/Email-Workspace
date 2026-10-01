import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import { RecipientsRepository } from './recipients.repository.js';
import { RecipientEntity } from '../database/entities/recipient.entity.js';
import { PERMISSIONS } from '../common/permissions.js';
import { appendAuditLog } from '../common/audit-writer.js';
import { CustomFieldsService } from '../custom-fields/custom-fields.service.js';
import { applyCustomFieldDefaults, validateCustomData } from '../custom-fields/custom-field-values.js';
import type { RecipientCreateRequestDto, RecipientListQueryDto, RecipientUpdateRequestDto } from './dto/recipient.dto.js';
import { runInTenantContext } from '../database/tenant-transaction.js';

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Who performed the write, for BR-CF-009's per-field value audit rows. */
export type ActorContext = { actorId: string | null; traceId: string };
export type RecipientRecord = RecipientEntity;

/**
 * Singleton service (not REQUEST-scoped, see recipients.repository.ts's
 * class comment for why): every method takes tenantId explicitly, read by
 * the controller from request.auth.tenantId (populated by the already-run
 * global AuthGuard) and forwarded here to build a fresh, tenant-bound
 * RecipientsRepository per call from the transaction manager carrying the
 * transaction-local PostgreSQL tenant context.
 */
@Injectable()
export class RecipientsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly customFields: CustomFieldsService,
  ) {}

  private repositoryFor(manager: EntityManager, tenantId: string): RecipientsRepository {
    return new RecipientsRepository(manager, tenantId);
  }

  async list(tenantId: string, query: RecipientListQueryDto) {
    return runInTenantContext(this.dataSource, tenantId, (manager) => this.repositoryFor(manager, tenantId).list({
      search: query.search,
      status: query.status,
      listIds: query.listIds,
      tagIds: query.tagIds,
      cursor: query.cursor,
      limit: query.limit,
    }));
  }

  async getOrThrow(tenantId: string, id: string): Promise<RecipientEntity> {
    return runInTenantContext(this.dataSource, tenantId, (manager) => this.getOrThrowWithManager(manager, tenantId, id));
  }

  private async getOrThrowWithManager(manager: EntityManager, tenantId: string, id: string): Promise<RecipientEntity> {
    const recipient = await this.repositoryFor(manager, tenantId).findActiveById(id);
    if (!recipient) throw new NotFoundException('Recipient not found.');
    return recipient;
  }

  /**
   * BR-REC-001: duplicate email (case/whitespace-insensitive) within the
   * tenant returns 409 with the existing recipient's id.
   * BR-CF-002 (M2-S3): every customData value is validated/coerced against
   * the tenant's current custom-field schema before it is stored; an
   * unknown key or a value of the wrong type is rejected (400), never
   * silently stored as an opaque string. Required fields with no supplied
   * value fall back to their configured default_value.
   */
  async create(tenantId: string, body: RecipientCreateRequestDto, actor: ActorContext): Promise<RecipientEntity> {
    return runInTenantContext(this.dataSource, tenantId, (manager) => this.createWithManager(manager, tenantId, body, actor));
  }

  private async createWithManager(manager: EntityManager, tenantId: string, body: RecipientCreateRequestDto, actor: ActorContext): Promise<RecipientEntity> {
    const repository = this.repositoryFor(manager, tenantId);
    const normalizedEmail = normalizeEmail(body.email);
    const existing = await repository.findActiveByNormalizedEmail(normalizedEmail);
    if (existing) {
      throw new ConflictException({ message: 'A recipient with this email already exists.', recipientId: existing.id });
    }

    const fields = await this.customFields.listWithManager(manager, tenantId);
    const withDefaults = applyCustomFieldDefaults(fields, body.customData ?? {});
    const customData = validateCustomData(fields, withDefaults);

    const created = await repository.save({
      email: body.email.trim(),
      firstName: body.firstName ?? null,
      lastName: body.lastName ?? null,
      phone: body.phone ?? null,
      department: body.department ?? null,
      title: body.title ?? null,
      location: body.location ?? null,
      subscriptionStatus: body.subscriptionStatus,
      customData,
    } as Partial<RecipientEntity>);

    await this.auditCustomDataChanges(manager, tenantId, created.id, fields, {}, customData, actor, null);
    return created;
  }

  async update(tenantId: string, id: string, body: RecipientUpdateRequestDto, callerPermissions: string[], actor: ActorContext): Promise<RecipientEntity> {
    return runInTenantContext(this.dataSource, tenantId, (manager) => this.updateWithManager(manager, tenantId, id, body, callerPermissions, actor));
  }

  private async updateWithManager(manager: EntityManager, tenantId: string, id: string, body: RecipientUpdateRequestDto, callerPermissions: string[], actor: ActorContext): Promise<RecipientEntity> {
    const repository = this.repositoryFor(manager, tenantId);
    const current = await this.getOrThrowWithManager(manager, tenantId, id);

    if (body.email) {
      const normalizedEmail = normalizeEmail(body.email);
      if (normalizedEmail !== current.normalizedEmail) {
        const existing = await repository.findActiveByNormalizedEmail(normalizedEmail);
        if (existing && existing.id !== id) {
          throw new ConflictException({ message: 'A recipient with this email already exists.', recipientId: existing.id });
        }
      }
    }

    // BR-REC-004: unsubscribed -> active is never a "normal" update. Only
    // an Admin (settings:manage) explicitly confirming re-consent may do it.
    if (body.subscriptionStatus === 'active' && current.subscriptionStatus === 'unsubscribed') {
      const isAdmin = callerPermissions.includes(PERMISSIONS.SETTINGS_MANAGE);
      if (!isAdmin || !body.confirmReconsent) {
        throw new ForbiddenException('Reactivating an unsubscribed recipient requires Admin re-consent confirmation.');
      }
    }

    const patch: Partial<RecipientEntity> = { id } as Partial<RecipientEntity>;
    if (body.email !== undefined) patch.email = body.email.trim();
    if (body.firstName !== undefined) patch.firstName = body.firstName;
    if (body.lastName !== undefined) patch.lastName = body.lastName;
    if (body.phone !== undefined) patch.phone = body.phone;
    if (body.department !== undefined) patch.department = body.department;
    if (body.title !== undefined) patch.title = body.title;
    if (body.location !== undefined) patch.location = body.location;

    let fields: Awaited<ReturnType<CustomFieldsService['list']>> = [];
    let validatedCustomData: Record<string, unknown> | undefined;
    if (body.customData !== undefined) {
      fields = await this.customFields.listWithManager(manager, tenantId);
      // BR-CF-002: PATCH's customData is a full replacement of the object
      // (matching the pre-existing RecipientUpdateRequest contract, which
      // already accepted a raw record) -- validate/coerce it in full.
      validatedCustomData = validateCustomData(fields, body.customData);
      patch.customData = validatedCustomData;
    }
    if (body.subscriptionStatus !== undefined) {
      patch.subscriptionStatus = body.subscriptionStatus;
      // Track the moment a recipient becomes unsubscribed; cleared on any
      // (permitted) transition back to active.
      patch.unsubscribedAt = body.subscriptionStatus === 'unsubscribed' ? new Date() : null;
    }

    await repository.save(patch);

    if (validatedCustomData !== undefined) {
      await this.auditCustomDataChanges(manager, tenantId, id, fields, current.customData ?? {}, validatedCustomData, actor, null);
    }

    // TypeORM's save() on a partial entity returns only the properties that
    // were actually passed to it (plus generated columns), not a re-fetch of
    // the full row -- reload explicitly so callers (toResponse's
    // .createdAt.toISOString(), in particular) always see the complete,
    // current entity rather than one where an untouched column like
    // createdAt is undefined. Same fix as CustomFieldsService.updateWithManager.
    return this.getOrThrowWithManager(manager, tenantId, id);
  }

  /** BR-GEN-006: soft delete only. BR-REC-010: nothing here touches campaign_recipient snapshots. */
  async remove(tenantId: string, id: string): Promise<void> {
    await runInTenantContext(this.dataSource, tenantId, async (manager) => {
      await this.getOrThrowWithManager(manager, tenantId, id);
      await this.repositoryFor(manager, tenantId).softDelete(id);
    });
  }

  /**
   * BR-CF-009: "Thay đổi custom data ghi field key, actor, source job và
   * before/after theo chính sách che PII." -- writes one audit_log row per
   * changed key (not one row for the whole customData blob, so it is
   * "tra được theo recipient/job" at field granularity), masking the value
   * ("***") when the field definition is flagged sensitive. sourceJob is
   * null here (a direct API write); M2-S4's bulk-update job passes its own
   * job id through this same actor-shaped hook when it lands.
   */
  private async auditCustomDataChanges(
    manager: EntityManager,
    tenantId: string,
    recipientId: string,
    fields: Awaited<ReturnType<CustomFieldsService['list']>>,
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    actor: ActorContext,
    sourceJob: string | null,
  ): Promise<void> {
    const sensitiveByKey = new Map(fields.map((field) => [field.fieldKey, field.sensitive]));
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);

    for (const key of keys) {
      const beforeValue = before[key];
      const afterValue = after[key];
      if (JSON.stringify(beforeValue) === JSON.stringify(afterValue)) continue;

      const sensitive = sensitiveByKey.get(key) ?? false;
      await appendAuditLog(manager, {
        tenantId,
        actorId: actor.actorId,
        action: 'recipient.custom_data.updated',
        entityType: 'recipient',
        entityId: recipientId,
        traceId: actor.traceId,
        metadata: {
          fieldKey: key,
          sourceJob,
          before: sensitive ? (beforeValue === undefined ? undefined : '***') : beforeValue,
          after: sensitive ? (afterValue === undefined ? undefined : '***') : afterValue,
        },
      });
    }
  }
}
