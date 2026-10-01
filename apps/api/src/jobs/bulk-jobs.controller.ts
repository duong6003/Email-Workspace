import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post, Req, Res, UnauthorizedException, UseGuards, UsePipes } from '@nestjs/common';
import type { Response } from 'express';
import { CsrfGuard } from '../auth/csrf.guard.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { AuditLog } from '../common/decorators/audit-log.decorator.js';
import { RequirePermission } from '../common/decorators/require-permission.decorator.js';
import { PERMISSIONS } from '../common/permissions.js';
import { getOrCreateTraceId } from '../common/trace-id.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { BulkJobsService } from './bulk-jobs.service.js';
import { bulkJobCreateRequestSchema, type BulkJobCreateRequestDto } from './dto/bulk-job.dto.js';

function requireAuth(req: AuthenticatedRequest): NonNullable<AuthenticatedRequest['auth']> {
  if (!req.auth) throw new UnauthorizedException('Not authenticated.');
  return req.auth;
}

@Controller('bulk-jobs')
export class BulkJobsController {
  constructor(private readonly bulkJobs: BulkJobsService) {}

  @Post()
  @HttpCode(202)
  @UseGuards(CsrfGuard)
  @RequirePermission(PERMISSIONS.RECIPIENT_MANAGE)
  @UsePipes(new ZodValidationPipe(bulkJobCreateRequestSchema))
  @AuditLog({ action: 'bulk-job.created', entityType: 'bulk_job', resolveEntityId: ({ result }) => (result as { jobId?: string } | undefined)?.jobId ?? null })
  async create(@Body() body: BulkJobCreateRequestDto, @Req() req: AuthenticatedRequest) {
    const auth = requireAuth(req);
    const idempotencyKey = req.header('idempotency-key')?.trim();
    if (!idempotencyKey) throw new BadRequestException('Idempotency-Key is required for bulk job creation.');
    return this.bulkJobs.create(auth.tenantId, auth.userId, getOrCreateTraceId(req), idempotencyKey, body);
  }

  @Post('preview')
  @RequirePermission(PERMISSIONS.RECIPIENT_MANAGE)
  @UsePipes(new ZodValidationPipe(bulkJobCreateRequestSchema))
  async preview(@Body() body: BulkJobCreateRequestDto, @Req() req: AuthenticatedRequest) {
    return this.bulkJobs.preview(requireAuth(req).tenantId, body);
  }

  @Get()
  @RequirePermission(PERMISSIONS.RECIPIENT_READ)
  async list(@Req() req: AuthenticatedRequest) {
    return this.bulkJobs.list(requireAuth(req).tenantId);
  }

  @Get(':id/error-file')
  @RequirePermission(PERMISSIONS.RECIPIENT_READ)
  async errorFile(@Param('id') id: string, @Req() req: AuthenticatedRequest, @Res() response: Response): Promise<void> {
    const file = await this.bulkJobs.errorFile(requireAuth(req).tenantId, id);
    response.type('text/csv').attachment(file.fileName).send(file.contents);
  }

  @Get(':id/result-file')
  @RequirePermission(PERMISSIONS.RECIPIENT_READ)
  async resultFile(@Param('id') id: string, @Req() req: AuthenticatedRequest, @Res() response: Response): Promise<void> {
    const file = await this.bulkJobs.resultFile(requireAuth(req).tenantId, id);
    response.type('text/csv').attachment(file.fileName).send(file.contents);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.RECIPIENT_READ)
  async get(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.bulkJobs.get(requireAuth(req).tenantId, id);
  }
}
