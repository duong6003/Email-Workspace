import type { EntityManager } from 'typeorm';
import { ConfiguredVariableEntity } from '../database/entities/configured-variable.entity.js';
import { TenantScopedRepository } from '../database/tenant-scoped.repository.js';

export class ConfiguredVariablesRepository extends TenantScopedRepository<ConfiguredVariableEntity> {
  constructor(manager: EntityManager, tenantId: string) {
    super(manager.getRepository(ConfiguredVariableEntity), tenantId);
  }

  listGlobal(): Promise<ConfiguredVariableEntity[]> {
    return this.repository.find({ where: { tenantId: this.tenantId, scope: 'global' }, order: { createdAt: 'ASC' } });
  }

  listTemplate(templateId: string): Promise<ConfiguredVariableEntity[]> {
    return this.repository.find({ where: { tenantId: this.tenantId, scope: 'template', templateId }, order: { createdAt: 'ASC' } });
  }

  listForTemplate(templateId: string): Promise<ConfiguredVariableEntity[]> {
    return this.repository.createQueryBuilder('variable')
      .where('variable.tenant_id = :tenantId', { tenantId: this.tenantId })
      .andWhere("variable.scope = 'global' OR (variable.scope = 'template' AND variable.template_id = :templateId)", { templateId })
      .orderBy('variable.scope', 'ASC')
      .addOrderBy('variable.created_at', 'ASC')
      .getMany();
  }

  findById(id: string): Promise<ConfiguredVariableEntity | null> {
    return this.findOne({ id });
  }

  findAnyByKey(variableKey: string): Promise<ConfiguredVariableEntity | null> {
    return this.repository.findOne({ where: { tenantId: this.tenantId, variableKey } });
  }

  findGlobalByKey(variableKey: string): Promise<ConfiguredVariableEntity | null> {
    return this.repository.findOne({ where: { tenantId: this.tenantId, scope: 'global', variableKey } });
  }

  findTemplateByKey(templateId: string, variableKey: string): Promise<ConfiguredVariableEntity | null> {
    return this.repository.findOne({ where: { tenantId: this.tenantId, scope: 'template', templateId, variableKey } });
  }

  findAnyTemplateByKey(variableKey: string): Promise<ConfiguredVariableEntity | null> {
    return this.repository.findOne({ where: { tenantId: this.tenantId, scope: 'template', variableKey } });
  }

  async remove(id: string): Promise<void> {
    await this.repository.delete({ id, tenantId: this.tenantId });
  }
}
