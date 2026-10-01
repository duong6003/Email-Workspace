import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req, UnauthorizedException, UseGuards, UsePipes } from '@nestjs/common';
import { CsrfGuard } from '../auth/csrf.guard.js';
import { AuditLog } from '../common/decorators/audit-log.decorator.js';
import { RequirePermission } from '../common/decorators/require-permission.decorator.js';
import { PERMISSIONS } from '../common/permissions.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { CustomFieldsService } from './custom-fields.service.js';
import {
  customFieldCreateRequestSchema,
  customFieldUpdateRequestSchema,
  type CustomFieldCreateRequestDto,
  type CustomFieldUpdateRequestDto,
} from './dto/custom-field.dto.js';
import type { CustomFieldRecord } from './custom-fields.service.js';

function toResponse(field: CustomFieldRecord) {
  return {
    id: field.id,
    key: field.fieldKey,
    label: field.label,
    type: field.dataType,
    required: field.required,
    defaultValue: field.defaultValue ?? null,
    enumOptions: field.enumOptions ?? null,
    sensitive: field.sensitive,
    // ADR-036: both null means "product default pattern, tenant default zone".
    format: field.format ?? null,
    timezone: field.timezone ?? null,
    createdAt: field.createdAt.toISOString(),
    updatedAt: field.updatedAt.toISOString(),
  };
}

/** BR-GEN-002: tenantId is read only from the already-guarded request.auth, never from anything the caller passes in. */
function requireTenantId(req: AuthenticatedRequest): string {
  if (!req.auth) throw new UnauthorizedException('Not authenticated.');
  return req.auth.tenantId;
}

/**
 * Reads use recipient:read (the field schema must be visible wherever
 * recipient data is entered, not only to admins -- the recipient
 * add/edit form and the future M4 compose variable panel both need it).
 * Mutations use settings:manage (admin-only schema-defining action, same
 * granularity that permission already covers for sender configuration).
 */
@Controller('custom-fields')
export class CustomFieldsController {
  constructor(private readonly customFields: CustomFieldsService) {}

  @Get()
  @RequirePermission(PERMISSIONS.RECIPIENT_READ)
  async list(@Req() req: AuthenticatedRequest) {
    const items = await this.customFields.list(requireTenantId(req));
    return { items: items.map(toResponse) };
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.RECIPIENT_READ)
  async getOne(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return toResponse(await this.customFields.getOrThrow(requireTenantId(req), id));
  }

  @Post()
  @UseGuards(CsrfGuard)
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  @UsePipes(new ZodValidationPipe(customFieldCreateRequestSchema))
  @AuditLog({ action: 'custom-field.created', entityType: 'custom_field_definition', resolveEntityId: ({ result }) => (result as { id: string } | undefined)?.id ?? null })
  async create(@Body() body: CustomFieldCreateRequestDto, @Req() req: AuthenticatedRequest) {
    return toResponse(await this.customFields.create(requireTenantId(req), body));
  }

  @Patch(':id')
  @UseGuards(CsrfGuard)
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  @AuditLog({ action: 'custom-field.updated', entityType: 'custom_field_definition', resolveEntityId: ({ request }) => (request.params as { id: string }).id })
  async update(@Param('id') id: string, @Body(new ZodValidationPipe(customFieldUpdateRequestSchema)) body: CustomFieldUpdateRequestDto, @Req() req: AuthenticatedRequest) {
    return toResponse(await this.customFields.update(requireTenantId(req), id, body));
  }

  @Delete(':id')
  @UseGuards(CsrfGuard)
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  @HttpCode(204)
  @AuditLog({ action: 'custom-field.deleted', entityType: 'custom_field_definition', resolveEntityId: ({ request }) => (request.params as { id: string }).id })
  async remove(@Param('id') id: string, @Req() req: AuthenticatedRequest): Promise<void> {
    await this.customFields.remove(requireTenantId(req), id);
  }
}
