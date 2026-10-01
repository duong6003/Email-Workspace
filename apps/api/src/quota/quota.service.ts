import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import { TooManyRequestsException } from '../common/too-many-requests.exception.js';
import { runInTenantContext, setTenantContext } from '../database/tenant-transaction.js';
import { appendOutboxEvent } from '../outbox/outbox-writer.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { buildQuotaThresholdEvent } from './quota-event.js';
import { quotaUsageRatioMetric } from './quota-metrics.js';
import { QuotaOrgPublisher } from './quota-org-publisher.js';
import { periodKeyFor } from './quota-period.js';
import { QuotaRepository, type ReserveOutcome } from './quota.repository.js';
import { crossedThresholds } from './quota-threshold.js';

type Actor = { actorId: string | null; traceId?: string };

function retryAfterPeriod(period: 'day' | 'month', now = new Date()): number {
  const next = period === 'day'
    ? Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
    : Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

@Injectable()
export class QuotaService {
  private readonly logger = new Logger(QuotaService.name);
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly notifications: NotificationsService,
    private readonly publisher: QuotaOrgPublisher,
  ) {}

  async reserveForCampaign(manager: EntityManager | null, tenantId: string, campaignId: string, snapshotId: string | null, amount: number, actor: Actor): Promise<ReserveOutcome> {
    const work = async (transaction: EntityManager): Promise<ReserveOutcome> => {
      const repository = new QuotaRepository(transaction);
      const config = await repository.lockConfig(tenantId);
      const periodKey = periodKeyFor(new Date(), config.period);
      const outcome = await repository.reserve(tenantId, campaignId, snapshotId, periodKey, amount);
      if (!outcome.admitted) {
        throw new TooManyRequestsException({ message: 'Sending quota exceeded.', code: 'QUOTA_EXCEEDED' }, retryAfterPeriod(config.period));
      }
      if (outcome.limit !== null) {
        for (const threshold of crossedThresholds(outcome.usedBefore, outcome.usedAfter, outcome.limit)) {
          if (!(await repository.claimThreshold(tenantId, periodKey, threshold))) continue;
          const envelope = buildQuotaThresholdEvent({ tenantId, periodKey, threshold, used: outcome.usedAfter, limit: outcome.limit, campaignId, traceId: actor.traceId });
          await appendOutboxEvent(transaction, {
            tenantId, eventType: 'quota.threshold_reached', aggregateType: 'quota', aggregateId: tenantId,
            aggregateVersion: BigInt(threshold), payload: envelope.data,
          });
          const userRows = await transaction.query(
            `SELECT DISTINCT u.id::text AS id
             FROM app_user u
             JOIN user_role ur ON ur.user_id = u.id AND ur.tenant_id = u.tenant_id
             JOIN role_permission rp ON rp.role_id = ur.role_id
             JOIN permission p ON p.id = rp.permission_id AND p.key = 'notification:read'
             LEFT JOIN notification_preference np ON np.tenant_id = u.tenant_id AND np.user_id = u.id AND np.category = 'quota'
             WHERE u.tenant_id = $1 AND u.status = 'active' AND np.enabled IS DISTINCT FROM false`,
            [tenantId],
          ) as Array<{ id: string }>;
          await this.notifications.createForUsers(tenantId, {
            sourceEventId: `quota.threshold_reached:${periodKey}:${threshold}`,
            type: 'quota_threshold', severity: 'warning', category: 'quota', userIds: userRows.map((row) => row.id),
            title: `Sending quota reached ${threshold}%`, body: `${outcome.usedAfter} of ${outcome.limit} messages reserved.`,
            messageKey: 'quota.threshold_reached', params: { threshold, used: outcome.usedAfter, limit: outcome.limit, periodKey },
            entityType: 'campaign', entityId: campaignId, deepLinkRoute: `/campaigns/${campaignId}`,
          });
          await this.publisher.publish(tenantId, envelope);
        }
      }
      this.logger.log(quotaUsageRatioMetric({ tenantId, periodKey, used: outcome.usedAfter, limit: outcome.limit, campaignId }));
      return outcome;
    };
    if (manager) {
      await setTenantContext(manager, tenantId);
      return work(manager);
    }
    return runInTenantContext(this.dataSource, tenantId, work);
  }

  async releaseForCampaign(manager: EntityManager | null, tenantId: string, campaignId: string): Promise<number> {
    return this.withRepository(manager, tenantId, async (repository) => {
      const config = await repository.lockConfig(tenantId);
      return repository.release(tenantId, campaignId, periodKeyFor(new Date(), config.period));
    });
  }

  async releasePartialForCampaign(manager: EntityManager | null, tenantId: string, campaignId: string, keepConsumed: number): Promise<number> {
    return this.withRepository(manager, tenantId, async (repository) => {
      const config = await repository.lockConfig(tenantId);
      return repository.releasePartial(tenantId, campaignId, periodKeyFor(new Date(), config.period), keepConsumed);
    });
  }

  async usageFor(tenantId: string, existingManager?: EntityManager) {
    const read = async (manager: EntityManager) => {
      const repository = new QuotaRepository(manager);
      const config = await repository.getConfig(tenantId);
      const periodKey = periodKeyFor(new Date(), config.period);
      const used = await repository.usedInPeriod(tenantId, periodKey);
      return { limit: config.limit, period: config.period, periodKey, used, ratio: config.limit === null ? null : used / config.limit };
    };
    if (existingManager) {
      await setTenantContext(existingManager, tenantId);
      return read(existingManager);
    }
    return runInTenantContext(this.dataSource, tenantId, read);
  }

  async configFor(tenantId: string) {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const config = await new QuotaRepository(manager).lockConfig(tenantId);
      return { limit: config.limit, period: config.period };
    });
  }

  async updateConfig(tenantId: string, input: { limit: number | null; period: 'day' | 'month' }, actor: Actor) {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const [row] = await manager.query(
        `INSERT INTO sending_policy (tenant_id, send_quota_limit, send_quota_period, updated_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id) DO UPDATE SET
           send_quota_limit = EXCLUDED.send_quota_limit,
           send_quota_period = EXCLUDED.send_quota_period,
           updated_by = EXCLUDED.updated_by,
           updated_at = now()
         RETURNING send_quota_limit, send_quota_period`,
        [tenantId, input.limit, input.period, actor.actorId],
      ) as Array<{ send_quota_limit: number | null; send_quota_period: 'day' | 'month' }>;
      return { limit: row!.send_quota_limit, period: row!.send_quota_period };
    });
  }

  private async withRepository<T>(manager: EntityManager | null, tenantId: string, work: (repository: QuotaRepository) => Promise<T>): Promise<T> {
    if (manager) { await setTenantContext(manager, tenantId); return work(new QuotaRepository(manager)); }
    return runInTenantContext(this.dataSource, tenantId, async (transaction) => work(new QuotaRepository(transaction)));
  }
}
