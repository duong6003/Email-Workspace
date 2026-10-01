import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post, Req, Res, UnauthorizedException, UseGuards, UsePipes } from '@nestjs/common';
import type { Response } from 'express';
import { CsrfGuard } from '../auth/csrf.guard.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { AuditLog } from '../common/decorators/audit-log.decorator.js';
import { RequirePermission } from '../common/decorators/require-permission.decorator.js';
import { PERMISSIONS } from '../common/permissions.js';
import { getOrCreateTraceId } from '../common/trace-id.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ImportJobsService } from './import-jobs.service.js';
import { importJobCreateRequestSchema, type ImportJobCreateRequestDto } from './dto/job.dto.js';

function requireAuth(req: AuthenticatedRequest): NonNullable<AuthenticatedRequest['auth']> {
  if (!req.auth) throw new UnauthorizedException('Not authenticated.');
  return req.auth;
}

@Controller('import-jobs')
export class JobsController {
  constructor(private readonly importJobs: ImportJobsService) {}

  @Post('preview')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @RequirePermission(PERMISSIONS.RECIPIENT_MANAGE)
  @UsePipes(new ZodValidationPipe(importJobCreateRequestSchema))
  async preview(@Body() body: ImportJobCreateRequestDto, @Req() req: AuthenticatedRequest) {
    return this.importJobs.preview(requireAuth(req).tenantId, body);
  }

  @Post()
  @HttpCode(202)
  @UseGuards(CsrfGuard)
  @RequirePermission(PERMISSIONS.RECIPIENT_MANAGE)
  @UsePipes(new ZodValidationPipe(importJobCreateRequestSchema))
  @AuditLog({ action: 'import-job.created', entityType: 'import_job', resolveEntityId: ({ result }) => (result as { jobId?: string } | undefined)?.jobId ?? null })
  async create(@Body() body: ImportJobCreateRequestDto, @Req() req: AuthenticatedRequest) {
    const auth = requireAuth(req);
    const idempotencyKey = req.header('idempotency-key')?.trim();
    if (!idempotencyKey) throw new BadRequestException('Idempotency-Key is required for import job creation.');
    const result = await this.importJobs.create(auth.tenantId, auth.userId, getOrCreateTraceId(req), idempotencyKey, body);
    return result;
  }

  @Get()
  @RequirePermission(PERMISSIONS.RECIPIENT_READ)
  async list(@Req() req: AuthenticatedRequest) {
    return this.importJobs.list(requireAuth(req).tenantId);
  }

  @Get(':id/error-file')
  @RequirePermission(PERMISSIONS.RECIPIENT_READ)
  async errorFile(@Param('id') id: string, @Req() req: AuthenticatedRequest, @Res() response: Response): Promise<void> {
    const file = await this.importJobs.errorFile(requireAuth(req).tenantId, id);
    response.type('text/csv').attachment(file.fileName).send(file.contents);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.RECIPIENT_READ)
  async get(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.importJobs.get(requireAuth(req).tenantId, id);
  }
}
