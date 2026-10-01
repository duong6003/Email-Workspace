import { createHash, randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';
import { ConflictException, HttpException, Injectable, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import { IdempotencyService } from '../common/idempotency.service.js';
import { appendAuditLog } from '../common/audit-writer.js';
import { appendOutboxEvent } from '../outbox/outbox-writer.js';
import { appLogger } from '../observability/logger.js';
import { runInTenantContext } from '../database/tenant-transaction.js';
import type { EmailTemplateEntity } from '../database/entities/email-template.entity.js';
import type { EmailTemplateVersionEntity } from '../database/entities/email-template-version.entity.js';
import type { CustomFieldType } from '../database/entities/custom-field-definition.entity.js';
import type { CreateTemplateDto, TemplateAnalyzeDto, TemplateListQueryDto, TemplatePreviewDto, TemplateTestSendDto, UpdateTemplateDto } from './dto/template.dto.js';
import { sanitizeTemplateHtml, type TemplateSanitizationResult } from './template-html-sanitizer.js';
import { TemplateTestSendsRepository, TemplatesRepository, TemplateVersionsRepository } from './templates.repository.js';
import { CustomFieldsRepository } from '../custom-fields/custom-fields.repository.js';
import { SendingPolicyRepository } from '../sender-config/sender-config.repository.js';
import { TemplateVariableError, analyzeTemplateVariables, parseTemplateVariableTokens, type TemplateVariableSchema } from './template-variables.js';
import { renderTemplateVariables } from './template-variable-renderer.js';
import { buildVariableFormatting, resolveVariableFormatting } from './variable-formatting.js';
import { lintTemplateContent, type TemplateLintIssue } from './template-content-lint.js';
import { ConfiguredVariablesRepository } from '../configured-variables/configured-variables.repository.js';
import { resolveConfiguredVariableValues } from '../configured-variables/configured-variable-resolution.js';
import { buildTemplateAnalysisCatalogue, classifyTemplateAnalysisTokens } from './template-analysis.js';

export type TemplateActor = { actorId: string | null; traceId: string };
export type TestSendActor = TemplateActor;

export type TemplateResponse = {
  id: string;
  name: string;
  status: string;
  origin: 'imported' | 'builder';
  draftRevision: number;
  subject: string;
  html: string;
  textBody: string;
  projectData: Record<string, unknown> | null;
  validation: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  latestVersionId: string | null;
};

/**
 * Library-list shape: everything the grid renders, minus the two fields that
 * carry the content itself. `html` alone is capped at 5 MB per template and the
 * three callers of this endpoint all pass `limit: 100`, so shipping it made the
 * listing scale with content size rather than with row count. Same reasoning as
 * `TemplateVersionSummary` below. The thumbnail fetches `GET /templates/:id`
 * for the cards actually on screen instead.
 */
export type TemplateSummaryResponse = Omit<TemplateResponse, 'html' | 'textBody' | 'projectData'>;

/** History-list shape: metadata only, no `html`/`textBody` — see listVersions. */
export type TemplateVersionSummary = {
  id: string;
  version: number;
  subject: string;
  contentHash: string;
  publishedAt: Date;
  publishedBy: string | null;
};

export type TemplateVersionResponse = {
  id: string;
  templateId: string;
  version: number;
  subject: string;
  html: string;
  textBody: string;
  variableSchema: TemplateVariableSchema;
  contentHash: string;
  publishedAt: Date;
};

export type TemplatePreviewResponse = {
  subject: string;
  html: string;
  textBody: string;
  missingKeys: string[];
};

export type TemplateTestSendResponse = {
  id: string;
  recipient: string;
  idempotencyReplayed: boolean;
};

export type TemplateAnalysisResponse = {
  sanitizedHtml: string;
  validation: Record<string, unknown>;
  variables: Array<{ field: 'subject' | 'html' | 'textBody'; key: string; start: number; end: number; classification: 'system' | 'custom' | 'unknown'; source: 'system' | 'recipient' | 'global' | 'template' | 'unknown'; label: string | null }>;
  unknownVariables: Array<{ field: 'subject' | 'html' | 'textBody'; key: string; start: number; end: number; classification: 'unknown'; source: 'unknown'; label: null; suggestedActions: string[] }>;
  catalogue: Array<{ key: string; label: string; classification: 'system' | 'custom'; source: 'system' | 'recipient' | 'global' | 'template'; required: boolean; dataType: CustomFieldType; format: string | null; timezone: string | null; example: string | null }>;
  lint: TemplateLintIssue[];
};

function templateResponse(template: EmailTemplateEntity, latestVersionId: string | null): TemplateResponse {
  return {
    id: template.id, name: template.name, status: template.status,
    origin: template.origin, draftRevision: template.draftRevision,
    subject: template.draftSubject, html: template.draftHtml, textBody: template.draftTextBody,
    projectData: template.projectData,
    validation: template.draftValidationJson, createdAt: template.createdAt, updatedAt: template.updatedAt,
    latestVersionId,
  };
}

function templateSummaryResponse(template: EmailTemplateEntity, latestVersionId: string | null): TemplateSummaryResponse {
  const { html: _html, textBody: _textBody, projectData: _projectData, ...summary } = templateResponse(template, latestVersionId);
  return summary;
}

function versionResponse(version: EmailTemplateVersionEntity): TemplateVersionResponse {
  return {
    id: version.id, templateId: version.templateId, version: version.version,
    subject: version.subject, html: version.html, textBody: version.textBody,
    variableSchema: version.variableSchemaJson as TemplateVariableSchema, contentHash: version.contentHash, publishedAt: version.publishedAt,
  };
}

export function fallbackText(html: string): string {
  const withLinks = html.replace(/<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi, (_match, _quote: string, href: string, label: string) => `${label} (${href})`);
  const text = withLinks
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_match, entity: string) => {
      const lower = entity.toLowerCase();
      if (lower === 'amp') return '&';
      if (lower === 'lt') return '<';
      if (lower === 'gt') return '>';
      if (lower === 'quot') return '"';
      if (lower === 'apos') return "'";
      const codePoint = lower.startsWith('#x') ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
      return Number.isSafeInteger(codePoint) ? String.fromCodePoint(codePoint) : _match;
    });
  return text.replace(/[ \t]*\n[ \t]*/g, '\n').replace(/[ \t]{2,}/g, ' ').trim();
}

function contentHash(subject: string, html: string, textBody: string, variableSchema: TemplateVariableSchema): string {
  return createHash('sha256').update(JSON.stringify({ format: 'eow-template-content/v1', subject, html, textBody, variableSchema }), 'utf8').digest('hex');
}

@Injectable()
export class TemplatesService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly idempotency: IdempotencyService,
  ) {}

  async list(tenantId: string, query: TemplateListQueryDto): Promise<{ items: TemplateSummaryResponse[] }> {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const templates = await new TemplatesRepository(manager, tenantId).list(query);
      const latestIds = await new TemplateVersionsRepository(manager, tenantId).findLatestIdsByTemplateIds(templates.map((template) => template.id));
      return { items: templates.map((template) => templateSummaryResponse(template, latestIds.get(template.id) ?? null)) };
    });
  }

  async get(tenantId: string, id: string): Promise<TemplateResponse> {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const template = await this.requireActive(manager, tenantId, id);
      const latestIds = await new TemplateVersionsRepository(manager, tenantId).findLatestIdsByTemplateIds([template.id]);
      return templateResponse(template, latestIds.get(template.id) ?? null);
    });
  }

  async create(tenantId: string, body: CreateTemplateDto): Promise<TemplateResponse> {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const sanitized = this.sanitize(body.html);
      try {
        const saved = await new TemplatesRepository(manager, tenantId).save({
          name: body.name.trim(), origin: body.origin, draftSubject: body.subject, draftHtml: sanitized.html,
          draftTextBody: body.textBody || fallbackText(sanitized.html), draftValidationJson: this.validation(sanitized),
        });
        return templateResponse(saved, null);
      } catch (error) { this.throwNameConflict(error); }
    });
  }

  async analyze(tenantId: string, body: TemplateAnalyzeDto): Promise<TemplateAnalysisResponse> {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const sanitized = this.sanitize(body.html);
      const textBody = body.textBody || fallbackText(sanitized.html);
      const tokens = parseTemplateVariableTokens({ subject: body.subject, html: sanitized.html, textBody });
      // Variables and preview run on the fallback, but the lint has to judge what the
      // author actually wrote -- linting the fallback is what made TEXT_BODY_EMPTY
      // unreachable. A caller that sends no textBody at all (the create modal has no
      // such input) is not authoring one, so it is linted on the fallback as before.
      const lintedText = body.textBody ?? textBody;
      const [customFields, configuredVariables, policy] = await Promise.all([
        new CustomFieldsRepository(manager, tenantId).list(),
        body.templateId
          ? new ConfiguredVariablesRepository(manager, tenantId).listForTemplate((await this.requireActive(manager, tenantId, body.templateId)).id)
          : new ConfiguredVariablesRepository(manager, tenantId).listGlobal(),
        new SendingPolicyRepository(manager, tenantId).get(),
      ]);
      const variables = classifyTemplateAnalysisTokens(tokens, customFields, configuredVariables);
      return {
        sanitizedHtml: sanitized.html,
        validation: this.validation(sanitized),
        variables,
        unknownVariables: variables.filter((variable): variable is typeof variable & { classification: 'unknown'; source: 'unknown'; label: null } => variable.classification === 'unknown').map((variable) => ({ ...variable, suggestedActions: ['CREATE_TEMPLATE_VARIABLE', 'RENAME_VARIABLE', 'REMOVE_VARIABLE'] })),
        // ADR-036 scope item 5: the editor's variable panel shows how each date will render.
        catalogue: buildTemplateAnalysisCatalogue(customFields, configuredVariables, { tenantTimezone: policy?.defaultTimezone ?? null }),
        lint: lintTemplateContent({ html: sanitized.html, textBody: lintedText }),
      };
    });
  }

  async update(tenantId: string, id: string, expectedRevision: number, body: UpdateTemplateDto): Promise<TemplateResponse> {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const template = await this.requireActive(manager, tenantId, id, true);
      if (template.draftRevision !== expectedRevision) throw new HttpException('Template has changed. Reload before saving.', 412);
      const sanitized = body.html === undefined ? null : this.sanitize(body.html);
      if (body.name !== undefined) template.name = body.name.trim();
      if (body.subject !== undefined) template.draftSubject = body.subject;
      if (body.projectData !== undefined) template.projectData = body.projectData;
      if (sanitized) {
        template.draftHtml = sanitized.html;
        template.draftValidationJson = this.validation(sanitized);
        if (body.textBody === undefined) template.draftTextBody = fallbackText(sanitized.html);
      }
      if (body.textBody !== undefined) template.draftTextBody = body.textBody;
      template.draftRevision = template.draftRevision + 1;
      try {
        const saved = await new TemplatesRepository(manager, tenantId).save(template);
        const latestIds = await new TemplateVersionsRepository(manager, tenantId).findLatestIdsByTemplateIds([saved.id]);
        return templateResponse(saved, latestIds.get(saved.id) ?? null);
      } catch (error) { this.throwNameConflict(error); }
    });
  }

  async archive(tenantId: string, id: string, actor: TemplateActor): Promise<void> {
    await runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const template = await this.requireActive(manager, tenantId, id, true);
      template.status = 'archived';
      template.deletedAt = new Date();
      await new TemplatesRepository(manager, tenantId).save(template);
      await appendAuditLog(manager, { tenantId, actorId: actor.actorId, action: 'template.archived', entityType: 'email_template', entityId: id, traceId: actor.traceId });
    });
  }

  async publish(tenantId: string, id: string, actor: TemplateActor): Promise<TemplateVersionResponse> {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const template = await this.requireActive(manager, tenantId, id, true);
      if (!template.draftSubject.trim() || !template.draftHtml.trim()) {
        const fieldErrors = [
          ...(!template.draftSubject.trim() ? [{ field: 'subject', code: 'REQUIRED' }] : []),
          ...(!template.draftHtml.trim() ? [{ field: 'html', code: 'REQUIRED' }] : []),
        ];
        throw new UnprocessableEntityException({
          code: 'TEMPLATE_DRAFT_INCOMPLETE',
          message: 'A template subject and sanitized HTML are required before publishing.',
          messageKey: 'template.draftIncomplete',
          nextAction: 'COMPLETE_TEMPLATE_DRAFT',
          fieldErrors,
        });
      }
      const versions = new TemplateVersionsRepository(manager, tenantId);
      const versionNumber = await versions.nextVersion(template.id);
      const textBody = template.draftTextBody || fallbackText(template.draftHtml);
      let variableSchema: TemplateVariableSchema;
      try {
        variableSchema = analyzeTemplateVariables(
          { subject: template.draftSubject, html: template.draftHtml, textBody },
          await new CustomFieldsRepository(manager, tenantId).list(),
          await new ConfiguredVariablesRepository(manager, tenantId).listForTemplate(template.id),
        ).schema;
      } catch (error) {
        if (error instanceof TemplateVariableError) {
          const isUnknown = error.code === 'UNKNOWN_VARIABLE';
          const field = error.details.field ?? 'html';
          throw new UnprocessableEntityException({
            code: error.code,
            message: {
              UNKNOWN_VARIABLE: 'The template references a variable that is not defined for this tenant.',
              MALFORMED_TEMPLATE_SYNTAX: 'A template variable has malformed braces or syntax.',
              UNSAFE_TEMPLATE_EXPRESSION: 'Template variables must be simple keys without helpers, property access, or expressions.',
              DUPLICATE_VARIABLE: 'The tenant variable catalogue contains an ambiguous duplicate key.',
              TEMPLATE_VARIABLE_LIMIT_EXCEEDED: 'A template field contains more variables than the supported limit.',
            }[error.code],
            ...error.details,
            messageKey: `template.${error.code.toLowerCase()}`,
            nextAction: isUnknown || error.code === 'DUPLICATE_VARIABLE' ? 'OPEN_CUSTOM_FIELDS' : 'REPAIR_TEMPLATE_VARIABLES',
            fieldErrors: [{ field, code: error.code, ...(error.details.variableKey ? { value: error.details.variableKey } : {}) }],
          });
        }
        throw error;
      }
      const saved = await versions.save({
        templateId: template.id, version: versionNumber, publishedBy: actor.actorId, subject: template.draftSubject, html: template.draftHtml, textBody,
        requiredVariables: variableSchema.required, variableSchemaJson: variableSchema, contentHash: contentHash(template.draftSubject, template.draftHtml, textBody, variableSchema), publishedAt: new Date(),
      });
      template.status = 'published';
      template.draftRevision = template.draftRevision + 1;
      await new TemplatesRepository(manager, tenantId).save(template);
      await appendAuditLog(manager, { tenantId, actorId: actor.actorId, action: 'template.published', entityType: 'email_template', entityId: template.id, traceId: actor.traceId, metadata: { templateVersionId: saved.id, version: saved.version, contentHash: saved.contentHash } });
      await appendOutboxEvent(manager, { tenantId, eventType: 'template.published', aggregateType: 'email_template', aggregateId: template.id, aggregateVersion: BigInt(saved.version), payload: { templateId: template.id, templateVersionId: saved.id, version: saved.version } });
      return versionResponse(saved);
    });
  }

  async listVersions(tenantId: string, templateId: string): Promise<{ items: TemplateVersionSummary[] }> {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      await this.requireActive(manager, tenantId, templateId);
      const rows = await new TemplateVersionsRepository(manager, tenantId).listMetadataByTemplate(templateId);
      return { items: rows.map((row) => ({ id: row.id, version: row.version, subject: row.subject, contentHash: row.contentHash, publishedAt: row.publishedAt, publishedBy: row.publishedBy })) };
    });
  }

  /**
   * Copies a published version's content back into the draft. The version row
   * itself is never touched -- published versions are immutable (the PATCH and
   * DELETE handlers return 405), so "restore" means the draft catches up to an
   * older version, not that history is rewritten.
   *
   * It goes through the same If-Match gate as any other draft write. Without
   * that it would be the one door into the draft that bypasses the optimistic
   * concurrency the editor relies on, and it is a destructive door: whatever
   * the draft held is replaced.
   */
  async restoreVersion(tenantId: string, templateId: string, versionId: string, expectedRevision: number, actor: TemplateActor): Promise<TemplateResponse> {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const template = await this.requireActive(manager, tenantId, templateId, true);
      if (template.draftRevision !== expectedRevision) throw new HttpException('Template has changed. Reload before saving.', 412);
      const versions = new TemplateVersionsRepository(manager, tenantId);
      const version = await versions.findById(versionId);
      if (!version || version.templateId !== templateId) throw new NotFoundException('Template version not found.');

      template.draftSubject = version.subject;
      template.draftHtml = version.html;
      template.draftTextBody = version.textBody;
      template.draftRevision = template.draftRevision + 1;
      const saved = await new TemplatesRepository(manager, tenantId).save(template);
      await appendAuditLog(manager, {
        tenantId, actorId: actor.actorId, action: 'template.version_restored', entityType: 'email_template', entityId: templateId,
        traceId: actor.traceId, metadata: { templateVersionId: version.id, version: version.version },
      });
      const latestIds = await versions.findLatestIdsByTemplateIds([saved.id]);
      return templateResponse(saved, latestIds.get(saved.id) ?? null);
    });
  }

  async getVersion(tenantId: string, id: string): Promise<TemplateVersionResponse> {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const version = await new TemplateVersionsRepository(manager, tenantId).findById(id);
      if (!version) throw new NotFoundException('Template version not found.');
      return versionResponse(version);
    });
  }

  async preview(tenantId: string, id: string, body: TemplatePreviewDto): Promise<TemplatePreviewResponse> {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const version = await new TemplateVersionsRepository(manager, tenantId).findById(id);
      if (!version) throw new NotFoundException('Template version not found.');
      const configuredOverrides = Object.fromEntries(Object.keys(version.variableSchemaJson.configured ?? {})
        .filter((key) => Object.prototype.hasOwnProperty.call(body.mergeData, key))
        .map((key) => [key, body.mergeData[key]]));
      const configuredValues = await resolveConfiguredVariableValues(manager, tenantId, version.templateId, version.variableSchemaJson, configuredOverrides);
      const rendered = renderTemplateVariables(
        { subject: version.subject, html: version.html, textBody: version.textBody },
        version.variableSchemaJson as TemplateVariableSchema,
        { ...configuredValues, ...body.mergeData },
        // ADR-036: the same render-time formatting the campaign snapshot freeze
        // applies, so this preview predicts the real send rather than guessing.
        { mode: 'preview', formatting: await resolveVariableFormatting(manager, tenantId, version.templateId) },
      );
      if ('code' in rendered) throw new Error('Preview rendering unexpectedly used strict mode.');
      return rendered;
    });
  }

  async previewDraft(tenantId: string, id: string, body: TemplatePreviewDto): Promise<TemplatePreviewResponse> {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const template = await this.requireActive(manager, tenantId, id);
      const textBody = template.draftTextBody || fallbackText(template.draftHtml);
      const [customFields, configuredVariables, policy] = await Promise.all([
        new CustomFieldsRepository(manager, tenantId).list(),
        new ConfiguredVariablesRepository(manager, tenantId).listForTemplate(template.id),
        new SendingPolicyRepository(manager, tenantId).get(),
      ]);
      let schema: TemplateVariableSchema;
      try {
        schema = analyzeTemplateVariables({ subject: template.draftSubject, html: template.draftHtml, textBody }, customFields, configuredVariables).schema;
      } catch (error) {
        if (error instanceof TemplateVariableError) throw new UnprocessableEntityException({ code: error.code, message: 'Repair unknown or unsafe variables before previewing this draft.', ...error.details, nextAction: 'REPAIR_TEMPLATE_VARIABLES' });
        throw error;
      }
      const configuredValues = {
        ...Object.fromEntries(configuredVariables.filter((variable) => variable.scope === 'global').map((variable) => [variable.variableKey, variable.defaultValue])),
        ...Object.fromEntries(Object.entries(schema.defaults ?? {}).filter(([key]) => schema.configured?.[key]?.scope === 'template')),
        ...body.mergeData,
      };
      return renderTemplateVariables(
        { subject: template.draftSubject, html: template.draftHtml, textBody },
        schema,
        configuredValues,
        // ADR-036: same formatting the published-version preview and the send
        // apply, built from the definitions this draft was just analysed against
        // rather than re-read.
        { mode: 'preview', formatting: buildVariableFormatting(customFields, configuredVariables, policy?.defaultTimezone ?? null) },
      );
    });
  }

  async testSend(tenantId: string, id: string, actor: TestSendActor, idempotencyKey: string, body: TemplateTestSendDto): Promise<TemplateTestSendResponse> {
    const reservation = await runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const testSends = new TemplateTestSendsRepository(manager, tenantId);
      const user = await testSends.findActorEmail(actor.actorId ?? '');
      if (!user) throw new NotFoundException('Authenticated user not found.');
      const idempotent = await this.idempotency.run(
        manager,
        tenantId,
        idempotencyKey,
        'template_test_send',
        { templateVersionId: id, recipient: user.email, mergeData: body.mergeData },
        async () => {
          const version = await new TemplateVersionsRepository(manager, tenantId).findById(id);
          if (!version) throw new NotFoundException('Template version not found.');
          const configuredOverrides = Object.fromEntries(Object.keys(version.variableSchemaJson.configured ?? {})
            .filter((key) => Object.prototype.hasOwnProperty.call(body.mergeData, key))
            .map((key) => [key, body.mergeData[key]]));
          const configuredValues = await resolveConfiguredVariableValues(manager, tenantId, version.templateId, version.variableSchemaJson, configuredOverrides);
          const rendered = renderTemplateVariables(
            { subject: version.subject, html: version.html, textBody: version.textBody },
            version.variableSchemaJson as TemplateVariableSchema,
            { ...configuredValues, ...body.mergeData, email: body.mergeData.email ?? user.email },
            { formatting: await resolveVariableFormatting(manager, tenantId, version.templateId) },
          );
          if ('code' in rendered) throw new UnprocessableEntityException({ code: rendered.code, missingKeys: rendered.missingKeys });
          const saved = await testSends.save({
            id: randomUUID(), templateVersionId: id, actorId: actor.actorId ?? '', recipientEmail: user.email, status: 'sending', sentAt: null,
          });
          return { id: saved.id, recipient: saved.recipientEmail };
        },
      );
      return idempotent;
    });

    if (reservation.replayed) {
      const existing = await runInTenantContext(this.dataSource, tenantId, async (manager) => new TemplateTestSendsRepository(manager, tenantId).findById(reservation.value.id));
      if (existing?.status === 'sent') return { ...reservation.value, idempotencyReplayed: true };
      throw new ConflictException('The prior test-send attempt is unresolved; use a new Idempotency-Key after support resolves it.');
    }

    const rendered = await runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const version = await new TemplateVersionsRepository(manager, tenantId).findById(id);
      if (!version) throw new NotFoundException('Template version not found.');
      const configuredOverrides = Object.fromEntries(Object.keys(version.variableSchemaJson.configured ?? {})
        .filter((key) => Object.prototype.hasOwnProperty.call(body.mergeData, key))
        .map((key) => [key, body.mergeData[key]]));
      const configuredValues = await resolveConfiguredVariableValues(manager, tenantId, version.templateId, version.variableSchemaJson, configuredOverrides);
      const strict = renderTemplateVariables(
        { subject: version.subject, html: version.html, textBody: version.textBody },
        version.variableSchemaJson as TemplateVariableSchema,
        { ...configuredValues, ...body.mergeData, email: body.mergeData.email ?? reservation.value.recipient },
        { formatting: await resolveVariableFormatting(manager, tenantId, version.templateId) },
      );
      if ('code' in strict) throw new UnprocessableEntityException({ code: strict.code, missingKeys: strict.missingKeys });
      return strict;
    });

    try {
      await nodemailer.createTransport({
        // Same implicit-TLS rule as SMTP_IMPLICIT_TLS_PORT in
        // sender-config/smtp-provider.adapter.ts: this transport is env-configured
        // rather than sender-configured, but SMTP_PORT=465 hung here identically.
        host: process.env.SMTP_HOST ?? 'mailpit', port: Number(process.env.SMTP_PORT ?? 1025), secure: Number(process.env.SMTP_PORT ?? 1025) === 465,
        connectionTimeout: Number(process.env.SMTP_CONNECTION_TIMEOUT_MS ?? 10_000),
        greetingTimeout: Number(process.env.SMTP_GREETING_TIMEOUT_MS ?? 10_000),
        socketTimeout: Number(process.env.SMTP_SOCKET_TIMEOUT_MS ?? 30_000),
      }).sendMail({
        from: process.env.SMTP_FROM ?? 'no-reply@example.test', to: reservation.value.recipient,
        subject: `[TEST] ${rendered.subject}`, text: rendered.textBody, html: rendered.html,
        headers: { 'X-EOW-Test-Send': 'true' },
      });
    } catch (error) {
      appLogger.error({ test_send_id: reservation.value.id, code: (error as { code?: string }).code ?? 'UNKNOWN' }, 'template.test_send.delivery_failed');
      await this.recordTestSendFailure(tenantId, reservation.value.id);
      throw new ServiceUnavailableException('Test email could not be delivered.');
    }

    await runInTenantContext(this.dataSource, tenantId, async (manager) => {
      await manager.query(
        `UPDATE template_test_send SET status = 'sent', sent_at = now()
         WHERE id = $1 AND tenant_id = $2 AND status = 'sending'`,
        [reservation.value.id, tenantId],
      );
      await appendAuditLog(manager, {
        tenantId, actorId: actor.actorId, action: 'template.test_sent', entityType: 'template_test_send', entityId: reservation.value.id,
        traceId: actor.traceId, metadata: { recipient: reservation.value.recipient, templateVersionId: id, test: true },
      });
    });
    return { ...reservation.value, idempotencyReplayed: false };
  }

  private async recordTestSendFailure(tenantId: string, testSendId: string): Promise<void> {
    try {
      await runInTenantContext(this.dataSource, tenantId, (manager) => manager.query(
        `UPDATE template_test_send SET status = 'failed' WHERE id = $1 AND tenant_id = $2 AND status = 'sending'`,
        [testSendId, tenantId],
      ));
    } catch (error) {
      appLogger.error({ test_send_id: testSendId, code: (error as { code?: string }).code ?? 'UNKNOWN' }, 'template.test_send.failure_recording_failed');
    }
  }
  private async requireActive(manager: EntityManager, tenantId: string, id: string, lock = false): Promise<EmailTemplateEntity> {
    const repository = new TemplatesRepository(manager, tenantId);
    const active = await repository.findActiveById(id, lock);
    if (active) return active;
    const archived = await repository.findById(id);
    if (archived?.deletedAt || archived?.status === 'archived') throw new ConflictException({ code: 'TEMPLATE_ARCHIVED', message: 'Archived templates cannot be changed.' });
    throw new NotFoundException('Template not found.');
  }

  private sanitize(html: string): TemplateSanitizationResult {
    const result = sanitizeTemplateHtml(html);
    if (result.errors.length > 0) throw new UnprocessableEntityException({ code: 'TEMPLATE_SANITIZATION_REJECTED', message: result.errors });
    return result;
  }

  private validation(result: TemplateSanitizationResult): Record<string, unknown> {
    return { warnings: result.warnings, errors: result.errors, changes: result.changes };
  }

  private throwNameConflict(error: unknown): never {
    if ((error as { code?: string }).code === '23505') throw new ConflictException({ code: 'TEMPLATE_NAME_CONFLICT', message: 'A template with this name already exists.' });
    throw error;
  }
}
