import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import { CustomFieldsRepository } from './custom-fields.repository.js';
import { CustomFieldDefinitionEntity } from '../database/entities/custom-field-definition.entity.js';
import { FORMATTABLE_VARIABLE_TYPES, RESERVED_CUSTOM_FIELD_KEYS, type CustomFieldCreateRequestDto, type CustomFieldUpdateRequestDto } from './dto/custom-field.dto.js';
export type CustomFieldRecord = CustomFieldDefinitionEntity;
import { runInTenantContext } from '../database/tenant-transaction.js';
import { ConfiguredVariablesRepository } from '../configured-variables/configured-variables.repository.js';

/**
 * Singleton service (not REQUEST-scoped) -- same explicit-tenantId-
 * parameter pattern as RecipientsService, for the same DI-ordering reason
 * (see custom-fields.repository.ts's class comment).
 */
@Injectable()
export class CustomFieldsService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  private repositoryFor(manager: EntityManager, tenantId: string): CustomFieldsRepository {
    return new CustomFieldsRepository(manager, tenantId);
  }

  async list(tenantId: string): Promise<CustomFieldDefinitionEntity[]> {
    return runInTenantContext(this.dataSource, tenantId, (manager) => this.listWithManager(manager, tenantId));
  }

  listWithManager(manager: EntityManager, tenantId: string): Promise<CustomFieldDefinitionEntity[]> {
    return this.repositoryFor(manager, tenantId).list();
  }

  async getOrThrow(tenantId: string, id: string): Promise<CustomFieldDefinitionEntity> {
    return runInTenantContext(this.dataSource, tenantId, (manager) => this.getOrThrowWithManager(manager, tenantId, id));
  }

  private async getOrThrowWithManager(manager: EntityManager, tenantId: string, id: string): Promise<CustomFieldDefinitionEntity> {
    const field = await this.repositoryFor(manager, tenantId).findById(id);
    if (!field) throw new NotFoundException('Custom field not found.');
    return field;
  }

  /**
   * BR-CF-001/BR-CF-003: rejects a reserved system key (422, with the
   * reserved-key list in the Problem body -- the rule's literal acceptance
   * text) and a duplicate key within the tenant (409, matching
   * RecipientsService.create's own 409-on-duplicate convention).
   */
  async create(tenantId: string, body: CustomFieldCreateRequestDto): Promise<CustomFieldDefinitionEntity> {
    return runInTenantContext(this.dataSource, tenantId, (manager) => this.createWithManager(manager, tenantId, body));
  }

  private async createWithManager(manager: EntityManager, tenantId: string, body: CustomFieldCreateRequestDto): Promise<CustomFieldDefinitionEntity> {
    if ((RESERVED_CUSTOM_FIELD_KEYS as readonly string[]).includes(body.key)) {
      throw new UnprocessableEntityException({
        message: `"${body.key}" is a reserved system field and cannot be used as a custom-field key.`,
        reservedKeys: RESERVED_CUSTOM_FIELD_KEYS,
      });
    }

    const repository = this.repositoryFor(manager, tenantId);
    const configured = await new ConfiguredVariablesRepository(manager, tenantId).findAnyByKey(body.key);
    if (configured) {
      throw new ConflictException({ message: 'A configured variable with this key already exists.', variableKey: body.key });
    }
    const existing = await repository.findByKey(body.key);
    if (existing) {
      throw new ConflictException({ message: 'A custom field with this key already exists.', customFieldId: existing.id });
    }

    return repository.save({
      fieldKey: body.key,
      label: body.label,
      dataType: body.type,
      required: body.required,
      defaultValue: body.defaultValue ?? null,
      enumOptions: body.enumOptions ?? null,
      sensitive: body.sensitive,
      // ADR-036: presentation on the definition, resolved at render time.
      format: body.format ?? null,
      timezone: body.timezone ?? null,
    } as Partial<CustomFieldDefinitionEntity>);
  }

  /** BR-CF-001: key is never accepted here (see the update DTO's own comment); label/type-adjacent metadata may change freely. */
  async update(tenantId: string, id: string, body: CustomFieldUpdateRequestDto): Promise<CustomFieldDefinitionEntity> {
    return runInTenantContext(this.dataSource, tenantId, (manager) => this.updateWithManager(manager, tenantId, id, body));
  }

  private async updateWithManager(manager: EntityManager, tenantId: string, id: string, body: CustomFieldUpdateRequestDto): Promise<CustomFieldDefinitionEntity> {
    const current = await this.getOrThrowWithManager(manager, tenantId, id);
    const patch: Partial<CustomFieldDefinitionEntity> = { id } as Partial<CustomFieldDefinitionEntity>;
    if (body.label !== undefined) patch.label = body.label;
    if (body.required !== undefined) patch.required = body.required;
    if (body.defaultValue !== undefined) patch.defaultValue = body.defaultValue;
    if (body.enumOptions !== undefined) patch.enumOptions = body.enumOptions;
    if (body.sensitive !== undefined) patch.sensitive = body.sensitive;
    if (body.format !== undefined) patch.format = body.format ?? null;
    if (body.timezone !== undefined) patch.timezone = body.timezone ?? null;

    if (current.dataType !== 'enum' && (patch.enumOptions?.length ?? 0) > 0) {
      throw new UnprocessableEntityException('enumOptions is only valid for an enum-typed field.');
    }

    // ADR-036. The create DTO can check this itself because `type` is in the
    // body; an update cannot -- BR-CF-001 keeps the type immutable, so it is
    // absent there and only the stored row knows it.
    const settingFormatting = (patch.format ?? null) !== null || (patch.timezone ?? null) !== null;
    if (settingFormatting && !FORMATTABLE_VARIABLE_TYPES.includes(current.dataType)) {
      throw new UnprocessableEntityException(`format and timezone are only valid for a field of type ${FORMATTABLE_VARIABLE_TYPES.join(', ')}.`);
    }

    // TypeORM's save() on a partial entity returns only the properties that
    // were actually passed to it (plus generated columns), not a re-fetch
    // of the full row -- reload explicitly so callers (and this method's
    // own return value) always see the complete, current entity, not a
    // partial object where an untouched column like fieldKey is undefined.
    await this.repositoryFor(manager, tenantId).save(patch);
    return this.getOrThrowWithManager(manager, tenantId, id);
  }

  async remove(tenantId: string, id: string): Promise<void> {
    await runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const field = await this.getOrThrowWithManager(manager, tenantId, id);
      const [draftDependency] = await manager.query(
        `SELECT id, name FROM email_template
         WHERE tenant_id = $1 AND deleted_at IS NULL
           AND (draft_subject ~ $2 OR draft_html ~ $2 OR draft_text_body ~ $2)
         ORDER BY updated_at DESC LIMIT 1`,
        [tenantId, `\\{\\{[[:space:]]*${field.fieldKey}[[:space:]]*\\}\\}`],
      ) as Array<{ id: string; name: string }>;
      const [publishedDependency] = await manager.query(
        // t.deleted_at IS NULL matches the draft query above. Without it an
        // archived template held its fields hostage forever: archiving is
        // one-way (no unarchive path, and requireActive refuses every change
        // with TEMPLATE_ARCHIVED), so the reference can never come back, yet
        // the field could never be removed either. The tenant's field list
        // then only ever grew. Old versions stay readable and previewable --
        // preview is lenient and reports the key in `missingKeys` rather than
        // failing -- and campaigns that already sent used a frozen snapshot.
        `SELECT v.template_id AS id, t.name
         FROM email_template_version v
         INNER JOIN email_template t ON t.id = v.template_id AND t.tenant_id = v.tenant_id
         WHERE v.tenant_id = $1 AND t.deleted_at IS NULL
           AND ((v.variable_schema_json -> 'required') ? $2 OR (v.variable_schema_json -> 'optional') ? $2)
         ORDER BY v.published_at DESC LIMIT 1`,
        [tenantId, field.fieldKey],
      ) as Array<{ id: string; name: string }>;
      const dependency = draftDependency ?? publishedDependency;
      if (dependency) {
        throw new ConflictException({
          code: 'CUSTOM_FIELD_IN_USE',
          message: `Custom field "${field.fieldKey}" is referenced by template "${dependency.name}".`,
          customFieldId: field.id,
          templateId: dependency.id,
          nextAction: 'OPEN_TEMPLATE',
        });
      }
      await this.repositoryFor(manager, tenantId).remove(id);
    });
  }
}
