import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req, UnauthorizedException, UseGuards, UsePipes } from '@nestjs/common';
import { CsrfGuard } from '../auth/csrf.guard.js';
import { AuditLog } from '../common/decorators/audit-log.decorator.js';
import { RequirePermission } from '../common/decorators/require-permission.decorator.js';
import { PERMISSIONS } from '../common/permissions.js';
import { getOrCreateTraceId } from '../common/trace-id.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { SegmentsService } from './segments.service.js';
import { createRecipientListSchema, createTagSchema, segmentListQuerySchema, segmentMembersSchema, type CreateRecipientListDto, type CreateTagDto, type SegmentListQueryDto, type SegmentMembersDto, type UpdateRecipientListDto, type UpdateTagDto, updateRecipientListSchema, updateTagSchema } from './dto/segment.dto.js';

function tenantId(req: AuthenticatedRequest): string {
  if (!req.auth?.tenantId) throw new UnauthorizedException('Not authenticated.');
  return req.auth.tenantId;
}

function actor(req: AuthenticatedRequest) {
  if (!req.auth?.userId) throw new UnauthorizedException('Not authenticated.');
  return { actorId: req.auth.userId, traceId: getOrCreateTraceId(req) };
}

@Controller()
export class SegmentsController {
  constructor(private readonly segments: SegmentsService) {}

  @Get('recipient-lists')
  @RequirePermission(PERMISSIONS.RECIPIENT_READ)
  @UsePipes(new ZodValidationPipe(segmentListQuerySchema))
  listLists(@Query() query: SegmentListQueryDto, @Req() req: AuthenticatedRequest) {
    return this.segments.listLists(tenantId(req), query);
  }

  @Post('recipient-lists')
  @UseGuards(CsrfGuard)
  @RequirePermission(PERMISSIONS.RECIPIENT_MANAGE)
  @UsePipes(new ZodValidationPipe(createRecipientListSchema))
  @AuditLog({ action: 'recipient_list.created', entityType: 'recipient_list', resolveEntityId: ({ result }) => (result as { id?: string } | undefined)?.id ?? null })
  createList(@Body() body: CreateRecipientListDto, @Req() req: AuthenticatedRequest) {
    return this.segments.createList(tenantId(req), body);
  }

  @Get('recipient-lists/:id')
  @RequirePermission(PERMISSIONS.RECIPIENT_READ)
  getList(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.segments.getList(tenantId(req), id);
  }

  @Get('recipients/:id/segments')
  @RequirePermission(PERMISSIONS.RECIPIENT_READ)
  getRecipientSegments(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.segments.recipientSegments(tenantId(req), id);
  }

  @Patch('recipient-lists/:id')
  @UseGuards(CsrfGuard)
  @RequirePermission(PERMISSIONS.RECIPIENT_MANAGE)
  @AuditLog({ action: 'recipient_list.updated', entityType: 'recipient_list', resolveEntityId: ({ request }) => (request.params as { id: string }).id })
  updateList(@Param('id') id: string, @Body(new ZodValidationPipe(updateRecipientListSchema)) body: UpdateRecipientListDto, @Req() req: AuthenticatedRequest) {
    return this.segments.updateList(tenantId(req), id, body);
  }

  @Post('recipient-lists/:id/members')
  @UseGuards(CsrfGuard)
  @RequirePermission(PERMISSIONS.RECIPIENT_MANAGE)
  @AuditLog({ action: 'recipient_list.members_added', entityType: 'recipient_list', resolveEntityId: ({ request }) => (request.params as { id: string }).id })
  async addListMembers(@Param('id') id: string, @Body(new ZodValidationPipe(segmentMembersSchema)) body: SegmentMembersDto, @Req() req: AuthenticatedRequest) {
    await this.segments.addListMembers(tenantId(req), id, body.recipientIds);
  }

  @Delete('recipient-lists/:id/members')
  @UseGuards(CsrfGuard)
  @RequirePermission(PERMISSIONS.RECIPIENT_MANAGE)
  @HttpCode(204)
  @AuditLog({ action: 'recipient_list.members_removed', entityType: 'recipient_list', resolveEntityId: ({ request }) => (request.params as { id: string }).id })
  async removeListMembers(@Param('id') id: string, @Body(new ZodValidationPipe(segmentMembersSchema)) body: SegmentMembersDto, @Req() req: AuthenticatedRequest): Promise<void> {
    await this.segments.removeListMembers(tenantId(req), id, body.recipientIds);
  }

  @Delete('recipient-lists/:id')
  @UseGuards(CsrfGuard)
  @RequirePermission(PERMISSIONS.RECIPIENT_MANAGE)
  @HttpCode(204)
  async removeList(@Param('id') id: string, @Req() req: AuthenticatedRequest): Promise<void> {
    await this.segments.removeList(tenantId(req), id, actor(req));
  }

  @Get('tags')
  @RequirePermission(PERMISSIONS.RECIPIENT_READ)
  @UsePipes(new ZodValidationPipe(segmentListQuerySchema))
  listTags(@Query() query: SegmentListQueryDto, @Req() req: AuthenticatedRequest) {
    return this.segments.listTags(tenantId(req), query);
  }

  @Post('tags')
  @UseGuards(CsrfGuard)
  @RequirePermission(PERMISSIONS.RECIPIENT_MANAGE)
  @UsePipes(new ZodValidationPipe(createTagSchema))
  @AuditLog({ action: 'tag.created', entityType: 'tag', resolveEntityId: ({ result }) => (result as { id?: string } | undefined)?.id ?? null })
  createTag(@Body() body: CreateTagDto, @Req() req: AuthenticatedRequest) {
    return this.segments.createTag(tenantId(req), body);
  }

  @Get('tags/:id')
  @RequirePermission(PERMISSIONS.RECIPIENT_READ)
  getTag(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.segments.getTag(tenantId(req), id);
  }

  @Patch('tags/:id')
  @UseGuards(CsrfGuard)
  @RequirePermission(PERMISSIONS.RECIPIENT_MANAGE)
  @AuditLog({ action: 'tag.updated', entityType: 'tag', resolveEntityId: ({ request }) => (request.params as { id: string }).id })
  updateTag(@Param('id') id: string, @Body(new ZodValidationPipe(updateTagSchema)) body: UpdateTagDto, @Req() req: AuthenticatedRequest) {
    return this.segments.updateTag(tenantId(req), id, body);
  }

  @Post('tags/:id/members')
  @UseGuards(CsrfGuard)
  @RequirePermission(PERMISSIONS.RECIPIENT_MANAGE)
  @AuditLog({ action: 'tag.members_added', entityType: 'tag', resolveEntityId: ({ request }) => (request.params as { id: string }).id })
  async addTagMembers(@Param('id') id: string, @Body(new ZodValidationPipe(segmentMembersSchema)) body: SegmentMembersDto, @Req() req: AuthenticatedRequest) {
    await this.segments.addTagMembers(tenantId(req), id, body.recipientIds);
  }

  @Delete('tags/:id/members')
  @UseGuards(CsrfGuard)
  @RequirePermission(PERMISSIONS.RECIPIENT_MANAGE)
  @HttpCode(204)
  @AuditLog({ action: 'tag.members_removed', entityType: 'tag', resolveEntityId: ({ request }) => (request.params as { id: string }).id })
  async removeTagMembers(@Param('id') id: string, @Body(new ZodValidationPipe(segmentMembersSchema)) body: SegmentMembersDto, @Req() req: AuthenticatedRequest): Promise<void> {
    await this.segments.removeTagMembers(tenantId(req), id, body.recipientIds);
  }

  @Delete('tags/:id')
  @UseGuards(CsrfGuard)
  @RequirePermission(PERMISSIONS.RECIPIENT_MANAGE)
  @HttpCode(204)
  async removeTag(@Param('id') id: string, @Req() req: AuthenticatedRequest): Promise<void> {
    await this.segments.removeTag(tenantId(req), id, actor(req));
  }
}
