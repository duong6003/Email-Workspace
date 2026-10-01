import { Body, Controller, Get, Put, Req, UseGuards } from '@nestjs/common';
import { CsrfGuard } from '../auth/csrf.guard.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { AuditLog } from '../common/decorators/audit-log.decorator.js';
import { RequirePermission } from '../common/decorators/require-permission.decorator.js';
import { PERMISSIONS } from '../common/permissions.js';
import { getOrCreateTraceId } from '../common/trace-id.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { quotaSchema, type QuotaUpdate } from './dto/quota.dto.js';
import { QuotaService } from './quota.service.js';

function auth(request: AuthenticatedRequest) {
  if (!request.auth) throw new Error('Not authenticated.');
  return { tenantId: request.auth.tenantId, actorId: request.auth.userId, traceId: getOrCreateTraceId(request) };
}

@Controller()
export class QuotaController {
  constructor(private readonly quota: QuotaService) {}

  @Get('sending-quota')
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  get(@Req() request: AuthenticatedRequest) { return this.quota.configFor(auth(request).tenantId); }

  @Put('sending-quota')
  @UseGuards(CsrfGuard)
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  @AuditLog({ action: 'sending_quota.updated', entityType: 'sending_policy' })
  put(@Req() request: AuthenticatedRequest, @Body(new ZodValidationPipe(quotaSchema)) body: QuotaUpdate) {
    const actor = auth(request);
    return this.quota.updateConfig(actor.tenantId, body, actor);
  }

  @Get('sending-quota/usage')
  @RequirePermission(PERMISSIONS.CAMPAIGN_READ)
  usage(@Req() request: AuthenticatedRequest) { return this.quota.usageFor(auth(request).tenantId); }
}
