import type { LinkContext } from './recipient-variable-context.js';
import { randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import type { ValidatedEnv } from '../config/env.js';
import { appendAuditLog } from '../common/audit-writer.js';
import { IdempotencyService } from '../common/idempotency.service.js';
import { CampaignEntity, type CampaignAudience, type CampaignSender, type CampaignSettings } from '../database/entities/campaign.entity.js';
import type { SnapshotPolicyResult } from '../database/entities/campaign-snapshot.entity.js';
import { runInTenantContext } from '../database/tenant-transaction.js';
import { AudienceCandidatesRepository } from './audience-candidates.repository.js';
import { resolveAudience, type AudienceResolution } from './audience-resolution.js';
import { bulkPrecondition, requiredBulkPermission, type CampaignBulkAction } from './campaign-bulk.js';
import { campaignCompleteness } from './campaign-completeness.js';
import { computeAudienceWaiverStatus, computeCampaignVariableValidation, type AudienceWaiverStatus } from './campaign-variable-validation.js';
import { freezeCampaignSnapshot } from './campaign-snapshot.js';
import { CampaignSnapshotRepository, type CampaignRecipientSkipCount } from './campaign-snapshot.repository.js';
import { CampaignsRepository } from './campaigns.repository.js';
import type { CampaignActor } from './campaigns.types.js';
import type { CampaignBulkDto, CampaignBulkResponse, CampaignBulkResult } from './dto/bulk.dto.js';
import type { CampaignAudienceDto, CampaignListQueryDto, CampaignScheduleRequestDto, CreateCampaignDraftDto, UpdateCampaignDraftDto } from './dto/campaign.dto.js';
import type { HistoryListQueryDto, HistoryRecipientsQueryDto } from './dto/history.dto.js';
import { buildHistoryListSql, buildHistoryProgressSql, buildHistoryRecipientsSql, encodeCursor, encodeRecipientCursor, type CampaignListViewer, type HistoryListRow, type HistoryProgressRow, type HistoryRecipientRow } from './history-query.js';
import { resolveLocalSchedule } from './schedule-time.js';
import { SenderConfigRepository } from '../sender-config/sender-config.repository.js';
import { checkSenderUsable } from './sender-usability.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import type { MissingVariableBreakdown, VariableValidationSample } from './variable-validation.js';
import { progressPercent, rollupCounts, type EtaEstimate, type ProgressCounts } from './progress-math.js';
import { isLegalCampaignExecutionTransition } from './send-state-machine.js';
import { resendFailedRecipients } from './resend.service.js';
import { etaFromFacts, readProgressFacts } from './progress-snapshot.js';
import { QuotaService } from '../quota/quota.service.js';
import { lintTemplateContent, type TemplateLintIssue } from '../templates/template-content-lint.js';

export type { CampaignActor } from './campaigns.types.js';

/**
 * Maps the exceptions the single-row methods already throw onto stable bulk
 * codes. The client renders a short fixed string per code, so these codes are
 * part of the contract in a way the exception messages are not.
 *
 * ForbiddenException is checked before ConflictException and HttpException
 * because Nest's exception classes all extend HttpException -- ordering by
 * specificity is what keeps a 403 from being reported as a state conflict.
 */
function bulkFailure(cause: unknown): { code: string; message: string } {
  if (cause instanceof ForbiddenException) {
    return { code: 'DRAFT_OWNER_REQUIRED', message: 'Only the draft owner or an administrator can change this draft.' };
  }
  if (cause instanceof NotFoundException) {
    return { code: 'CAMPAIGN_NOT_FOUND', message: 'Campaign was not found.' };
  }
  if (cause instanceof ConflictException) {
    return { code: 'CAMPAIGN_STATE_CONFLICT', message: 'Campaign state changed while the action was running.' };
  }
  if (cause instanceof HttpException && cause.getStatus() === 412) {
    return { code: 'CAMPAIGN_VERSION_CONFLICT', message: 'Campaign changed while the action was running.' };
  }
  return { code: 'BULK_ACTION_FAILED', message: 'The action could not be completed.' };
}

const AUDIENCE_SAMPLE_LIMIT = 50;

/**
 * M4-S4 (BR-CMP-007, A6): must name exactly the statuses migration 022's
 * campaign_no_edit_after_send() trigger guards, so a PATCH is rejected at
 * this layer whenever -- and only whenever -- the DB layer would also
 * reject it. Neither layer is trusted alone; drifting the two apart would
 * silently reopen the gap A6 exists to close.
 */
const FROZEN_STATUSES: ReadonlySet<CampaignEntity['status']> = new Set(['queued', 'validating', 'scheduled', 'sending', 'completed']);

export type CampaignProgressCounts = {
  pending: number; queued: number; submitted: number; delivered: number;
  bounced: number; failed: number; skipped: number; cancelled: number;
};
export type CampaignProgress = {
  campaignId: string;
  version: number;
  status: string;
  total: number;
  queued: number;
  sent: number;
  delivered: number;
  failed: number;
  percent: number;
  actionable: number;
  progressSeq: number;
  eta: EtaEstimate | null;
  counts: CampaignProgressCounts;
  totalSnapshot: number;
  executionId: string | null;
};
export type CampaignSendCancelAccepted = {
  campaignId: string;
  executionId: string | null;
  status: 'cancelled';
  submittedCount: number;
  cancelledCount: number;
  cancelledAt: string;
  idempotencyReplayed: boolean;
};
export type CampaignDraft = {
  id: string;
  name: string;
  subject: string;
  templateId: string | null;
  templateVersionId: string | null;
  sender: CampaignSender;
  audience: CampaignAudience;
  settings: CampaignSettings;
  status: CampaignEntity['status'];
  scheduledAtUtc: string | null;
  scheduledTimezone: string | null;
  scheduleLockWindowSeconds: number;
  version: number;
  completeness: number;
  ownerId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CampaignSnapshotAccepted = {
  campaignId: string;
  snapshotId: string;
  status: 'queued' | 'draft';
  totalSnapshot: number;
  sendableCount: number;
  skippedCount: number;
  frozenAt: string;
  idempotencyReplayed: boolean;
};

export type CampaignScheduleValidationReport = {
  blocking: boolean;
  name: { valid: boolean; reason?: string };
  subject: { valid: boolean; reason?: string };
  sender: { valid: boolean; reason?: string };
  template: { valid: boolean; reason?: string };
  audience: { valid: boolean; totalUnique: number; reason?: string };
  variables: { valid: boolean; missingCount: number; waiverStatus: AudienceWaiverStatus };
  quota: { valid: boolean; limit: number | null; used: number; requested: number; reason?: string };
  content: { valid: true; warnings: TemplateLintIssue[] };
  domain: { valid: true; warnings: Array<'DOMAIN_READINESS_UNVERIFIED'> };
};

export type CampaignScheduleAccepted = {
  campaignId: string;
  snapshotId: string;
  status: 'scheduled';
  scheduledAtUtc: string;
  timeZone: string;
  offsetMinutes: number;
  lockedAt: string;
  totalSnapshot: number;
  sendableCount: number;
  skippedCount: number;
  idempotencyReplayed: boolean;
};

export type CampaignScheduleCancelAccepted = {
  campaignId: string;
  status: 'cancelled';
};

export type CampaignSnapshotView = {
  id: string;
  campaignId: string;
  templateVersionId: string;
  sender: CampaignSender;
  audienceQuery: CampaignAudience;
  policyResult: SnapshotPolicyResult;
  configuredVariableValues: Record<string, unknown>;
  totalSnapshot: number;
  sendableCount: number;
  skippedCount: number;
  frozenAt: string;
  supersededAt: string | null;
  skippedByReason: CampaignRecipientSkipCount[];
};

export type { AudienceWaiverStatus } from './campaign-variable-validation.js';
export type ValidateCampaignAudienceResult = {
  totalActionable: number;
  completeCount: number;
  missingCount: number;
  missingByVariable: MissingVariableBreakdown[];
  sample: VariableValidationSample[];
  waiverStatus: AudienceWaiverStatus;
  waiverAcceptedAt: string | null;
};

function asDraft(campaign: CampaignEntity, scheduleLockWindowSeconds: number): CampaignDraft {
  return {
    id: campaign.id,
    name: campaign.name,
    subject: campaign.subject,
    templateId: campaign.templateId,
    templateVersionId: campaign.templateVersionId,
    sender: campaign.senderJson,
    audience: campaign.audienceJson,
    settings: campaign.settingsJson,
    status: campaign.status,
    scheduledAtUtc: campaign.scheduledAtUtc ? campaign.scheduledAtUtc.toISOString() : null,
    scheduledTimezone: campaign.scheduledTimezone,
    scheduleLockWindowSeconds,
    version: campaign.version,
    completeness: campaignCompleteness({
      name: campaign.name,
      subject: campaign.subject,
      templateVersionId: campaign.templateVersionId,
      sender: campaign.senderJson,
      audience: campaign.audienceJson,
    }),
    ownerId: campaign.createdBy,
    createdAt: campaign.createdAt.toISOString(),
    updatedAt: campaign.updatedAt.toISOString(),
  };
}

@Injectable() export class CampaignsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: ConfigService<ValidatedEnv, true>,
    private readonly idempotency: IdempotencyService,
    private readonly notifications: NotificationsService,
    private readonly quota: QuotaService,
  ) {}

  /**
   * BR-SEG-008/009, BR-CMP-002/003/009, BR-REC-003. The audience being
   * previewed may not yet be saved to the draft (the picker previews before
   * committing), so it is taken as an explicit argument, not read from the
   * stored campaign. `campaignId` still has to name a real, owned draft --
   * consistent with every other route in this controller, and so the path
   * cannot be used to probe a nonexistent or cross-tenant id.
   */
  async previewAudience(tenantId: string, campaignId: string, audience: CampaignAudienceDto): Promise<AudienceResolution> {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const campaign = await new CampaignsRepository(manager, tenantId).findActiveById(campaignId);
      if (!campaign) throw new NotFoundException('Campaign was not found.');

      const candidates = await new AudienceCandidatesRepository(manager, tenantId).findCandidates({
        listIds: audience.listIds ?? [],
        tagIds: audience.tagIds ?? [],
        recipientIds: audience.recipientIds ?? [],
        excludeListIds: audience.excludeListIds ?? [],
        excludeTagIds: audience.excludeTagIds ?? [],
        excludeRecipientIds: audience.excludeRecipientIds ?? [],
      });
      const resolution = resolveAudience(candidates, { sampleLimit: AUDIENCE_SAMPLE_LIMIT });

      const limit = this.config.get('CAMPAIGN_AUDIENCE_LIMIT', { infer: true });
      if (resolution.totalUnique > limit) {
        throw new UnprocessableEntityException({
          message: `Audience of ${resolution.totalUnique} exceeds the configured limit of ${limit}.`,
          limit,
          // `current` is always 0: no cross-campaign quota ledger exists until
          // M7-S1 (BR-CFG-006), so there is nothing already-consumed to
          // report. This checks one campaign's own audience size against a
          // static ceiling, not accumulated tenant usage -- see M4-S2-AUDIENCE-PLAN.md §3.3.
          current: 0,
          requested: resolution.totalUnique,
        });
      }
      return resolution;
    });
  }

  /**
   * BR-CMP-004/005/006/008, BR-TPL-008. Read-only: reads the draft's own
   * saved template/audience rather than an unsaved body (unlike
   * previewAudience, there is nothing new to preview here -- once a
   * template is attached, the draft itself is the source of truth).
   * `waiverStatus` compares the fresh missing-recipient set against
   * whatever was last accepted (acceptAudienceWaiver below): `stale` means
   * the audience changed since acceptance and a new recipient is now
   * missing something the operator never actually reviewed.
   */
  async validateAudience(tenantId: string, campaignId: string): Promise<ValidateCampaignAudienceResult> {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const campaign = await new CampaignsRepository(manager, tenantId).findActiveById(campaignId);
      if (!campaign) throw new NotFoundException('Campaign was not found.');
      const webOrigin = this.linkContext();
      const result = await computeCampaignVariableValidation(manager, tenantId, campaign, webOrigin);

      const waiver = campaign.settingsJson.audienceWaiver ?? null;
      return {
        totalActionable: result.totalActionable,
        completeCount: result.completeCount,
        missingCount: result.missingCount,
        missingByVariable: result.missingByVariable,
        sample: result.sample,
        waiverStatus: computeAudienceWaiverStatus(waiver, result.missingRecipientIds),
        waiverAcceptedAt: waiver?.acceptedAt ?? null,
      };
    });
  }

  async preflight(tenantId: string, campaignId: string, actor: CampaignActor): Promise<CampaignScheduleValidationReport> {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const campaign = await new CampaignsRepository(manager, tenantId).findActiveById(campaignId);
      if (!campaign) throw new NotFoundException('Campaign was not found.');
      this.assertDraftAccess(campaign, actor);
      return this.buildScheduleValidationReport(
        manager,
        tenantId,
        campaign,
        this.linkContext(),
        this.config.get('CAMPAIGN_AUDIENCE_LIMIT', { infer: true }),
      );
    });
  }

  /**
   * BR-CMP-005's "accepted resolution path": the missing-recipient set is
   * always freshly computed server-side here, never taken from the client
   * -- a client-supplied recipient-id list for a compliance-adjacent
   * decision would let the operator's own browser under- or over-state who
   * gets excluded. Persisted additively on settingsJson (no new migration,
   * no snapshot/campaign_recipient rows -- M4-S4 still owns those), audited.
   */
  async acceptAudienceWaiver(tenantId: string, campaignId: string, expectedVersion: number, actor: CampaignActor): Promise<CampaignDraft> {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const repository = new CampaignsRepository(manager, tenantId);
      const campaign = await repository.findActiveById(campaignId, true);
      if (!campaign) throw new NotFoundException('Campaign was not found.');
      if (campaign.version !== expectedVersion) throw new HttpException('Campaign has changed. Reload before saving.', 412);

      const webOrigin = this.linkContext();
      const result = await computeCampaignVariableValidation(manager, tenantId, campaign, webOrigin);

      const updated = await repository.save({
        ...campaign,
        settingsJson: {
          ...campaign.settingsJson,
          audienceWaiver: { acceptedAt: new Date().toISOString(), acceptedBy: actor.actorId, missingVariableRecipientIds: result.missingRecipientIds },
        },
        version: campaign.version + 1,
        updatedBy: actor.actorId,
      });
      await appendAuditLog(manager, {
        tenantId,
        actorId: actor.actorId,
        action: 'campaign.audience_waiver_accepted',
        entityType: 'campaign',
        entityId: updated.id,
        traceId: actor.traceId,
        metadata: { missingCount: result.missingCount, recipientIds: result.missingRecipientIds },
      });
      return asDraft(updated, this.config.get('SCHEDULE_LOCK_WINDOW_SECONDS', { infer: true }));
    });
  }

  async listDrafts(tenantId: string, query: CampaignListQueryDto, actor: CampaignActor): Promise<CampaignDraft[]> {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      if (query.scope === 'all' && actor.actorId && !this.canManageAllDrafts(actor)) throw new ForbiddenException({ code: 'DRAFT_SCOPE_FORBIDDEN', message: 'Only administrators can view all drafts.' });
      const campaigns = await new CampaignsRepository(manager, tenantId).listDrafts(query.status, query.limit, query.scope === 'mine' && actor.actorId ? actor.actorId : undefined);
      const scheduleLockWindowSeconds = this.config.get('SCHEDULE_LOCK_WINDOW_SECONDS', { infer: true });
      return campaigns.map((campaign) => asDraft(campaign, scheduleLockWindowSeconds));
    });
  }

  async createDraft(tenantId: string, body: CreateCampaignDraftDto, actor: CampaignActor): Promise<CampaignDraft> {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const repository = new CampaignsRepository(manager, tenantId);
      const senderJson = Object.keys(body.sender ?? {}).length > 0 ? body.sender : await this.defaultDraftSender(manager, tenantId);
      const campaign = await repository.save({
        name: body.name.trim(),
        subject: (body.subject ?? '').trim(),
        templateId: body.templateId ?? null,
        templateVersionId: body.templateVersionId ?? null,
        senderJson,
        audienceJson: body.audience ?? {},
        settingsJson: body.settings ?? {},
        status: 'draft',
        version: 0,
        createdBy: actor.actorId,
        updatedBy: actor.actorId,
      });
      await appendAuditLog(manager, {
        tenantId,
        actorId: actor.actorId,
        action: 'campaign.draft_created',
        entityType: 'campaign',
        entityId: campaign.id,
        traceId: actor.traceId,
        metadata: { name: campaign.name },
      });
      return asDraft(campaign, this.config.get('SCHEDULE_LOCK_WINDOW_SECONDS', { infer: true }));
    });
  }

  async getDraft(tenantId: string, id: string, actor?: CampaignActor): Promise<CampaignDraft> {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const campaign = await new CampaignsRepository(manager, tenantId).findActiveById(id);
      if (!campaign) throw new NotFoundException('Campaign was not found.');
      if (actor) this.assertDraftAccess(campaign, actor);
      return asDraft(campaign, this.config.get('SCHEDULE_LOCK_WINDOW_SECONDS', { infer: true }));
    });
  }

  async updateDraft(tenantId: string, id: string, expectedVersion: number, body: UpdateCampaignDraftDto, actor: CampaignActor): Promise<CampaignDraft> {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const repository = new CampaignsRepository(manager, tenantId);
      const campaign = await repository.findActiveById(id, true);
      if (!campaign) throw new NotFoundException('Campaign was not found.');
      this.assertDraftAccess(campaign, actor);
      if (FROZEN_STATUSES.has(campaign.status)) throw new ConflictException('Campaign cannot be edited after it has been frozen for sending.');
      if (campaign.version !== expectedVersion) throw new HttpException('Campaign has changed. Reload before saving.', 412);
      const senderJson = body.sender === undefined ? undefined : await this.resolveDraftSender(manager, tenantId, body.sender);

      const updated = await repository.save({
        ...campaign,
        ...(body.name === undefined ? {} : { name: body.name.trim() }),
        ...(body.subject === undefined ? {} : { subject: body.subject.trim() }),
        ...(body.templateId === undefined ? {} : { templateId: body.templateId }),
        ...(body.templateVersionId === undefined ? {} : { templateVersionId: body.templateVersionId }),
        ...(senderJson === undefined ? {} : { senderJson }),
        ...(body.audience === undefined ? {} : { audienceJson: body.audience }),
        ...(body.settings === undefined ? {} : { settingsJson: body.settings }),
        version: campaign.version + 1,
        updatedBy: actor.actorId,
      });
      await appendAuditLog(manager, {
        tenantId,
        actorId: actor.actorId,
        action: 'campaign.draft_updated',
        entityType: 'campaign',
        entityId: updated.id,
        traceId: actor.traceId,
        metadata: { name: updated.name },
      });
      return asDraft(updated, this.config.get('SCHEDULE_LOCK_WINDOW_SECONDS', { infer: true }));
    });
  }

  async duplicateDraft(tenantId: string, id: string, actor: CampaignActor): Promise<CampaignDraft> {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const repository = new CampaignsRepository(manager, tenantId);
      const original = await repository.findActiveById(id);
      if (!original) throw new NotFoundException('Campaign was not found.');
      this.assertDraftAccess(original, actor);
      const duplicate = await repository.save({
        name: original.name,
        subject: original.subject,
        templateId: original.templateId,
        templateVersionId: original.templateVersionId,
        senderJson: original.senderJson,
        audienceJson: original.audienceJson,
        settingsJson: original.settingsJson,
        status: 'draft',
        version: 0,
        createdBy: actor.actorId,
        updatedBy: actor.actorId,
      });
      await appendAuditLog(manager, {
        tenantId,
        actorId: actor.actorId,
        action: 'campaign.duplicated',
        entityType: 'campaign',
        entityId: duplicate.id,
        traceId: actor.traceId,
        metadata: { name: duplicate.name, sourceCampaignId: original.id },
      });
      return asDraft(duplicate, this.config.get('SCHEDULE_LOCK_WINDOW_SECONDS', { infer: true }));
    });
  }

  async deleteDraft(tenantId: string, id: string, expectedVersion: number, actor: CampaignActor): Promise<void> {
    await runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const repository = new CampaignsRepository(manager, tenantId);
      const campaign = await repository.findActiveById(id, true);
      if (!campaign) throw new NotFoundException('Campaign was not found.');
      this.assertDraftAccess(campaign, actor);
      if (campaign.status === 'sending' || campaign.status === 'completed') throw new ConflictException('Campaign cannot be deleted after sending starts.');
      if (campaign.version !== expectedVersion) throw new HttpException('Campaign has changed. Reload before deleting.', 412);
      campaign.deletedAt = new Date();
      campaign.updatedBy = actor.actorId;
      campaign.version += 1;
      await repository.save(campaign);
      await appendAuditLog(manager, {
        tenantId,
        actorId: actor.actorId,
        action: 'campaign.draft_deleted',
        entityType: 'campaign',
        entityId: campaign.id,
        traceId: actor.traceId,
        metadata: { name: campaign.name },
      });
    });
  }

  /**
   * Synchronous bulk action for the campaign list. Each campaign is applied
   * independently: a precondition failure is reported as `skipped`, an error
   * as `failed`, and neither stops the remaining rows.
   *
   * Two deliberate omissions, so they are not rediscovered as bugs. There is
   * no If-Match -- N version numbers cannot travel in one request, so each
   * row's version is read inside its own transaction and a moved version
   * surfaces as CAMPAIGN_VERSION_CONFLICT for that row alone. And there is no
   * idempotency key: the call is synchronous and the client disables the
   * control while it is in flight.
   */
  async bulkAction(tenantId: string, body: CampaignBulkDto, actor: CampaignActor): Promise<CampaignBulkResponse> {
    const permission = requiredBulkPermission(body.action);
    if (!actor.permissions?.includes(permission)) {
      throw new ForbiddenException({ code: 'PERMISSION_REQUIRED', message: `This action requires ${permission}.` });
    }

    const results: CampaignBulkResult[] = [];
    for (const campaignId of body.campaignIds) {
      results.push(await this.runBulkRow(tenantId, body.action, campaignId, actor));
    }

    return {
      results,
      succeeded: results.filter((row) => row.outcome === 'succeeded').length,
      failed: results.filter((row) => row.outcome === 'failed').length,
      skipped: results.filter((row) => row.outcome === 'skipped').length,
    };
  }

  private async runBulkRow(tenantId: string, action: CampaignBulkAction, campaignId: string, actor: CampaignActor): Promise<CampaignBulkResult> {
    let status: CampaignEntity['status'];
    let version: number;
    try {
      const campaign = await runInTenantContext(this.dataSource, tenantId, async (manager) => {
        const found = await new CampaignsRepository(manager, tenantId).findActiveById(campaignId);
        if (!found) throw new NotFoundException('Campaign was not found.');
        return found;
      });
      status = campaign.status;
      version = campaign.version;
    } catch {
      return { campaignId, outcome: 'failed', code: 'CAMPAIGN_NOT_FOUND', message: 'Campaign was not found.' };
    }

    const precondition = bulkPrecondition(action, status);
    if (!precondition.allowed) {
      return { campaignId, outcome: 'skipped', code: precondition.code, message: precondition.message };
    }

    try {
      // 'cancel' fans out to three different methods because three different
      // things are being cancelled: a pending schedule, a queued run, or a
      // send already in flight. cancelCampaignSend needs an idempotency key of
      // its own -- each bulk row is a distinct operation, so it gets one.
      if (action === 'delete') await this.deleteDraft(tenantId, campaignId, version, actor);
      else if (action === 'duplicate') await this.duplicateDraft(tenantId, campaignId, actor);
      else if (status === 'scheduled') await this.cancelCampaignSchedule(tenantId, campaignId, actor);
      else if (status === 'queued') await this.cancelCampaign(tenantId, campaignId, actor);
      else await this.cancelCampaignSend(tenantId, campaignId, randomUUID(), actor);
      return { campaignId, outcome: 'succeeded', code: 'OK', message: '' };
    } catch (cause) {
      return { campaignId, outcome: 'failed', ...bulkFailure(cause) };
    }
  }

  private canManageAllDrafts(actor: CampaignActor): boolean {
    return actor.role === 'admin' && (actor.permissions?.includes('settings:manage') ?? false);
  }

  /**
   * ADR-049: where unsubscribe links point and what signs them. One accessor
   * so no call site can assemble an origin without the secret that makes the
   * link redeemable -- an unsigned one would let anyone holding a recipient id
   * unsubscribe that person.
   */
  private linkContext(): LinkContext {
    return {
      webOrigin: this.config.get('WEB_ORIGIN', { infer: true }),
      unsubscribeSecret: this.config.get('SESSION_SECRET', { infer: true }),
    };
  }

  private assertDraftAccess(campaign: CampaignEntity, actor: CampaignActor): void {
    if (!actor.actorId || campaign.createdBy === actor.actorId || this.canManageAllDrafts(actor)) return;
    throw new ForbiddenException({ code: 'DRAFT_OWNER_REQUIRED', message: 'Only the draft owner or an administrator can change this draft.' });
  }

  private async defaultDraftSender(manager: EntityManager, tenantId: string): Promise<CampaignSender> {
    const [policy] = await manager.query(
      'SELECT default_sender_config_id AS "defaultSenderConfigId", reply_to AS "replyTo" FROM sending_policy WHERE tenant_id = $1 LIMIT 1',
      [tenantId],
    ) as Array<{ defaultSenderConfigId: string | null; replyTo: string | null }>;
    if (!policy?.defaultSenderConfigId) return {};
    const sender = await new SenderConfigRepository(manager, tenantId).findActiveById(policy.defaultSenderConfigId);
    if (!sender || sender.status !== 'verified') return {};
    return { senderConfigId: sender.id, fromName: sender.fromName, fromEmail: sender.fromEmail, replyTo: sender.replyTo ?? policy.replyTo };
  }

  private async resolveDraftSender(manager: EntityManager, tenantId: string, requested: CampaignSender): Promise<CampaignSender> {
    if (!requested.senderConfigId) return {};
    const sender = await new SenderConfigRepository(manager, tenantId).findActiveById(requested.senderConfigId);
    if (!sender || sender.status !== 'verified') throw new UnprocessableEntityException({ code: 'SENDER_NOT_USABLE', message: 'Only a verified active sender can be selected.' });
    const [policy] = await manager.query('SELECT reply_to AS "replyTo" FROM sending_policy WHERE tenant_id = $1 LIMIT 1', [tenantId]) as Array<{ replyTo: string | null }>;
    return { senderConfigId: sender.id, fromName: sender.fromName, fromEmail: sender.fromEmail, replyTo: sender.replyTo ?? policy?.replyTo ?? null };
  }

  /**
   * M5-S3 CP6 (BR-SEND-002, A19, D-92), extended M6-S1 CP8 (BR-SEND-003/005).
   * Real per-status counts from campaign_recipient, recomputed on read
   * rather than trusted from any cache -- the same "counts sum to
   * total_snapshot" invariant aggregateExecution enforces server-side.
   * `percent`/`eta` reuse the exact same progress-math.ts/progress-snapshot.ts
   * readProgressFacts() the realtime publish path uses (BR-HIS-002: "Counts
   * cùng nguồn backend"), so a REST read and a socket event can never
   * disagree about what "42%" means.
   */
  async getCampaignProgress(tenantId: string, campaignId: string): Promise<CampaignProgress> {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const campaign = await new CampaignsRepository(manager, tenantId).findActiveById(campaignId);
      if (!campaign) throw new NotFoundException('Campaign was not found.');

      const snapshotRepository = new CampaignSnapshotRepository(manager, tenantId);
      const snapshot = await snapshotRepository.findLive(campaign.id);
      let counts: ProgressCounts = { pending: 0, queued: 0, submitted: 0, delivered: 0, bounced: 0, failed: 0, skipped: 0, cancelled: 0 };
      let actionable = 0;
      let executionId: string | null = null;
      let progressSeq = 0;
      let eta: EtaEstimate | null = null;

      if (snapshot) {
        const [execution] = (await manager.query(
          `SELECT id, progress_seq FROM campaign_execution WHERE tenant_id = $1 AND snapshot_id = $2`,
          [tenantId, snapshot.id],
        )) as Array<{ id: string; progress_seq: string }>;
        executionId = execution?.id ?? null;
        progressSeq = execution ? Number(execution.progress_seq) : 0;

        if (executionId) {
          const facts = await readProgressFacts(manager, tenantId, snapshot.id, executionId);
          counts = facts.counts;
          actionable = facts.actionable;
          const terminal = counts.submitted + counts.delivered + counts.bounced + counts.failed;
          const remaining = Math.max(0, actionable - terminal);
          eta = etaFromFacts(facts, remaining);
        } else {
          // No campaign_execution row yet (e.g. frozen but not yet past
          // validate/partition) -- counts/actionable still read for display
          // consistency; there is no ETA sample window without an execution.
          const rows = (await manager.query(
            `SELECT status, count(*)::int AS count FROM campaign_recipient WHERE tenant_id = $1 AND snapshot_id = $2 GROUP BY status`,
            [tenantId, snapshot.id],
          )) as Array<{ status: keyof ProgressCounts; count: number }>;
          for (const row of rows) counts[row.status] = row.count;
          const [actionableRow] = (await manager.query(
            `SELECT count(*)::int AS actionable FROM campaign_recipient WHERE tenant_id = $1 AND snapshot_id = $2 AND eligibility = 'sendable'`,
            [tenantId, snapshot.id],
          )) as Array<{ actionable: number }>;
          actionable = actionableRow.actionable;
        }
      }
      const totalSnapshot = snapshot?.totalSnapshot ?? 0;
      // D-105 (M5-S4 CP5): these four are *rollups*, and every one must be
      // monotonic (AGENTS.md SS4, "progress counters never decrease").
      // `submitted` alone is not: a delivery webhook (M5-S4) moves a row out
      // of `submitted` into `delivered` or `bounced`. `counts` itself stays
      // exact and still sums to totalSnapshot -- it is the derived numbers
      // that needed the fix. `sent` and `failed` deliberately overlap on
      // `bounced`: a bounced message *was* sent and *did* fail, two
      // different questions about the same event, not two slices of one
      // partition (`counts` is the only thing BR-SEND-002's "sum to
      // total_snapshot" applies to).
      const rollups = rollupCounts(counts);

      return {
        campaignId: campaign.id,
        version: campaign.version,
        status: campaign.status,
        total: totalSnapshot,
        queued: rollups.queued,
        sent: rollups.sent,
        delivered: rollups.delivered,
        failed: rollups.failed,
        percent: progressPercent(counts, actionable),
        actionable,
        progressSeq,
        eta,
        counts,
        totalSnapshot,
        executionId,
      };
    });
  }

  /**
   * BR-SEND-010 (A18). A separate route from M4-S4's /cancel and M5-S2's
   * /schedule/cancel (DEC-091's precedent): different legal source state
   * ('sending', not 'queued' or 'scheduled') and a different terminal
   * effect -- submitted messages already left and keep receiving delivery
   * events (M5-S4), only the not-yet-submitted remainder is cancelled.
   */
  async cancelCampaignSend(tenantId: string, campaignId: string, idempotencyKey: string | undefined, actor: CampaignActor): Promise<CampaignSendCancelAccepted> {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const repository = new CampaignsRepository(manager, tenantId);
      const campaign = await repository.findActiveById(campaignId, true);
      if (!campaign) throw new NotFoundException('Campaign was not found.');

      const result = await this.idempotency.run(manager, tenantId, idempotencyKey, 'campaign_send_cancel', { campaignId: campaign.id, version: campaign.version }, async () => {
        if (campaign.status !== 'sending') throw new ConflictException('Campaign cannot be cancelled unless it is sending.');

        const snapshotRepository = new CampaignSnapshotRepository(manager, tenantId);
        const snapshot = await snapshotRepository.findLive(campaign.id);
        const executionRow = snapshot
          ? ((await manager.query(`SELECT id FROM campaign_execution WHERE tenant_id = $1 AND snapshot_id = $2`, [tenantId, snapshot.id])) as Array<{ id: string }>)[0]
          : undefined;

        // D-125 (M6-S3 CP7): manager.query() returns [rows, affectedCount]
        // for an UPDATE, not bare rows -- destructuring straight into
        // `cancelled` made `cancelledCount: cancelled.length` report a
        // constant 2 regardless of how many rows actually matched.
        const cancelled = snapshot
          ? ((await manager.query(
              `UPDATE campaign_recipient SET status = 'cancelled', next_retry_at = NULL, updated_at = now()
               WHERE tenant_id = $1 AND snapshot_id = $2 AND eligibility = 'sendable' AND status IN ('pending', 'queued')
               RETURNING id`,
              [tenantId, snapshot.id],
            )) as [Array<{ id: string }>, number])[0]
          : [];
        const submittedRow = snapshot
          ? ((await manager.query(
              `SELECT count(*)::int AS count FROM campaign_recipient WHERE tenant_id = $1 AND snapshot_id = $2 AND status = 'submitted'`,
              [tenantId, snapshot.id],
            )) as Array<{ count: number }>)[0]
          : { count: 0 };

        const newVersion = campaign.version + 1;
        await repository.save({ ...campaign, status: 'cancelled', version: newVersion, updatedBy: actor.actorId });
        if (executionRow) {
          await manager.query(`UPDATE campaign_execution SET status = 'cancelled', finished_at = now() WHERE id = $1 AND tenant_id = $2`, [executionRow.id, tenantId]);
        }
        await this.quota.releasePartialForCampaign(manager, tenantId, campaign.id, Number(submittedRow.count));
        await appendAuditLog(manager, {
          tenantId, actorId: actor.actorId, action: 'campaign_send.cancelled', entityType: 'campaign', entityId: campaign.id, traceId: actor.traceId,
          metadata: { executionId: executionRow?.id ?? null, cancelledCount: cancelled.length, submittedCount: submittedRow.count },
        });

        return {
          id: campaign.id,
          campaignId: campaign.id,
          executionId: executionRow?.id ?? null,
          status: 'cancelled' as const,
          submittedCount: submittedRow.count,
          cancelledCount: cancelled.length,
          cancelledAt: new Date().toISOString(),
        };
      });

      const { id: _id, ...accepted } = result.value;
      return { ...accepted, idempotencyReplayed: result.replayed };
    });
  }

  /**
   * BR-SEND-009 / ADR-027. isLegalCampaignExecutionTransition's first real
   * consumer (CP4 added the edges; nothing called the function until now).
   * Moves both campaign.status and campaign_execution.status in the same
   * transaction -- the worker's own bounded re-check (send.ts's
   * campaignIsPaused) reads campaign.status, and a viewer polling
   * getCampaignProgress reads campaign_execution's mirror, so both must
   * agree the instant this commits.
   */
  async pauseCampaign(tenantId: string, campaignId: string, idempotencyKey: string | undefined, actor: CampaignActor) {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const repository = new CampaignsRepository(manager, tenantId);
      const campaign = await repository.findActiveById(campaignId, true);
      if (!campaign) throw new NotFoundException('Campaign was not found.');

      const result = await this.idempotency.run(manager, tenantId, idempotencyKey, 'campaign_pause', { campaignId: campaign.id, version: campaign.version }, async () => {
        if (!isLegalCampaignExecutionTransition(campaign.status, 'paused')) {
          throw new ConflictException('Campaign cannot be paused unless it is sending.');
        }
        const snapshotRepository = new CampaignSnapshotRepository(manager, tenantId);
        const snapshot = await snapshotRepository.findLive(campaign.id);
        const executionRow = snapshot
          ? ((await manager.query(`SELECT id FROM campaign_execution WHERE tenant_id = $1 AND snapshot_id = $2`, [tenantId, snapshot.id])) as Array<{ id: string }>)[0]
          : undefined;

        const newVersion = campaign.version + 1;
        await repository.save({ ...campaign, status: 'paused', version: newVersion, updatedBy: actor.actorId });
        if (executionRow) {
          await manager.query(`UPDATE campaign_execution SET status = 'paused' WHERE id = $1 AND tenant_id = $2`, [executionRow.id, tenantId]);
        }
        await appendAuditLog(manager, {
          tenantId, actorId: actor.actorId, action: 'campaign_send.paused', entityType: 'campaign', entityId: campaign.id, traceId: actor.traceId,
          metadata: { executionId: executionRow?.id ?? null },
        });

        return { id: campaign.id, campaignId: campaign.id, executionId: executionRow?.id ?? null, status: 'paused' as const, pausedAt: new Date().toISOString() };
      });

      const { id: _id, ...accepted } = result.value;
      return { ...accepted, idempotencyReplayed: result.replayed };
    });
  }

  /**
   * BR-HIS-005 / ADR-027 / DEC-133. The lock-and-call contract
   * resendFailedRecipients documents: the pessimistic write lock and the
   * idempotency mutex both run inside this one transaction, so a
   * concurrent duplicate resend click and a concurrent PATCH are both
   * closed over the same window (the same pattern sendCampaign already
   * uses).
   */
  async resendCampaign(tenantId: string, campaignId: string, idempotencyKey: string | undefined, actor: CampaignActor) {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const repository = new CampaignsRepository(manager, tenantId);
      const campaign = await repository.findActiveById(campaignId, true);
      if (!campaign) throw new NotFoundException('Campaign was not found.');

      const result = await this.idempotency.run(manager, tenantId, idempotencyKey, 'campaign_resend', { campaignId: campaign.id, version: campaign.version }, () =>
        resendFailedRecipients(manager, tenantId, campaign, actor));

      const { id: _id, ...accepted } = result.value;
      return { ...accepted, idempotencyReplayed: result.replayed };
    });
  }

  /** BR-SEND-009 / ADR-027. The reverse of pauseCampaign -- see its own comment. */
  async resumeCampaign(tenantId: string, campaignId: string, idempotencyKey: string | undefined, actor: CampaignActor) {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const repository = new CampaignsRepository(manager, tenantId);
      const campaign = await repository.findActiveById(campaignId, true);
      if (!campaign) throw new NotFoundException('Campaign was not found.');

      const result = await this.idempotency.run(manager, tenantId, idempotencyKey, 'campaign_resume', { campaignId: campaign.id, version: campaign.version }, async () => {
        if (!isLegalCampaignExecutionTransition(campaign.status, 'sending')) {
          throw new ConflictException('Campaign cannot be resumed unless it is paused.');
        }
        const snapshotRepository = new CampaignSnapshotRepository(manager, tenantId);
        const snapshot = await snapshotRepository.findLive(campaign.id);
        const executionRow = snapshot
          ? ((await manager.query(`SELECT id FROM campaign_execution WHERE tenant_id = $1 AND snapshot_id = $2`, [tenantId, snapshot.id])) as Array<{ id: string }>)[0]
          : undefined;

        const newVersion = campaign.version + 1;
        await repository.save({ ...campaign, status: 'sending', version: newVersion, updatedBy: actor.actorId });
        if (executionRow) {
          await manager.query(`UPDATE campaign_execution SET status = 'sending' WHERE id = $1 AND tenant_id = $2`, [executionRow.id, tenantId]);
        }
        await appendAuditLog(manager, {
          tenantId, actorId: actor.actorId, action: 'campaign_send.resumed', entityType: 'campaign', entityId: campaign.id, traceId: actor.traceId,
          metadata: { executionId: executionRow?.id ?? null },
        });

        return { id: campaign.id, campaignId: campaign.id, executionId: executionRow?.id ?? null, status: 'sending' as const, resumedAt: new Date().toISOString() };
      });

      const { id: _id, ...accepted } = result.value;
      return { ...accepted, idempotencyReplayed: result.replayed };
    });
  }

  /**
   * BR-CMP-007/010, BR-TPL-001/012, BR-CF-008. The idempotency mutex and the
   * freeze's own pessimistic write lock (CampaignsRepository.findActiveById's
   * `lock` argument) both run inside this one transaction, so a concurrent
   * duplicate send and a concurrent PATCH are both closed over the same window.
   */
  async sendCampaign(tenantId: string, campaignId: string, idempotencyKey: string | undefined, actor: CampaignActor): Promise<CampaignSnapshotAccepted> {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const repository = new CampaignsRepository(manager, tenantId);
      const campaign = await repository.findActiveById(campaignId);
      if (!campaign) throw new NotFoundException('Campaign was not found.');

      const webOrigin = this.linkContext();
      const audienceLimit = this.config.get('CAMPAIGN_AUDIENCE_LIMIT', { infer: true });
      const payload = {
        campaignId: campaign.id,
      };
      const replay = await this.idempotency.replay<CampaignSnapshotAccepted & { id: string }>(manager, tenantId, idempotencyKey, payload);
      if (replay) {
        const { id: _id, status, ...frozen } = replay;
        return { ...frozen, status: status as 'queued', idempotencyReplayed: true };
      }
      if (campaign.status !== 'draft') throw new ConflictException('Campaign can only be sent from draft.');
      const lockedCampaign = await repository.findActiveById(campaignId, true);
      if (!lockedCampaign) throw new NotFoundException('Campaign was not found.');

      const report = await this.buildScheduleValidationReport(manager, tenantId, lockedCampaign, webOrigin, audienceLimit);
      const nonQuotaBlocking = !report.name.valid || !report.subject.valid || !report.sender.valid || !report.template.valid || !report.audience.valid || !report.variables.valid;
      if (nonQuotaBlocking) {
        const code = !report.name.valid && report.name.reason
          ? report.name.reason
          : !report.subject.valid && report.subject.reason
            ? report.subject.reason
            : !report.sender.valid && report.sender.reason
              ? report.sender.reason
              : !report.template.valid && report.template.reason
                ? report.template.reason
                : !report.audience.valid && report.audience.reason
                  ? report.audience.reason
                  : 'CAMPAIGN_PREFLIGHT_BLOCKED';
        throw new UnprocessableEntityException({ code, ...report });
      }

      const result = await this.idempotency.run(manager, tenantId, idempotencyKey, 'campaign_snapshot', payload, async () => {
        const frozen = await freezeCampaignSnapshot(manager, tenantId, lockedCampaign, actor, webOrigin, audienceLimit, { targetStatus: 'queued' });
        await this.quota.reserveForCampaign(manager, tenantId, lockedCampaign.id, frozen.snapshotId, frozen.sendableCount, actor);
        return { id: frozen.snapshotId, ...frozen };
      });

      const { id: _snapshotEntityId, status, ...frozen } = result.value;
      // sendCampaign always requests { targetStatus: 'queued' } above, so this
      // narrows FrozenSnapshot's queued|scheduled union to sendCampaign's own
      // queued|draft contract truthfully, not by evasion.
      return { ...frozen, status: status as 'queued', idempotencyReplayed: result.replayed };
    });
  }

  /**
   * BR-CMP-007's other half: cancel-to-refresh has no in-place update path by
   * construction (022's partial unique index). Supersedes the live snapshot
   * -- the one legal UPDATE its trigger permits -- and returns the campaign
   * to draft so a fresh sendCampaign() call freezes a genuinely new snapshot.
   */
  async cancelCampaign(tenantId: string, campaignId: string, actor: CampaignActor): Promise<CampaignSnapshotAccepted> {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const repository = new CampaignsRepository(manager, tenantId);
      const campaign = await repository.findActiveById(campaignId, true);
      if (!campaign) throw new NotFoundException('Campaign was not found.');
      if (campaign.status !== 'queued') throw new ConflictException('Campaign cannot be cancelled unless it is queued for sending.');

      const snapshotRepository = new CampaignSnapshotRepository(manager, tenantId);
      const snapshot = await snapshotRepository.findLive(campaign.id);
      if (!snapshot) throw new NotFoundException('No live snapshot found for this campaign.');

      const supersededAt = new Date();
      await snapshotRepository.supersede(snapshot.id, supersededAt);
      await repository.save({ ...campaign, status: 'draft', version: campaign.version + 1, updatedBy: actor.actorId });
      await this.quota.releaseForCampaign(manager, tenantId, campaign.id);
      await appendAuditLog(manager, {
        tenantId,
        actorId: actor.actorId,
        action: 'campaign.snapshot_superseded',
        entityType: 'campaign',
        entityId: campaign.id,
        traceId: actor.traceId,
        metadata: { snapshotId: snapshot.id },
      });

      return {
        campaignId: campaign.id,
        snapshotId: snapshot.id,
        status: 'draft',
        totalSnapshot: snapshot.totalSnapshot,
        sendableCount: snapshot.sendableCount,
        skippedCount: snapshot.skippedCount,
        frozenAt: snapshot.frozenAt.toISOString(),
        idempotencyReplayed: false,
      };
    });
  }

  /**
   * BR-SCH-004/007 and GAP-CMP-004: projects the authoritative sender,
   * template, audience, variable and quota checks into one report, then adds
   * non-blocking content/domain warnings without duplicating send policy.
   */
  private async buildScheduleValidationReport(
    manager: EntityManager,
    tenantId: string,
    campaign: CampaignEntity,
    webOrigin: LinkContext,
    audienceLimit: number,
  ): Promise<CampaignScheduleValidationReport> {
    const nameCheck: CampaignScheduleValidationReport['name'] = campaign.name.trim()
      ? { valid: true }
      : { valid: false, reason: 'CAMPAIGN_NAME_REQUIRED' };
    const subjectCheck: CampaignScheduleValidationReport['subject'] = campaign.subject.trim()
      ? { valid: true }
      : { valid: false, reason: 'CAMPAIGN_SUBJECT_REQUIRED' };
    const sender = campaign.senderJson;
    const senderConfig = sender.senderConfigId
      ? await new SenderConfigRepository(manager, tenantId).findActiveById(sender.senderConfigId)
      : null;
    const usability = checkSenderUsable(sender, senderConfig);
    const senderCheck: CampaignScheduleValidationReport['sender'] = usability.valid
      ? { valid: true }
      : { valid: false, reason: usability.reason };

    const templateCheck: CampaignScheduleValidationReport['template'] = campaign.templateVersionId
      ? { valid: true }
      : { valid: false, reason: 'TEMPLATE_MISSING' };

    const audience = campaign.audienceJson;
    const candidates = await new AudienceCandidatesRepository(manager, tenantId).findCandidates({
      listIds: audience.listIds ?? [],
      tagIds: audience.tagIds ?? [],
      recipientIds: audience.recipientIds ?? [],
      excludeListIds: audience.excludeListIds ?? [],
      excludeTagIds: audience.excludeTagIds ?? [],
      excludeRecipientIds: audience.excludeRecipientIds ?? [],
    });
    const resolution = resolveAudience(candidates, { sampleLimit: AUDIENCE_SAMPLE_LIMIT });
    const audienceCheck: CampaignScheduleValidationReport['audience'] = resolution.totalUnique === 0
      ? { valid: false, totalUnique: 0, reason: 'AUDIENCE_EMPTY' }
      : resolution.totalUnique > audienceLimit
        ? { valid: false, totalUnique: resolution.totalUnique, reason: 'AUDIENCE_OVER_LIMIT' }
        : { valid: true, totalUnique: resolution.totalUnique };
    const quotaUsage = await this.quota.usageFor(tenantId, manager);
    const quotaCheck: CampaignScheduleValidationReport['quota'] = quotaUsage.limit !== null && quotaUsage.used + resolution.totalUnique > quotaUsage.limit
      ? { valid: false, limit: quotaUsage.limit, used: quotaUsage.used, requested: resolution.totalUnique, reason: 'QUOTA_EXCEEDED' }
      : { valid: true, limit: quotaUsage.limit, used: quotaUsage.used, requested: resolution.totalUnique };

    let variablesCheck: CampaignScheduleValidationReport['variables'] = { valid: true, missingCount: 0, waiverStatus: 'none' };
    let contentWarnings: TemplateLintIssue[] = [];
    if (templateCheck.valid) {
      const policy = await computeCampaignVariableValidation(manager, tenantId, campaign, webOrigin);
      const waiver = campaign.settingsJson.audienceWaiver ?? null;
      const waiverStatus = computeAudienceWaiverStatus(waiver, policy.missingRecipientIds);
      variablesCheck = {
        valid: policy.missingCount === 0 || waiverStatus === 'valid',
        missingCount: policy.missingCount,
        waiverStatus,
      };
      const [version] = await manager.query(
        'SELECT html, text_body AS "textBody" FROM email_template_version WHERE tenant_id = $1 AND id = $2',
        [tenantId, campaign.templateVersionId],
      ) as Array<{ html: string; textBody: string }>;
      if (version) contentWarnings = lintTemplateContent(version);
    }

    return {
      blocking: !nameCheck.valid || !subjectCheck.valid || !senderCheck.valid || !templateCheck.valid || !audienceCheck.valid || !variablesCheck.valid || !quotaCheck.valid,
      name: nameCheck,
      subject: subjectCheck,
      sender: senderCheck,
      template: templateCheck,
      audience: audienceCheck,
      variables: variablesCheck,
      quota: quotaCheck,
      content: { valid: true, warnings: contentWarnings },
      domain: { valid: true, warnings: ['DOMAIN_READINESS_UNVERIFIED'] },
    };
  }

  /**
   * BR-SCH-001..005, BR-GEN-003, DEC-080/090/093. Shares freezeCampaignSnapshot
   * with sendCampaign (one freeze path, not two) via FreezeTarget. A
   * reschedule is this same route called on an already-'scheduled' campaign:
   * supersede the live snapshot and flip the campaign back to 'draft' first
   * inside this transaction -- touching only `status`, never the schedule
   * columns themselves -- then continue exactly as a fresh schedule
   * (DEC-090). campaign_no_edit_after_send()'s schedule guard permits only
   * draft->scheduled and scheduled->{cancelled,missed}; a direct
   * scheduled->scheduled in-place edit is what BR-SCH-005 exists to forbid.
   */
  async scheduleCampaign(
    tenantId: string,
    campaignId: string,
    idempotencyKey: string | undefined,
    body: CampaignScheduleRequestDto,
    actor: CampaignActor,
  ): Promise<CampaignScheduleAccepted> {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const repository = new CampaignsRepository(manager, tenantId);
      const initial = await repository.findActiveById(campaignId, true);
      if (!initial) throw new NotFoundException('Campaign was not found.');
      if (initial.status !== 'draft' && initial.status !== 'scheduled' && initial.status !== 'blocked') {
        throw new ConflictException('Campaign cannot be scheduled from its current status.');
      }
      let current: CampaignEntity = initial;
      // BR-SCH-009's recovery path ("owner picks a new sender and revalidates")
      // reuses the same supersede-then-flip-to-draft mechanism as a genuine
      // reschedule -- a blocked campaign also carries a live snapshot. The
      // lock window only applies to 'scheduled': a blocked campaign's due
      // instant is, by definition, already past, so the window's own
      // "close to due" test would otherwise always -- and wrongly -- refuse.
      const isReschedule = current.status === 'scheduled' || current.status === 'blocked';

      const lockWindowSeconds = this.config.get('SCHEDULE_LOCK_WINDOW_SECONDS', { infer: true });
      if (current.status === 'scheduled' && current.scheduledAtUtc) {
        if (current.scheduledAtUtc.getTime() - Date.now() <= lockWindowSeconds * 1000) {
          throw new ConflictException('Campaign schedule is locked and can no longer be changed.');
        }
      }

      const resolved = resolveLocalSchedule({ localDateTime: body.localDateTime, timeZone: body.timeZone, offsetMinutes: body.offsetMinutes });
      if ('code' in resolved) throw new UnprocessableEntityException(resolved);

      const minLeadSeconds = this.config.get('SCHEDULE_MIN_LEAD_SECONDS', { infer: true });
      const maxHorizonDays = this.config.get('SCHEDULE_MAX_HORIZON_DAYS', { infer: true });
      const nowMs = Date.now();
      const minAt = new Date(nowMs + minLeadSeconds * 1000);
      const maxAt = new Date(nowMs + maxHorizonDays * 24 * 60 * 60 * 1000);
      if (resolved.scheduledAtUtc < minAt || resolved.scheduledAtUtc > maxAt) {
        throw new UnprocessableEntityException({ code: 'OUT_OF_SCHEDULE_WINDOW', minAt: minAt.toISOString(), maxAt: maxAt.toISOString() });
      }

      const webOrigin = this.linkContext();
      const audienceLimit = this.config.get('CAMPAIGN_AUDIENCE_LIMIT', { infer: true });
      const payload = {
        campaignId: current.id,
        version: current.version,
        templateVersionId: current.templateVersionId,
        senderJson: current.senderJson,
        audienceJson: current.audienceJson,
        settingsJson: current.settingsJson,
        localDateTime: body.localDateTime,
        timeZone: body.timeZone,
        offsetMinutes: resolved.offsetMinutes,
      };

      const result = await this.idempotency.run(manager, tenantId, idempotencyKey, 'campaign_schedule', payload, async () => {
        const report = await this.buildScheduleValidationReport(manager, tenantId, current, webOrigin, audienceLimit);
        if (report.blocking) throw new UnprocessableEntityException(report);

        if (isReschedule) {
          const snapshotRepository = new CampaignSnapshotRepository(manager, tenantId);
          const liveSnapshot = await snapshotRepository.findLive(current.id);
          if (liveSnapshot) await snapshotRepository.supersede(liveSnapshot.id, new Date());
          current = await repository.save({ ...current, status: 'draft', version: current.version + 1, updatedBy: actor.actorId });
        }

        const frozen = await freezeCampaignSnapshot(manager, tenantId, current, actor, webOrigin, audienceLimit, {
          targetStatus: 'scheduled',
          scheduledAtUtc: resolved.scheduledAtUtc,
          scheduledTimezone: resolved.timeZone,
        });
        await this.quota.reserveForCampaign(manager, tenantId, current.id, frozen.snapshotId, frozen.sendableCount, actor);

        await appendAuditLog(manager, {
          tenantId,
          actorId: actor.actorId,
          action: isReschedule ? 'schedule.rescheduled' : 'schedule.created',
          entityType: 'campaign',
          entityId: current.id,
          traceId: actor.traceId,
          metadata: { snapshotId: frozen.snapshotId, scheduledAtUtc: resolved.scheduledAtUtc.toISOString(), timeZone: resolved.timeZone },
        });

        return {
          id: frozen.snapshotId,
          ...frozen,
          scheduledAtUtc: resolved.scheduledAtUtc.toISOString(),
          timeZone: resolved.timeZone,
          offsetMinutes: resolved.offsetMinutes,
          lockedAt: new Date().toISOString(),
        };
      });

      if (!result.replayed && current.createdBy) {
        await this.notifications.createForUsers(tenantId, {
          sourceEventId: `${isReschedule ? 'schedule.rescheduled' : 'schedule.created'}:${result.value.snapshotId}`,
          type: isReschedule ? 'schedule_rescheduled' : 'schedule_created',
          severity: 'success',
          title: isReschedule ? 'Lịch gửi đã cập nhật' : 'Chiến dịch đã được lên lịch',
          body: `${current.name} sẽ gửi lúc ${result.value.scheduledAtUtc} (${result.value.timeZone}).`,
          category: 'campaign',
          userIds: [current.createdBy],
          messageKey: isReschedule ? 'schedule.rescheduled' : 'schedule.created',
          entityType: 'campaign',
          entityId: current.id,
          deepLinkRoute: `/campaigns/${current.id}`,
        });
      }

      const { id: _snapshotEntityId, status, ...frozen } = result.value;
      return { ...frozen, status: status as 'scheduled', idempotencyReplayed: result.replayed };
    });
  }

  /**
   * BR-SCH-008. A separate route/method from cancelCampaign (DEC-091): a
   * cancelled *schedule* is terminal ('cancelled'), unlike M4-S4's
   * cancel-to-refresh which legitimately returns to 'draft'. Also respects
   * BR-SCH-005's lock window -- the same 2-minute boundary that guards
   * reschedule guards cancellation too.
   */
  async cancelCampaignSchedule(tenantId: string, campaignId: string, actor: CampaignActor): Promise<CampaignScheduleCancelAccepted> {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const repository = new CampaignsRepository(manager, tenantId);
      const campaign = await repository.findActiveById(campaignId, true);
      if (!campaign) throw new NotFoundException('Campaign was not found.');
      if (campaign.status !== 'scheduled') throw new ConflictException('Campaign cannot be cancelled unless it is scheduled.');

      const lockWindowSeconds = this.config.get('SCHEDULE_LOCK_WINDOW_SECONDS', { infer: true });
      if (campaign.scheduledAtUtc && campaign.scheduledAtUtc.getTime() - Date.now() <= lockWindowSeconds * 1000) {
        throw new ConflictException('Campaign schedule is locked and can no longer be cancelled.');
      }

      const snapshotRepository = new CampaignSnapshotRepository(manager, tenantId);
      const snapshot = await snapshotRepository.findLive(campaign.id);
      if (snapshot) await snapshotRepository.supersede(snapshot.id, new Date());
      await repository.save({
        ...campaign,
        status: 'cancelled',
        scheduledAtUtc: null,
        scheduledTimezone: null,
        version: campaign.version + 1,
        updatedBy: actor.actorId,
      });
      await this.quota.releaseForCampaign(manager, tenantId, campaign.id);
      await appendAuditLog(manager, {
        tenantId,
        actorId: actor.actorId,
        action: 'schedule.cancelled',
        entityType: 'campaign',
        entityId: campaign.id,
        traceId: actor.traceId,
        metadata: { snapshotId: snapshot?.id ?? null },
      });
      if (campaign.createdBy) {
        await this.notifications.createForUsers(tenantId, {
          sourceEventId: `schedule.cancelled:${campaign.id}:${campaign.version + 1}`,
          type: 'schedule_cancelled',
          severity: 'success',
          title: 'Lịch gửi đã hủy',
          body: `${campaign.name} đã được hủy lịch gửi.`,
          category: 'campaign',
          userIds: [campaign.createdBy],
          messageKey: 'schedule.cancelled',
          entityType: 'campaign',
          entityId: campaign.id,
          deepLinkRoute: `/campaigns/${campaign.id}`,
        });
      }

      return { campaignId: campaign.id, status: 'cancelled' };
    });
  }

  /** GET surface for the frozen banner (BR-CF-008) and the "did it actually stay the same" evidence CP4 needs. */
  async getCampaignSnapshot(tenantId: string, campaignId: string): Promise<CampaignSnapshotView> {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const campaign = await new CampaignsRepository(manager, tenantId).findActiveById(campaignId);
      if (!campaign) throw new NotFoundException('Campaign was not found.');

      const snapshotRepository = new CampaignSnapshotRepository(manager, tenantId);
      const snapshot = await snapshotRepository.findLive(campaign.id);
      if (!snapshot) throw new NotFoundException('No live snapshot found for this campaign.');
      const skippedByReason = await snapshotRepository.skippedByReason(snapshot.id);

      return {
        id: snapshot.id,
        campaignId: snapshot.campaignId,
        templateVersionId: snapshot.templateVersionId,
        sender: snapshot.senderJson,
        audienceQuery: snapshot.audienceQueryJson,
        policyResult: snapshot.policyResultJson,
        configuredVariableValues: snapshot.configuredVariableValuesJson,
        totalSnapshot: snapshot.totalSnapshot,
        sendableCount: snapshot.sendableCount,
        skippedCount: snapshot.skippedCount,
        frozenAt: snapshot.frozenAt.toISOString(),
        supersededAt: snapshot.supersededAt?.toISOString() ?? null,
        skippedByReason,
      };
    });
  }

  /**
   * BR-HIS-001. Reuses the stored 028 progress summary (never recomputes)
   * and the existing progress-math rollups -- no third count implementation.
   * BR-HIS-004: a row with no execution (e.g. a merely-scheduled campaign)
   * gets `progress: null`, not a zeroed object, so "no progress before
   * start" falls out of the data model rather than being special-cased.
   */
  async listHistory(tenantId: string, query: HistoryListQueryDto, actor: CampaignActor) {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      // ADR-034: the list may include drafts, so it needs the same ownership
      // facts assertDraftAccess uses -- content:manage to see any draft at
      // all, admin+settings:manage to see other people's.
      const viewer: CampaignListViewer = {
        actorId: actor.actorId,
        canManageContent: actor.permissions?.includes('content:manage') ?? false,
        canManageAllDrafts: this.canManageAllDrafts(actor),
      };
      const { sql, params } = buildHistoryListSql(query, tenantId, viewer);
      const rows = (await manager.query(sql, params)) as HistoryListRow[];

      const executionIds = [...new Set(rows.map((row) => row.executionId).filter((id): id is string => Boolean(id)))];
      const progressByExecution = new Map<string, HistoryProgressRow>();
      if (executionIds.length > 0) {
        const progressSql = buildHistoryProgressSql(executionIds, tenantId);
        const progressRows = (await manager.query(progressSql.sql, progressSql.params)) as HistoryProgressRow[];
        for (const row of progressRows) progressByExecution.set(row.executionId, row);
      }

      const items = rows.map((row) => {
        const sortIso = new Date(row.sortValue).toISOString();
        const cursor = encodeCursor(sortIso, row.id);
        const progressRow = row.executionId ? progressByExecution.get(row.executionId) : undefined;
        let progress: {
          executionStatus: string; totalSnapshot: number; percent: number;
          sent: number; delivered: number; failed: number; pending: number;
        } | null = null;
        if (progressRow) {
          const counts: ProgressCounts = {
            pending: progressRow.pendingCount, queued: progressRow.queuedCount, submitted: progressRow.submittedCount,
            delivered: progressRow.deliveredCount, bounced: progressRow.bouncedCount, failed: progressRow.failedCount,
            skipped: progressRow.skippedCount, cancelled: progressRow.cancelledCount,
          };
          const rollups = rollupCounts(counts);
          progress = {
            executionStatus: progressRow.executionStatus,
            totalSnapshot: progressRow.totalSnapshot,
            percent: progressPercent(counts, progressRow.sendableCount),
            sent: rollups.sent,
            delivered: rollups.delivered,
            failed: rollups.failed,
            pending: rollups.queued,
          };
        }
        return {
          id: row.id,
          name: row.name,
          subject: row.subject,
          status: row.status,
          scheduledAtUtc: row.scheduledAtUtc ? new Date(row.scheduledAtUtc).toISOString() : null,
          scheduledTimezone: row.scheduledTimezone,
          createdAt: new Date(row.createdAt).toISOString(),
          createdBy: row.createdBy,
          executionId: row.executionId,
          startedAt: row.startedAt ? new Date(row.startedAt).toISOString() : null,
          finishedAt: row.finishedAt ? new Date(row.finishedAt).toISOString() : null,
          senderConfigId: row.senderConfigId,
          progress,
          cursor,
        };
      });

      const last = items.at(-1);
      const nextCursor = rows.length === query.limit && last ? last.cursor : null;
      return { serverTime: new Date().toISOString(), items, nextCursor };
    });
  }

  async listHistoryRecipients(tenantId: string, campaignId: string, query: HistoryRecipientsQueryDto) {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const campaign = await new CampaignsRepository(manager, tenantId).findActiveById(campaignId);
      if (!campaign) throw new NotFoundException('Campaign was not found.');
      const built = buildHistoryRecipientsSql(query, tenantId, campaignId);
      const rows = (await manager.query(built.sql, built.params)) as HistoryRecipientRow[];
      const hasMore = rows.length > query.limit;
      const visible = hasMore ? rows.slice(0, query.limit) : rows;
      return {
        items: visible.map((row) => ({
          ...row,
          lastAttemptAt: row.lastAttemptAt ? new Date(row.lastAttemptAt).toISOString() : null,
          submittedAt: row.submittedAt ? new Date(row.submittedAt).toISOString() : null,
          deliveredAt: row.deliveredAt ? new Date(row.deliveredAt).toISOString() : null,
          nextRetryAt: row.nextRetryAt ? new Date(row.nextRetryAt).toISOString() : null,
          updatedAt: new Date(row.updatedAt).toISOString(),
        })),
        nextCursor: hasMore && visible.length > 0 ? encodeRecipientCursor(visible.at(-1)!.email, visible.at(-1)!.id) : null,
      };
    });
  }
}
