import { BadRequestException, Controller, Get, HttpCode, Param, Post, Body, Req, Res, UnauthorizedException, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { CsrfGuard } from '../auth/csrf.guard.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { RequirePermission } from '../common/decorators/require-permission.decorator.js';
import { PERMISSIONS } from '../common/permissions.js';
import { getOrCreateTraceId } from '../common/trace-id.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { CampaignExportsService } from './exports.service.js';
import { createExportSchema, type CreateExportDto } from './dto/export.dto.js';

function tenantId(req: AuthenticatedRequest): string {
  if (!req.auth?.tenantId) throw new UnauthorizedException('Not authenticated.');
  return req.auth.tenantId;
}

function actor(req: AuthenticatedRequest) {
  return { actorId: req.auth?.userId ?? null, traceId: getOrCreateTraceId(req) };
}

/** BR-HIS-003/BR-HIS-007. Nested under /campaigns/:campaignId/exports, gated by history:export (DEC-135). */
@Controller('campaigns/:campaignId/exports')
export class CampaignExportsController {
  constructor(private readonly exports: CampaignExportsService) {}

  @Post() @HttpCode(202) @UseGuards(CsrfGuard) @RequirePermission(PERMISSIONS.HISTORY_EXPORT)
  async create(
    @Param('campaignId') campaignId: string,
    @Body(new ZodValidationPipe(createExportSchema)) body: CreateExportDto,
    @Req() req: AuthenticatedRequest,
  ) {
    if (!req.header('idempotency-key')?.trim()) throw new BadRequestException('Idempotency-Key is required to create an export.');
    return this.exports.create(tenantId(req), campaignId, req.auth?.userId ?? null, body);
  }

  @Get(':exportId') @RequirePermission(PERMISSIONS.HISTORY_EXPORT)
  async get(@Param('campaignId') campaignId: string, @Param('exportId') exportId: string, @Req() req: AuthenticatedRequest) {
    return this.exports.get(tenantId(req), campaignId, exportId);
  }

  @Get(':exportId/file') @RequirePermission(PERMISSIONS.HISTORY_EXPORT)
  async file(@Param('campaignId') campaignId: string, @Param('exportId') exportId: string, @Req() req: AuthenticatedRequest, @Res() response: Response): Promise<void> {
    const file = await this.exports.download(tenantId(req), campaignId, exportId, actor(req));
    response.type('text/csv').attachment(file.fileName).send(file.contents);
  }
}
