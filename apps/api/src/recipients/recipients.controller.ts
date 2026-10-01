import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req, UnauthorizedException, UseGuards, UsePipes } from '@nestjs/common';
import { CsrfGuard } from '../auth/csrf.guard.js';
import { AuditLog } from '../common/decorators/audit-log.decorator.js';
import { RequirePermission } from '../common/decorators/require-permission.decorator.js';
import { PERMISSIONS } from '../common/permissions.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { getOrCreateTraceId } from '../common/trace-id.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { RecipientsService, type ActorContext } from './recipients.service.js';
import {
  recipientCreateRequestSchema,
  recipientListQuerySchema,
  recipientUpdateRequestSchema,
  type RecipientCreateRequestDto,
  type RecipientListQueryDto,
  type RecipientUpdateRequestDto,
} from './dto/recipient.dto.js';
import type { RecipientRecord } from './recipients.service.js';

function toResponse(recipient: RecipientRecord) {
  return {
    id: recipient.id,
    email: recipient.email,
    firstName: recipient.firstName,
    lastName: recipient.lastName,
    phone: recipient.phone,
    department: recipient.department,
    title: recipient.title,
    location: recipient.location,
    subscriptionStatus: recipient.subscriptionStatus,
    customData: recipient.customData,
    unsubscribedAt: recipient.unsubscribedAt ? recipient.unsubscribedAt.toISOString() : null,
    createdAt: recipient.createdAt.toISOString(),
    updatedAt: recipient.updatedAt.toISOString(),
  };
}

/** BR-GEN-002: tenantId is read only from the already-guarded request.auth (set by the global AuthGuard), never from anything the caller passes in. */
function requireTenantId(req: AuthenticatedRequest): string {
  if (!req.auth) throw new UnauthorizedException('Not authenticated.');
  return req.auth.tenantId;
}

/** BR-CF-009: who/what trace to attribute a custom_data value-change audit row to. */
function requireActor(req: AuthenticatedRequest): ActorContext {
  if (!req.auth) throw new UnauthorizedException('Not authenticated.');
  return { actorId: req.auth.userId, traceId: getOrCreateTraceId(req) };
}

@Controller('recipients')
export class RecipientsController {
  constructor(private readonly recipients: RecipientsService) {}

  @Get()
  @RequirePermission(PERMISSIONS.RECIPIENT_READ)
  @UsePipes(new ZodValidationPipe(recipientListQuerySchema))
  async list(@Query() query: RecipientListQueryDto, @Req() req: AuthenticatedRequest) {
    const result = await this.recipients.list(requireTenantId(req), query);
    return {
      items: result.items.map(toResponse),
      nextCursor: result.nextCursor,
      total: result.total,
    };
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.RECIPIENT_READ)
  async getOne(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return toResponse(await this.recipients.getOrThrow(requireTenantId(req), id));
  }

  @Post()
  @UseGuards(CsrfGuard)
  @RequirePermission(PERMISSIONS.RECIPIENT_MANAGE)
  @UsePipes(new ZodValidationPipe(recipientCreateRequestSchema))
  @AuditLog({ action: 'recipient.created', entityType: 'recipient', resolveEntityId: ({ result }) => (result as { id: string } | undefined)?.id ?? null })
  async create(@Body() body: RecipientCreateRequestDto, @Req() req: AuthenticatedRequest) {
    return toResponse(await this.recipients.create(requireTenantId(req), body, requireActor(req)));
  }

  @Patch(':id')
  @UseGuards(CsrfGuard)
  @RequirePermission(PERMISSIONS.RECIPIENT_MANAGE)
  @AuditLog({ action: 'recipient.updated', entityType: 'recipient', resolveEntityId: ({ request }) => (request.params as { id: string }).id })
  async update(@Param('id') id: string, @Body(new ZodValidationPipe(recipientUpdateRequestSchema)) body: RecipientUpdateRequestDto, @Req() req: AuthenticatedRequest) {
    return toResponse(await this.recipients.update(requireTenantId(req), id, body, req.auth?.permissions ?? [], requireActor(req)));
  }

  @Delete(':id')
  @UseGuards(CsrfGuard)
  @RequirePermission(PERMISSIONS.RECIPIENT_MANAGE)
  @HttpCode(204)
  @AuditLog({ action: 'recipient.deleted', entityType: 'recipient', resolveEntityId: ({ request }) => (request.params as { id: string }).id })
  async remove(@Param('id') id: string, @Req() req: AuthenticatedRequest): Promise<void> {
    await this.recipients.remove(requireTenantId(req), id);
  }
}
