import { BadRequestException, Body, Controller, Delete, Get, Headers, HttpCode, HttpException, MethodNotAllowedException, Param, Patch, Post, Query, Req, Res, UnauthorizedException, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { CsrfGuard } from '../auth/csrf.guard.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { RequirePermission } from '../common/decorators/require-permission.decorator.js';
import { AuditLog } from '../common/decorators/audit-log.decorator.js';
import { PERMISSIONS } from '../common/permissions.js';
import { getOrCreateTraceId } from '../common/trace-id.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { createTemplateSchema, templateAnalyzeSchema, templateListQuerySchema, templatePreviewSchema, templateTestSendSchema, type CreateTemplateDto, type TemplateAnalyzeDto, type TemplateListQueryDto, type TemplatePreviewDto, type TemplateTestSendDto, type UpdateTemplateDto, updateTemplateSchema } from './dto/template.dto.js';
import { TemplatesService } from './templates.service.js';

function tenantId(req: AuthenticatedRequest): string {
  if (!req.auth?.tenantId) throw new UnauthorizedException('Not authenticated.');
  return req.auth.tenantId;
}

function actor(req: AuthenticatedRequest) {
  if (!req.auth?.userId) throw new UnauthorizedException('Not authenticated.');
  return { actorId: req.auth.userId, traceId: getOrCreateTraceId(req) };
}

function expectedRevision(ifMatch: string | undefined): number {
  if (!ifMatch?.trim()) throw new HttpException('If-Match is required.', 428);
  const match = /^"?(\d+)"?$/.exec(ifMatch.trim());
  if (!match) throw new HttpException('If-Match must be a strong template draft-revision ETag.', 400);
  return Number(match[1]);
}

function setEtag(response: Response, revision: number): void {
  response.setHeader('ETag', `"${revision}"`);
}

/**
 * Reading a template never required the right to change it, but until
 * 073_content_read_permission.sql there was no key that said so. Every route
 * below that only reads accepts either key; every route that writes keeps
 * requiring CONTENT_MANAGE alone, so a CONTENT_READ-only caller is 403'd by
 * the server no matter what the client renders (BR-AUTH-004).
 */
const CONTENT_VIEW = [PERMISSIONS.CONTENT_READ, PERMISSIONS.CONTENT_MANAGE] as const;

@Controller()
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  @Get('templates')
  @RequirePermission(...CONTENT_VIEW)
  list(@Query(new ZodValidationPipe(templateListQuerySchema)) query: TemplateListQueryDto, @Req() req: AuthenticatedRequest) { return this.templates.list(tenantId(req), query); }

  @Post('templates')
  @UseGuards(CsrfGuard)
  @RequirePermission(PERMISSIONS.CONTENT_MANAGE)
  @AuditLog({ action: 'template.created', entityType: 'email_template', resolveEntityId: ({ result }) => (result as { id?: string } | undefined)?.id ?? null })
  async create(@Body(new ZodValidationPipe(createTemplateSchema)) body: CreateTemplateDto, @Req() req: AuthenticatedRequest, @Res({ passthrough: true }) res: Response) {
    const template = await this.templates.create(tenantId(req), body);
    setEtag(res, template.draftRevision);
    return template;
  }

  @Post('templates/analyze')
  @UseGuards(CsrfGuard)
  @RequirePermission(...CONTENT_VIEW)
  analyze(@Body(new ZodValidationPipe(templateAnalyzeSchema)) body: TemplateAnalyzeDto, @Req() req: AuthenticatedRequest) { return this.templates.analyze(tenantId(req), body); }

  @Get('templates/:id')
  @RequirePermission(...CONTENT_VIEW)
  async get(@Param('id') id: string, @Req() req: AuthenticatedRequest, @Res({ passthrough: true }) res: Response) {
    const template = await this.templates.get(tenantId(req), id);
    setEtag(res, template.draftRevision);
    return template;
  }

  @Patch('templates/:id')
  @UseGuards(CsrfGuard)
  @RequirePermission(PERMISSIONS.CONTENT_MANAGE)
  @AuditLog({ action: 'template.updated', entityType: 'email_template', resolveEntityId: ({ request }) => (request.params as { id: string }).id })
  async update(@Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Body(new ZodValidationPipe(updateTemplateSchema)) body: UpdateTemplateDto, @Req() req: AuthenticatedRequest, @Res({ passthrough: true }) res: Response) {
    const template = await this.templates.update(tenantId(req), id, expectedRevision(ifMatch), body);
    setEtag(res, template.draftRevision);
    return template;
  }

  @Delete('templates/:id')
  @HttpCode(204)
  @UseGuards(CsrfGuard)
  @RequirePermission(PERMISSIONS.CONTENT_MANAGE)
  async archive(@Param('id') id: string, @Req() req: AuthenticatedRequest): Promise<void> { await this.templates.archive(tenantId(req), id, actor(req)); }

  @Get('templates/:id/versions')
  @RequirePermission(...CONTENT_VIEW)
  listVersions(@Param('id') id: string, @Req() req: AuthenticatedRequest) { return this.templates.listVersions(tenantId(req), id); }

  // 200, not Nest's default 201: a restore updates the existing draft, it does
  // not create a resource. `publish` keeps 201 because it does create a version.
  @Post('templates/:id/versions/:versionId/restore')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @RequirePermission(PERMISSIONS.CONTENT_MANAGE)
  @AuditLog({ action: 'template.version_restored', entityType: 'email_template', resolveEntityId: ({ request }) => (request.params as { id: string }).id })
  async restoreVersion(
    @Param('id') id: string,
    @Param('versionId') versionId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const template = await this.templates.restoreVersion(tenantId(req), id, versionId, expectedRevision(ifMatch), actor(req));
    setEtag(res, template.draftRevision);
    return template;
  }

  @Post('templates/:id/publish')
  @UseGuards(CsrfGuard)
  @RequirePermission(PERMISSIONS.CONTENT_MANAGE)
  publish(@Param('id') id: string, @Req() req: AuthenticatedRequest) { return this.templates.publish(tenantId(req), id, actor(req)); }

  @Post('templates/:id/preview')
  @UseGuards(CsrfGuard)
  @RequirePermission(...CONTENT_VIEW)
  previewDraft(@Param('id') id: string, @Body(new ZodValidationPipe(templatePreviewSchema)) body: TemplatePreviewDto, @Req() req: AuthenticatedRequest) { return this.templates.previewDraft(tenantId(req), id, body); }

  @Get('template-versions/:id')
  @RequirePermission(...CONTENT_VIEW)
  getVersion(@Param('id') id: string, @Req() req: AuthenticatedRequest) { return this.templates.getVersion(tenantId(req), id); }

  @Post('template-versions/:id/preview')
  @UseGuards(CsrfGuard)
  @RequirePermission(...CONTENT_VIEW)
  preview(@Param('id') id: string, @Body(new ZodValidationPipe(templatePreviewSchema)) body: TemplatePreviewDto, @Req() req: AuthenticatedRequest) {
    return this.templates.preview(tenantId(req), id, body);
  }

  @Post('template-versions/:id/test-send')
  @UseGuards(CsrfGuard)
  @RequirePermission(PERMISSIONS.CONTENT_MANAGE)
  testSend(
    @Param('id') id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(templateTestSendSchema)) body: TemplateTestSendDto,
    @Req() req: AuthenticatedRequest,
  ) {
    if (!idempotencyKey?.trim()) throw new BadRequestException('Idempotency-Key is required for test send.');
    return this.templates.testSend(tenantId(req), id, actor(req), idempotencyKey.trim(), body);
  }

  @Patch('template-versions/:id')
  @UseGuards(CsrfGuard)
  @RequirePermission(PERMISSIONS.CONTENT_MANAGE)
  immutableVersion(): never { throw new MethodNotAllowedException('Published template versions are immutable.'); }

  @Delete('template-versions/:id')
  @UseGuards(CsrfGuard)
  @RequirePermission(PERMISSIONS.CONTENT_MANAGE)
  immutableVersionDelete(): never { throw new MethodNotAllowedException('Published template versions are immutable.'); }
}
