import { BadRequestException, Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { CsrfGuard } from '../auth/csrf.guard.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { AuditLog } from '../common/decorators/audit-log.decorator.js';
import { RequirePermission } from '../common/decorators/require-permission.decorator.js';
import { PERMISSIONS } from '../common/permissions.js';
import { getOrCreateTraceId } from '../common/trace-id.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { createSenderSchema, policySchema, updateSenderSchema, type CreateSenderDto, type PolicyDto, type UpdateSenderDto } from './dto/sender-config.dto.js';
import { SenderConfigService } from './sender-config.service.js';
function auth(req: AuthenticatedRequest) { if (!req.auth) throw new Error('Not authenticated.'); return { tenantId: req.auth.tenantId, actorId: req.auth.userId, traceId: getOrCreateTraceId(req) }; }
@Controller()
export class SenderConfigController {
  constructor(private readonly service: SenderConfigService) {}
  @Get('sender-configs') @RequirePermission(PERMISSIONS.SETTINGS_MANAGE, PERMISSIONS.CONTENT_MANAGE) list(@Query('usable') usable: string | undefined, @Req() req: AuthenticatedRequest) {
    const current = auth(req);
    const canManage = req.auth?.permissions.includes(PERMISSIONS.SETTINGS_MANAGE) ?? false;
    if (!canManage && usable !== 'true') throw new BadRequestException({ code: 'USABLE_SENDERS_ONLY', message: 'Content users may list verified senders only.' });
    return this.service.list(current.tenantId, !canManage || usable === 'true');
  }
  @Post('sender-configs') @UseGuards(CsrfGuard) @RequirePermission(PERMISSIONS.SETTINGS_MANAGE) @AuditLog({ action: 'sender_config.created', entityType: 'sender_config', resolveEntityId: ({ result }) => (result as { id?: string })?.id ?? null }) create(@Body(new ZodValidationPipe(createSenderSchema)) body: CreateSenderDto, @Req() req: AuthenticatedRequest) { const a = auth(req); return this.service.create(a.tenantId, body, a); }
  @Get('sender-configs/:id') @RequirePermission(PERMISSIONS.SETTINGS_MANAGE) get(@Param('id') id: string, @Req() req: AuthenticatedRequest) { return this.service.get(auth(req).tenantId, id); }
  @Patch('sender-configs/:id') @UseGuards(CsrfGuard) @RequirePermission(PERMISSIONS.SETTINGS_MANAGE) update(@Param('id') id: string, @Body(new ZodValidationPipe(updateSenderSchema)) body: UpdateSenderDto, @Req() req: AuthenticatedRequest) { const a = auth(req); return this.service.update(a.tenantId, id, body, a); }
  @Delete('sender-configs/:id') @HttpCode(204) @UseGuards(CsrfGuard) @RequirePermission(PERMISSIONS.SETTINGS_MANAGE) disable(@Param('id') id: string, @Req() req: AuthenticatedRequest) { const a = auth(req); return this.service.disable(a.tenantId, id, a); }
  @Post('sender-configs/:id/test-connection') @UseGuards(CsrfGuard) @RequirePermission(PERMISSIONS.SETTINGS_MANAGE) test(@Param('id') id: string, @Headers('idempotency-key') key: string | undefined, @Body() body: { secret?: string }, @Req() req: AuthenticatedRequest) { if (!key?.trim()) throw new BadRequestException('Idempotency-Key is required for connection test.'); const a = auth(req); return this.service.testConnection(a.tenantId, id, body?.secret, a, key.trim()); }
  @Get('sending-policy') @RequirePermission(PERMISSIONS.SETTINGS_MANAGE) getPolicy(@Req() req: AuthenticatedRequest) { return this.service.getPolicy(auth(req).tenantId); }
  @Put('sending-policy') @UseGuards(CsrfGuard) @RequirePermission(PERMISSIONS.SETTINGS_MANAGE) putPolicy(@Body(new ZodValidationPipe(policySchema)) body: PolicyDto, @Req() req: AuthenticatedRequest) { const a = auth(req); return this.service.putPolicy(a.tenantId, body, a); }
}
