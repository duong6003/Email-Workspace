import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { CsrfGuard } from '../auth/csrf.guard.js';
import { AuditLog } from '../common/decorators/audit-log.decorator.js';
import { RequirePermission } from '../common/decorators/require-permission.decorator.js';
import { PERMISSIONS } from '../common/permissions.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ReusableBlocksService } from './reusable-blocks.service.js';
import { createReusableBlockSchema, updateReusableBlockSchema, type CreateReusableBlockDto, type UpdateReusableBlockDto } from './dto/reusable-block.dto.js';

function tenantId(request: AuthenticatedRequest): string {
  if (!request.auth) throw new UnauthorizedException('Not authenticated.');
  return request.auth.tenantId;
}

function requestParam(request: AuthenticatedRequest, key: string): string | null {
  const value = request.params[key];
  return typeof value === 'string' ? value : null;
}

/**
 * MC-UI-004. Five operations, matching the catalog's five actions minus the two
 * that never reach the network: `search` filters the already-loaded list
 * client-side (a round-trip per keystroke buys nothing for a tenant-sized
 * library), and `insert` is a `tree-ops.ts` call on the open document.
 *
 * The permission split follows 073: reading the library is `content:read`, so a
 * viewer opening the builder read-only still sees it -- an empty panel would be
 * the blank screen spec §2.1 rules out. Saving, renaming and deleting are
 * `content:manage` over EVERY block in the tenant, including other people's,
 * which is the Task 26 decision rather than an oversight.
 */
@Controller('reusable-blocks')
export class ReusableBlocksController {
  constructor(private readonly blocks: ReusableBlocksService) {}

  @Get() @RequirePermission(PERMISSIONS.CONTENT_READ, PERMISSIONS.CONTENT_MANAGE)
  async list(@Req() request: AuthenticatedRequest) {
    return { items: await this.blocks.listBlocks(tenantId(request)) };
  }

  @Get(':id') @RequirePermission(PERMISSIONS.CONTENT_READ, PERMISSIONS.CONTENT_MANAGE)
  get(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.blocks.getBlock(tenantId(request), id);
  }

  @Post() @UseGuards(CsrfGuard) @RequirePermission(PERMISSIONS.CONTENT_MANAGE)
  @AuditLog({ action: 'reusable-block.created', entityType: 'reusable_block', resolveEntityId: ({ result }) => (result as { id?: string } | undefined)?.id ?? null })
  create(@Body(new ZodValidationPipe(createReusableBlockSchema)) body: CreateReusableBlockDto, @Req() request: AuthenticatedRequest) {
    return this.blocks.create(tenantId(request), request.auth?.userId ?? null, body);
  }

  @Patch(':id') @UseGuards(CsrfGuard) @RequirePermission(PERMISSIONS.CONTENT_MANAGE)
  @AuditLog({ action: 'reusable-block.renamed', entityType: 'reusable_block', resolveEntityId: ({ request }) => requestParam(request, 'id') })
  update(@Param('id') id: string, @Body(new ZodValidationPipe(updateReusableBlockSchema)) body: UpdateReusableBlockDto, @Req() request: AuthenticatedRequest) {
    return this.blocks.update(tenantId(request), id, body);
  }

  @Delete(':id') @HttpCode(204) @UseGuards(CsrfGuard) @RequirePermission(PERMISSIONS.CONTENT_MANAGE)
  @AuditLog({ action: 'reusable-block.deleted', entityType: 'reusable_block', resolveEntityId: ({ request }) => requestParam(request, 'id') })
  remove(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.blocks.remove(tenantId(request), id);
  }
}
