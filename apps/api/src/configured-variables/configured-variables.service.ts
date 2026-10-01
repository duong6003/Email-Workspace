import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import { FORMATTABLE_VARIABLE_TYPES, RESERVED_CUSTOM_FIELD_KEYS } from '../custom-fields/dto/custom-field.dto.js';
import { coerceConfiguredVariableValue } from '../custom-fields/custom-field-values.js';
import type { CustomFieldType } from '../database/entities/custom-field-definition.entity.js';
import { CustomFieldsRepository } from '../custom-fields/custom-fields.repository.js';
import type { ConfiguredVariableEntity } from '../database/entities/configured-variable.entity.js';
import { runInTenantContext } from '../database/tenant-transaction.js';
import { TemplatesRepository } from '../templates/templates.repository.js';
import { ConfiguredVariablesRepository } from './configured-variables.repository.js';
import type { CreateGlobalVariableDto, CreateTemplateVariableDto, UpdateGlobalVariableDto, UpdateTemplateVariableDto } from './dto/configured-variable.dto.js';

export type ConfiguredVariableResponse = {
  id: string;
  scope: 'global' | 'template';
  templateId: string | null;
  key: string;
  label: string;
  dataType: CustomFieldType;
  enumOptions: string[] | null;
  format: string | null;
  timezone: string | null;
  defaultValue: unknown;
  required: boolean;
  allowCampaignOverride: boolean;
  createdAt: string;
  updatedAt: string;
};

export function configuredVariableResponse(variable: ConfiguredVariableEntity): ConfiguredVariableResponse {
  return {
    id: variable.id,
    scope: variable.scope,
    templateId: variable.templateId,
    key: variable.variableKey,
    label: variable.label,
    // ADR-036: a variable created before this feature reads back as `text`,
    // which is exactly what an untyped configured variable already was.
    dataType: variable.dataType ?? 'text',
    enumOptions: variable.enumOptions ?? null,
    format: variable.format ?? null,
    timezone: variable.timezone ?? null,
    defaultValue: variable.defaultValue ?? null,
    required: variable.required,
    allowCampaignOverride: variable.allowCampaignOverride,
    createdAt: variable.createdAt.toISOString(),
    updatedAt: variable.updatedAt.toISOString(),
  };
}

/**
 * ADR-036: the columns that carry a configured variable's declared type and
 * presentation. `dataType` is defaulted here as well as in the DTO, because
 * `text` -- what an untyped configured variable already was -- must be the
 * answer for every caller, including the in-process ones that construct a body
 * directly rather than parsing one.
 */
function typedColumns(body: TypedVariableBody) {
  return {
    dataType: variableDataType(body),
    enumOptions: body.enumOptions ?? null,
    format: body.format ?? null,
    timezone: body.timezone ?? null,
  };
}

type TypedVariableBody = { dataType?: CustomFieldType; enumOptions?: string[]; format?: string | null; timezone?: string | null };

function variableDataType(body: TypedVariableBody): CustomFieldType {
  return body.dataType ?? 'text';
}

@Injectable()
export class ConfiguredVariablesService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  listGlobal(tenantId: string): Promise<ConfiguredVariableResponse[]> {
    return runInTenantContext(this.dataSource, tenantId, async (manager) =>
      (await new ConfiguredVariablesRepository(manager, tenantId).listGlobal()).map(configuredVariableResponse));
  }

  listTemplate(tenantId: string, templateId: string): Promise<ConfiguredVariableResponse[]> {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      await this.requireTemplate(manager, tenantId, templateId);
      return (await new ConfiguredVariablesRepository(manager, tenantId).listTemplate(templateId)).map(configuredVariableResponse);
    });
  }

  createGlobal(tenantId: string, body: CreateGlobalVariableDto): Promise<ConfiguredVariableResponse> {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      await this.assertKeyAvailable(manager, tenantId, body.key, 'global');
      try {
        return configuredVariableResponse(await new ConfiguredVariablesRepository(manager, tenantId).save({
          scope: 'global', templateId: null, variableKey: body.key, label: body.label,
          ...typedColumns(body),
          defaultValue: coerceConfiguredVariableValue({ variableKey: body.key, dataType: variableDataType(body), enumOptions: body.enumOptions ?? null }, body.defaultValue),
          required: false, allowCampaignOverride: body.allowCampaignOverride,
        }));
      } catch (error) { this.throwConflict(error); }
    });
  }

  createTemplate(tenantId: string, templateId: string, body: CreateTemplateVariableDto): Promise<ConfiguredVariableResponse> {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      await this.requireTemplate(manager, tenantId, templateId);
      await this.assertKeyAvailable(manager, tenantId, body.key, 'template', templateId);
      try {
        return configuredVariableResponse(await new ConfiguredVariablesRepository(manager, tenantId).save({
          scope: 'template', templateId, variableKey: body.key, label: body.label,
          ...typedColumns(body),
          defaultValue: coerceConfiguredVariableValue({ variableKey: body.key, dataType: variableDataType(body), enumOptions: body.enumOptions ?? null }, body.defaultValue ?? null),
          required: body.required, allowCampaignOverride: body.allowCampaignOverride,
        }));
      } catch (error) { this.throwConflict(error); }
    });
  }

  updateGlobal(tenantId: string, id: string, body: UpdateGlobalVariableDto): Promise<ConfiguredVariableResponse> {
    return this.update(tenantId, id, 'global', body);
  }

  updateTemplate(tenantId: string, id: string, body: UpdateTemplateVariableDto): Promise<ConfiguredVariableResponse> {
    return this.update(tenantId, id, 'template', body);
  }

  remove(tenantId: string, id: string, scope: 'global' | 'template'): Promise<void> {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const repository = new ConfiguredVariablesRepository(manager, tenantId);
      const current = await repository.findById(id);
      if (!current || current.scope !== scope) throw new NotFoundException('Configured variable was not found.');
      const dependency = await manager.query(
        `SELECT t.id, t.name FROM email_template_version v
         JOIN email_template t ON t.id = v.template_id AND t.tenant_id = v.tenant_id
         WHERE v.tenant_id = $1
           AND v.variable_schema_json #>> ARRAY['configured', $2, 'scope'] = $3
           AND ($4::uuid IS NULL OR v.template_id = $4::uuid)
         ORDER BY v.published_at DESC LIMIT 1`,
        [tenantId, current.variableKey, current.scope, current.scope === 'template' ? current.templateId : null],
      ) as Array<{ id: string; name: string }>;
      if (dependency[0]) throw new ConflictException({ code: 'CONFIGURED_VARIABLE_IN_USE', message: `Variable is used by published template "${dependency[0].name}".`, templateId: dependency[0].id });
      await repository.remove(id);
    });
  }

  private update(tenantId: string, id: string, scope: 'global' | 'template', body: UpdateGlobalVariableDto | UpdateTemplateVariableDto): Promise<ConfiguredVariableResponse> {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const repository = new ConfiguredVariablesRepository(manager, tenantId);
      const current = await repository.findById(id);
      if (!current || current.scope !== scope) throw new NotFoundException('Configured variable was not found.');
      const dataType = current.dataType ?? 'text';
      const enumOptions = body.enumOptions ?? current.enumOptions ?? null;
      if (body.enumOptions !== undefined && dataType !== 'enum') {
        throw new UnprocessableEntityException('enumOptions is only valid for an enum-typed variable.');
      }
      // ADR-036: the update DTOs deliberately omit dataType (it is immutable),
      // so only the stored row knows whether formatting applies at all.
      if (((body.format ?? null) !== null || (body.timezone ?? null) !== null) && !FORMATTABLE_VARIABLE_TYPES.includes(dataType)) {
        throw new UnprocessableEntityException(`format and timezone are only valid for a variable of type ${FORMATTABLE_VARIABLE_TYPES.join(', ')}.`);
      }
      const updated = await repository.save({
        ...current,
        ...(body.label === undefined ? {} : { label: body.label }),
        ...(body.enumOptions === undefined ? {} : { enumOptions }),
        ...(body.format === undefined ? {} : { format: body.format ?? null }),
        ...(body.timezone === undefined ? {} : { timezone: body.timezone ?? null }),
        ...(body.defaultValue === undefined ? {} : { defaultValue: coerceConfiguredVariableValue({ variableKey: current.variableKey, dataType, enumOptions }, body.defaultValue) }),
        ...(!('required' in body) || body.required === undefined ? {} : { required: body.required }),
        ...(body.allowCampaignOverride === undefined ? {} : { allowCampaignOverride: body.allowCampaignOverride }),
      });
      return configuredVariableResponse(updated);
    });
  }

  private async assertKeyAvailable(manager: EntityManager, tenantId: string, key: string, scope: 'global' | 'template', templateId?: string): Promise<void> {
    if (RESERVED_CUSTOM_FIELD_KEYS.includes(key as (typeof RESERVED_CUSTOM_FIELD_KEYS)[number])) {
      throw new UnprocessableEntityException({ code: 'CONFIGURED_VARIABLE_RESERVED_KEY', message: 'Configured variables cannot shadow system variables.', variableKey: key });
    }
    if (await new CustomFieldsRepository(manager, tenantId).findByKey(key)) {
      throw new UnprocessableEntityException({ code: 'CONFIGURED_VARIABLE_RECIPIENT_KEY', message: 'Configured variables cannot shadow recipient custom fields.', variableKey: key });
    }
    const repository = new ConfiguredVariablesRepository(manager, tenantId);
    if (scope === 'template' && await repository.findGlobalByKey(key)) {
      throw new UnprocessableEntityException({ code: 'CONFIGURED_VARIABLE_GLOBAL_KEY', message: 'Template variables cannot shadow a global variable.', variableKey: key });
    }
    if (scope === 'global') {
      if (await repository.findGlobalByKey(key)) {
        throw new ConflictException({ code: 'CONFIGURED_VARIABLE_KEY_CONFLICT', message: 'This global variable key already exists.' });
      }
      // The shadow rule is symmetric: a global created after the template would
      // be permanently shadowed by that template's local key (ADR-032).
      const owner = await repository.findAnyTemplateByKey(key);
      if (owner) {
        throw new UnprocessableEntityException({ code: 'CONFIGURED_VARIABLE_TEMPLATE_KEY', message: 'A template already owns this variable key.', variableKey: key, templateId: owner.templateId });
      }
    }
    if (scope === 'template' && templateId && await repository.findTemplateByKey(templateId, key)) {
      throw new ConflictException({ code: 'CONFIGURED_VARIABLE_KEY_CONFLICT', message: 'This template already has the selected variable key.' });
    }
  }

  private async requireTemplate(manager: EntityManager, tenantId: string, templateId: string): Promise<void> {
    if (!await new TemplatesRepository(manager, tenantId).findActiveById(templateId)) throw new NotFoundException('Template was not found.');
  }

  private throwConflict(error: unknown): never {
    if (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === '23505') {
      throw new ConflictException({ code: 'CONFIGURED_VARIABLE_KEY_CONFLICT', message: 'This variable key already exists in the selected scope.' });
    }
    throw error;
  }
}
