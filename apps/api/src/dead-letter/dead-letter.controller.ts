import { BadRequestException, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { CsrfGuard } from '../auth/csrf.guard.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { AuditLog } from '../common/decorators/audit-log.decorator.js';
import { RequirePermission } from '../common/decorators/require-permission.decorator.js';
import { PERMISSIONS } from '../common/permissions.js';
import { getOrCreateTraceId } from '../common/trace-id.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { DeadLetterService } from './dead-letter.service.js';
import { deadLetterListQuerySchema, type DeadLetterListQueryDto } from './dto/dead-letter.dto.js';

function auth(request: AuthenticatedRequest) {
  if (!request.auth) throw new Error('Not authenticated.');
  return { tenantId: request.auth.tenantId, actorId: request.auth.userId, traceId: getOrCreateTraceId(request) };
}

@Controller('dead-letter-events')
export class DeadLetterController {
  constructor(private readonly service: DeadLetterService) {}

  @Get()
  @RequirePermission(PERMISSIONS.DLQ_MANAGE)
  list(@Query(new ZodValidationPipe(deadLetterListQuerySchema)) query: DeadLetterListQueryDto, @Req() request: AuthenticatedRequest) {
    return this.service.list(auth(request).tenantId, query);
  }

  @Get(':deadLetterEventId')
  @RequirePermission(PERMISSIONS.DLQ_MANAGE)
  get(@Param('deadLetterEventId', new ParseUUIDPipe()) id: string, @Req() request: AuthenticatedRequest) {
    return this.service.get(auth(request).tenantId, id);
  }

  @Post(':deadLetterEventId/replay')
  @HttpCode(202)
  @UseGuards(CsrfGuard)
  @RequirePermission(PERMISSIONS.DLQ_MANAGE)
  @AuditLog({ action: 'dead_letter.replayed', entityType: 'dead_letter_event', resolveEntityId: ({ request }) => String(request.params.deadLetterEventId) })
  replay(
    @Param('deadLetterEventId', new ParseUUIDPipe()) id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    if (!idempotencyKey?.trim()) throw new BadRequestException('Idempotency-Key is required to replay a dead-letter event.');
    const actor = auth(request);
    return this.service.replay(actor.tenantId, id, idempotencyKey.trim(), actor);
  }
}
