import { BadRequestException, Body, Controller, Delete, Get, Headers, HttpCode, HttpException, Param, Patch, Post, Query, Req, Res, UnauthorizedException, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { CsrfGuard } from '../auth/csrf.guard.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { getOrCreateTraceId } from '../common/trace-id.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { CampaignsService } from './campaigns.service.js';
import { RequirePermission } from '../common/decorators/require-permission.decorator.js';
import { PERMISSIONS } from '../common/permissions.js';
import { campaignListQuerySchema, campaignScheduleRequestSchema, createCampaignDraftSchema, previewCampaignAudienceSchema, type CampaignListQueryDto, type CampaignScheduleRequestDto, type CreateCampaignDraftDto, type PreviewCampaignAudienceDto, type UpdateCampaignDraftDto, updateCampaignDraftSchema } from './dto/campaign.dto.js';
import { campaignBulkSchema, type CampaignBulkDto } from './dto/bulk.dto.js';
import { historyListQuerySchema, historyRecipientsQuerySchema, type HistoryListQueryDto, type HistoryRecipientsQueryDto } from './dto/history.dto.js';

function tenantId(req: AuthenticatedRequest): string {
  if (!req.auth?.tenantId) throw new UnauthorizedException('Not authenticated.');
  return req.auth.tenantId;
}

function actor(req: AuthenticatedRequest) {
  if (!req.auth?.userId) throw new UnauthorizedException('Not authenticated.');
  return { actorId: req.auth.userId, traceId: getOrCreateTraceId(req), role: req.auth.role, permissions: req.auth.permissions };
}

function expectedVersion(ifMatch: string | undefined): number {
  if (!ifMatch?.trim()) throw new HttpException('If-Match is required.', 428);
  const match = /^"?(\d+)"?$/.exec(ifMatch.trim());
  if (!match) throw new HttpException('If-Match must be a strong campaign version ETag.', 400);
  return Number(match[1]);
}

function setEtag(response: Response, version: number): void {
  response.setHeader('ETag', `"${version}"`);
}

@Controller('campaigns') export class CampaignsController {
  constructor(private readonly campaigns: CampaignsService) {}
  @Get() @RequirePermission(PERMISSIONS.CONTENT_MANAGE) async list(@Query(new ZodValidationPipe(campaignListQuerySchema)) query: CampaignListQueryDto, @Req() req: AuthenticatedRequest) { return { items: await this.campaigns.listDrafts(tenantId(req), query, actor(req)) }; }
  // BR-HIS-001. Declared before @Get(':id') -- Nest would otherwise route
  // GET /campaigns/history into the id handler with id='history'.
  @Get('history') @RequirePermission(PERMISSIONS.CAMPAIGN_READ)
  async history(@Query(new ZodValidationPipe(historyListQuerySchema)) query: HistoryListQueryDto, @Req() req: AuthenticatedRequest) {
    return this.campaigns.listHistory(tenantId(req), query, actor(req));
  }
  // Declared before every parameterised POST route, for the same reason
  // 'history' is declared before the parameterised GET: Nest would otherwise
  // route POST /campaigns/bulk into an id handler with id='bulk'.
  // (Written without a decorator-shaped example on purpose -- the
  // ARCH-CROSS-TENANT scanner reads comments too, and one here was picked up
  // as a phantom route with no negative test.)
  // CAMPAIGN_READ is only the floor that gets the request into the handler --
  // the real permission differs per action and is checked in bulkAction.
  @Post('bulk') @HttpCode(200) @UseGuards(CsrfGuard) @RequirePermission(PERMISSIONS.CAMPAIGN_READ)
  async bulk(@Body(new ZodValidationPipe(campaignBulkSchema)) body: CampaignBulkDto, @Req() req: AuthenticatedRequest) {
    return this.campaigns.bulkAction(tenantId(req), body, actor(req));
  }
  @Post() @UseGuards(CsrfGuard) @RequirePermission(PERMISSIONS.CONTENT_MANAGE)
  async create(@Body(new ZodValidationPipe(createCampaignDraftSchema)) body: CreateCampaignDraftDto, @Req() req: AuthenticatedRequest, @Res({ passthrough: true }) res: Response) {
    const campaign = await this.campaigns.createDraft(tenantId(req), body, actor(req)); setEtag(res, campaign.version); return campaign;
  }
  @Get(':id') @RequirePermission(PERMISSIONS.CONTENT_MANAGE)
  async getDraft(@Param('id') id: string, @Req() req: AuthenticatedRequest, @Res({ passthrough: true }) res: Response) {
    const campaign = await this.campaigns.getDraft(tenantId(req), id, actor(req)); setEtag(res, campaign.version); return campaign;
  }
  @Patch(':id') @UseGuards(CsrfGuard) @RequirePermission(PERMISSIONS.CONTENT_MANAGE)
  async updateDraft(@Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Body(new ZodValidationPipe(updateCampaignDraftSchema)) body: UpdateCampaignDraftDto, @Req() req: AuthenticatedRequest, @Res({ passthrough: true }) res: Response) {
    const campaign = await this.campaigns.updateDraft(tenantId(req), id, expectedVersion(ifMatch), body, actor(req)); setEtag(res, campaign.version); return campaign;
  }
  @Delete(':id') @HttpCode(204) @UseGuards(CsrfGuard) @RequirePermission(PERMISSIONS.CONTENT_MANAGE)
  async deleteDraft(@Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Req() req: AuthenticatedRequest): Promise<void> { await this.campaigns.deleteDraft(tenantId(req), id, expectedVersion(ifMatch), actor(req)); }
  @Post(':id/duplicate') @UseGuards(CsrfGuard) @RequirePermission(PERMISSIONS.CONTENT_MANAGE)
  async duplicate(@Param('id') id: string, @Req() req: AuthenticatedRequest, @Res({ passthrough: true }) res: Response) { const campaign = await this.campaigns.duplicateDraft(tenantId(req), id, actor(req)); setEtag(res, campaign.version); return campaign; }
  @Post(':id/audience/preview') @HttpCode(200) @UseGuards(CsrfGuard) @RequirePermission(PERMISSIONS.CONTENT_MANAGE)
  async previewAudience(@Param('id') id: string, @Body(new ZodValidationPipe(previewCampaignAudienceSchema)) body: PreviewCampaignAudienceDto, @Req() req: AuthenticatedRequest) {
    return this.campaigns.previewAudience(tenantId(req), id, body.audience);
  }
  @Post(':id/validate-audience') @HttpCode(200) @UseGuards(CsrfGuard) @RequirePermission(PERMISSIONS.CONTENT_MANAGE)
  async validateAudience(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.campaigns.validateAudience(tenantId(req), id);
  }
  @Get(':id/preflight') @RequirePermission(PERMISSIONS.CONTENT_MANAGE)
  async preflight(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.campaigns.preflight(tenantId(req), id, actor(req));
  }
  @Post(':id/audience-waiver') @UseGuards(CsrfGuard) @RequirePermission(PERMISSIONS.CONTENT_MANAGE)
  async acceptAudienceWaiver(@Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Req() req: AuthenticatedRequest, @Res({ passthrough: true }) res: Response) {
    const campaign = await this.campaigns.acceptAudienceWaiver(tenantId(req), id, expectedVersion(ifMatch), actor(req));
    setEtag(res, campaign.version);
    return campaign;
  }
  @Get(':id/progress') @RequirePermission(PERMISSIONS.CAMPAIGN_READ)
  async progress(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.campaigns.getCampaignProgress(tenantId(req), id);
  }
  @Get(':id/recipients') @RequirePermission(PERMISSIONS.CAMPAIGN_READ)
  async recipients(@Param('id') id: string, @Query(new ZodValidationPipe(historyRecipientsQuerySchema)) query: HistoryRecipientsQueryDto, @Req() req: AuthenticatedRequest) {
    return this.campaigns.listHistoryRecipients(tenantId(req), id, query);
  }

  @Post(':id/schedule') @HttpCode(202) @UseGuards(CsrfGuard) @RequirePermission(PERMISSIONS.CAMPAIGN_MANAGE)
  async schedule(@Param('id') id: string, @Headers('idempotency-key') idempotencyKey: string | undefined, @Body(new ZodValidationPipe(campaignScheduleRequestSchema)) body: CampaignScheduleRequestDto, @Req() req: AuthenticatedRequest) {
    if (!idempotencyKey?.trim()) throw new BadRequestException('Idempotency-Key is required to schedule a campaign.');
    return this.campaigns.scheduleCampaign(tenantId(req), id, idempotencyKey, body, actor(req));
  }

  @Post(':id/schedule/cancel') @HttpCode(202) @UseGuards(CsrfGuard) @RequirePermission(PERMISSIONS.CAMPAIGN_MANAGE)
  async cancelSchedule(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.campaigns.cancelCampaignSchedule(tenantId(req), id, actor(req));
  }

  @Post(':id/send') @HttpCode(202) @UseGuards(CsrfGuard) @RequirePermission(PERMISSIONS.CAMPAIGN_MANAGE)
  async send(@Param('id') id: string, @Headers('idempotency-key') idempotencyKey: string | undefined, @Req() req: AuthenticatedRequest) {
    if (!idempotencyKey?.trim()) throw new BadRequestException('Idempotency-Key is required to send a campaign.');
    return this.campaigns.sendCampaign(tenantId(req), id, idempotencyKey, actor(req));
  }

  @Post(':id/cancel') @HttpCode(202) @UseGuards(CsrfGuard) @RequirePermission(PERMISSIONS.CAMPAIGN_MANAGE)
  async cancel(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.campaigns.cancelCampaign(tenantId(req), id, actor(req));
  }

  @Post(':id/send/cancel') @HttpCode(202) @UseGuards(CsrfGuard) @RequirePermission(PERMISSIONS.CAMPAIGN_MANAGE)
  async cancelSend(@Param('id') id: string, @Headers('idempotency-key') idempotencyKey: string | undefined, @Req() req: AuthenticatedRequest) {
    if (!idempotencyKey?.trim()) throw new BadRequestException('Idempotency-Key is required to cancel a campaign send.');
    return this.campaigns.cancelCampaignSend(tenantId(req), id, idempotencyKey, actor(req));
  }

  @Post(':id/pause') @HttpCode(202) @UseGuards(CsrfGuard) @RequirePermission(PERMISSIONS.CAMPAIGN_MANAGE)
  async pause(@Param('id') id: string, @Headers('idempotency-key') idempotencyKey: string | undefined, @Req() req: AuthenticatedRequest) {
    if (!idempotencyKey?.trim()) throw new BadRequestException('Idempotency-Key is required to pause a campaign.');
    return this.campaigns.pauseCampaign(tenantId(req), id, idempotencyKey, actor(req));
  }

  @Post(':id/resume') @HttpCode(202) @UseGuards(CsrfGuard) @RequirePermission(PERMISSIONS.CAMPAIGN_MANAGE)
  async resume(@Param('id') id: string, @Headers('idempotency-key') idempotencyKey: string | undefined, @Req() req: AuthenticatedRequest) {
    if (!idempotencyKey?.trim()) throw new BadRequestException('Idempotency-Key is required to resume a campaign.');
    return this.campaigns.resumeCampaign(tenantId(req), id, idempotencyKey, actor(req));
  }

  @Post(':id/resend') @HttpCode(202) @UseGuards(CsrfGuard) @RequirePermission(PERMISSIONS.CAMPAIGN_MANAGE)
  async resend(@Param('id') id: string, @Headers('idempotency-key') idempotencyKey: string | undefined, @Req() req: AuthenticatedRequest) {
    if (!idempotencyKey?.trim()) throw new BadRequestException('Idempotency-Key is required to resend a campaign.');
    return this.campaigns.resendCampaign(tenantId(req), id, idempotencyKey, actor(req));
  }

  @Get(':id/snapshot') @RequirePermission(PERMISSIONS.CAMPAIGN_READ)
  async getSnapshot(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.campaigns.getCampaignSnapshot(tenantId(req), id);
  }
}
