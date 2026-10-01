import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { CsrfGuard } from '../auth/csrf.guard.js';
import { AuditLog } from '../common/decorators/audit-log.decorator.js';
import { RequirePermission } from '../common/decorators/require-permission.decorator.js';
import { PERMISSIONS } from '../common/permissions.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ConfiguredVariablesService } from './configured-variables.service.js';
import { createGlobalVariableSchema, createTemplateVariableSchema, updateGlobalVariableSchema, updateTemplateVariableSchema, type CreateGlobalVariableDto, type CreateTemplateVariableDto, type UpdateGlobalVariableDto, type UpdateTemplateVariableDto } from './dto/configured-variable.dto.js';

function tenantId(request: AuthenticatedRequest): string {
  if (!request.auth) throw new UnauthorizedException('Not authenticated.');
  return request.auth.tenantId;
}

function requestParam(request: AuthenticatedRequest, key: string): string | null {
  const value = request.params[key];
  return typeof value === 'string' ? value : null;
}

@Controller()
export class ConfiguredVariablesController {
  constructor(private readonly variables: ConfiguredVariablesService) {}

  @Get('global-variables') @RequirePermission(PERMISSIONS.CONTENT_MANAGE)
  async listGlobal(@Req() request: AuthenticatedRequest) { return { items: await this.variables.listGlobal(tenantId(request)) }; }

  @Post('global-variables') @UseGuards(CsrfGuard) @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  @AuditLog({ action: 'configured-variable.global-created', entityType: 'configured_variable', resolveEntityId: ({ result }) => (result as { id?: string } | undefined)?.id ?? null })
  createGlobal(@Body(new ZodValidationPipe(createGlobalVariableSchema)) body: CreateGlobalVariableDto, @Req() request: AuthenticatedRequest) { return this.variables.createGlobal(tenantId(request), body); }

  @Patch('global-variables/:id') @UseGuards(CsrfGuard) @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  @AuditLog({ action: 'configured-variable.global-updated', entityType: 'configured_variable', resolveEntityId: ({ request }) => requestParam(request, 'id') })
  updateGlobal(@Param('id') id: string, @Body(new ZodValidationPipe(updateGlobalVariableSchema)) body: UpdateGlobalVariableDto, @Req() request: AuthenticatedRequest) { return this.variables.updateGlobal(tenantId(request), id, body); }

  @Delete('global-variables/:id') @HttpCode(204) @UseGuards(CsrfGuard) @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  @AuditLog({ action: 'configured-variable.global-deleted', entityType: 'configured_variable', resolveEntityId: ({ request }) => requestParam(request, 'id') })
  removeGlobal(@Param('id') id: string, @Req() request: AuthenticatedRequest) { return this.variables.remove(tenantId(request), id, 'global'); }

  // Listing a template's own variables is part of rendering that template
  // read-only, so it takes CONTENT_READ too (073_content_read_permission.sql).
  // Creating, editing and deleting them below stay CONTENT_MANAGE-only.
  @Get('templates/:templateId/variables') @RequirePermission(PERMISSIONS.CONTENT_READ, PERMISSIONS.CONTENT_MANAGE)
  async listTemplate(@Param('templateId') templateId: string, @Req() request: AuthenticatedRequest) { return { items: await this.variables.listTemplate(tenantId(request), templateId) }; }

  @Post('templates/:templateId/variables') @UseGuards(CsrfGuard) @RequirePermission(PERMISSIONS.CONTENT_MANAGE)
  @AuditLog({ action: 'configured-variable.template-created', entityType: 'configured_variable', resolveEntityId: ({ result }) => (result as { id?: string } | undefined)?.id ?? null })
  createTemplate(@Param('templateId') templateId: string, @Body(new ZodValidationPipe(createTemplateVariableSchema)) body: CreateTemplateVariableDto, @Req() request: AuthenticatedRequest) { return this.variables.createTemplate(tenantId(request), templateId, body); }

  @Patch('template-variables/:id') @UseGuards(CsrfGuard) @RequirePermission(PERMISSIONS.CONTENT_MANAGE)
  @AuditLog({ action: 'configured-variable.template-updated', entityType: 'configured_variable', resolveEntityId: ({ request }) => requestParam(request, 'id') })
  updateTemplate(@Param('id') id: string, @Body(new ZodValidationPipe(updateTemplateVariableSchema)) body: UpdateTemplateVariableDto, @Req() request: AuthenticatedRequest) { return this.variables.updateTemplate(tenantId(request), id, body); }

  @Delete('template-variables/:id') @HttpCode(204) @UseGuards(CsrfGuard) @RequirePermission(PERMISSIONS.CONTENT_MANAGE)
  @AuditLog({ action: 'configured-variable.template-deleted', entityType: 'configured_variable', resolveEntityId: ({ request }) => requestParam(request, 'id') })
  removeTemplate(@Param('id') id: string, @Req() request: AuthenticatedRequest) { return this.variables.remove(tenantId(request), id, 'template'); }
}
