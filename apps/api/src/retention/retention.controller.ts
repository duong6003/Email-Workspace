import { Body, Controller, Get, Put, Req, UseGuards } from '@nestjs/common';
import { CsrfGuard } from '../auth/csrf.guard.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { RequirePermission } from '../common/decorators/require-permission.decorator.js';
import { PERMISSIONS } from '../common/permissions.js';
import { getOrCreateTraceId } from '../common/trace-id.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { retentionPolicySchema, type RetentionPolicyDto } from './dto/retention.dto.js';
import { RetentionService } from './retention.service.js';

function auth(req: AuthenticatedRequest) {
  if (!req.auth) throw new Error('Not authenticated.');
  return { tenantId: req.auth.tenantId, actorId: req.auth.userId, traceId: getOrCreateTraceId(req) };
}

@Controller()
export class RetentionController {
  constructor(private readonly service: RetentionService) {}

  @Get('retention-policy') @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  get(@Req() req: AuthenticatedRequest) { return this.service.getPolicy(auth(req).tenantId); }

  @Put('retention-policy') @UseGuards(CsrfGuard) @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  put(@Body(new ZodValidationPipe(retentionPolicySchema)) body: RetentionPolicyDto, @Req() req: AuthenticatedRequest) {
    const a = auth(req);
    return this.service.putPolicy(a.tenantId, body, a);
  }
}
