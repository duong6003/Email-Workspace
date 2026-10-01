import type { EntityManager } from 'typeorm';
import { TenantScopedRepository } from '../database/tenant-scoped.repository.js';
import { EmailTemplateEntity } from '../database/entities/email-template.entity.js';
import { EmailTemplateVersionEntity } from '../database/entities/email-template-version.entity.js';
import { TemplateTestSendEntity } from '../database/entities/template-test-send.entity.js';
import type { TemplateListQueryDto } from './dto/template.dto.js';

export class TemplatesRepository extends TenantScopedRepository<EmailTemplateEntity> {
  constructor(manager: EntityManager, tenantId: string) {
    super(manager.getRepository(EmailTemplateEntity), tenantId);
  }

  findActiveById(id: string, lock = false): Promise<EmailTemplateEntity | null> {
    const query = this.repository.createQueryBuilder('template')
      .where('template.id = :id AND template.tenant_id = :tenantId AND template.deleted_at IS NULL', { id, tenantId: this.tenantId });
    if (lock) query.setLock('pessimistic_write');
    return query.getOne();
  }

  findById(id: string): Promise<EmailTemplateEntity | null> {
    return this.repository.findOne({ where: { id, tenantId: this.tenantId } });
  }

  async list(query: TemplateListQueryDto): Promise<EmailTemplateEntity[]> {
    const builder = this.repository.createQueryBuilder('template')
      .where('template.tenant_id = :tenantId AND template.deleted_at IS NULL', { tenantId: this.tenantId })
      .orderBy('template.updated_at', 'DESC')
      .addOrderBy('template.id', 'DESC')
      .take(query.limit);
    if (query.search) builder.andWhere('template.name ILIKE :search', { search: `%${query.search}%` });
    if (query.status) builder.andWhere('template.status = :status', { status: query.status });
    return builder.getMany();
  }
}

export class TemplateVersionsRepository extends TenantScopedRepository<EmailTemplateVersionEntity> {
  constructor(manager: EntityManager, tenantId: string) {
    super(manager.getRepository(EmailTemplateVersionEntity), tenantId);
  }

  findById(id: string): Promise<EmailTemplateVersionEntity | null> {
    return this.repository.findOne({ where: { id, tenantId: this.tenantId } });
  }

  async nextVersion(templateId: string): Promise<number> {
    const row = await this.repository.createQueryBuilder('version')
      .select('COALESCE(MAX(version.version), 0)', 'max')
      .where('version.tenant_id = :tenantId AND version.template_id = :templateId', { tenantId: this.tenantId, templateId })
      .getRawOne<{ max: string }>();
    return Number(row?.max ?? 0) + 1;
  }

  /**
   * Metadata only, newest first. `html`/`textBody` are deliberately not
   * selected: a template may be 5 MB, and a history list carrying every
   * version's body would be unusable. Content comes from
   * GET /template-versions/:id when a specific version is opened.
   */
  listMetadataByTemplate(templateId: string): Promise<Array<Pick<EmailTemplateVersionEntity, 'id' | 'version' | 'subject' | 'contentHash' | 'publishedAt' | 'publishedBy'>>> {
    return this.repository.createQueryBuilder('version')
      .select(['version.id', 'version.version', 'version.subject', 'version.contentHash', 'version.publishedAt', 'version.publishedBy'])
      .where('version.tenant_id = :tenantId AND version.template_id = :templateId', { tenantId: this.tenantId, templateId })
      .orderBy('version.version', 'DESC')
      .getMany();
  }

  /** One row per template_id, the id of its highest-`version` row -- used to let the UI preview/test-send the current published content without a second round trip per template. */
  async findLatestIdsByTemplateIds(templateIds: string[]): Promise<Map<string, string>> {
    if (templateIds.length === 0) return new Map();
    const rows = await this.repository.manager.query(
      `SELECT DISTINCT ON (template_id) template_id AS "templateId", id
       FROM email_template_version
       WHERE tenant_id = $1 AND template_id = ANY($2::uuid[])
       ORDER BY template_id, version DESC`,
      [this.tenantId, templateIds],
    ) as Array<{ templateId: string; id: string }>;
    return new Map(rows.map((row) => [row.templateId, row.id]));
  }
}

export class TemplateTestSendsRepository extends TenantScopedRepository<TemplateTestSendEntity> {
  constructor(manager: EntityManager, tenantId: string) {
    super(manager.getRepository(TemplateTestSendEntity), tenantId);
  }

  findActorEmail(actorId: string): Promise<{ id: string; email: string } | null> {
    return this.repository.manager.query(
      'SELECT id, email FROM app_user WHERE id = $1 AND tenant_id = $2',
      [actorId, this.tenantId],
    ).then((rows: Array<{ id: string; email: string }>) => rows[0] ?? null);
  }

  findById(id: string): Promise<TemplateTestSendEntity | null> {
    return this.findOne({ id });
  }
}
