import './observability/instrumentation.js';
import { randomUUID } from 'node:crypto';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import pg from 'pg';
import { BULK_JOB_NAME, BULK_QUEUE, processBulkJob } from './bulk-processor.js';
import { scanDueCampaigns } from './campaign-dispatcher.js';
import { scanQueuedCampaigns } from './campaign-send/run.js';
import { IMPORT_JOB_NAME, IMPORT_QUEUE, processImportJob } from './import-processor.js';
import { relayUnpublishedBulkEvents, relayUnpublishedImportEvents } from './outbox-relay.js';
import { createRedisJobEventPublisher } from './redis-job-event-publisher.js';
import { createRedisCampaignEventPublisher } from './redis-campaign-event-publisher.js';
import { createRedisUserEventPublisher } from './redis-user-event-publisher.js';
import { reconcileProgress } from './progress-reconcile.js';
import { processExportJob } from './export-processor.js';
import { purgeHistoryEvents } from './history-purge.js';
import { historyRetentionDefaultDays } from './retention-window.js';
import { purgeExpiredExportArtifacts } from './export-purge.js';
import { runWithJobContext } from './observability/job-context.js';
import { workerLogger } from './observability/logger.js';
const SCHEDULE_MISFIRE_GRACE_SECONDS = Number(process.env.SCHEDULE_MISFIRE_GRACE_SECONDS ?? 900);
const CAMPAIGN_SEND_BATCH_SIZE = Number(process.env.CAMPAIGN_SEND_BATCH_SIZE ?? 100);
const connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest:null });
const publishJobEvent = createRedisJobEventPublisher(connection);
const publishCampaignEvent = createRedisCampaignEventPublisher(connection);
const publishUserEvent = createRedisUserEventPublisher(connection);
const campaignQueue = new Queue('campaign-execution', { connection });
const importQueue = new Queue(IMPORT_QUEUE, { connection });
const bulkQueue = new Queue(BULK_QUEUE, { connection });
async function recordQueueLag(queue: Queue, name: string): Promise<void> {
  const jobs = await queue.getJobs(['wait', 'delayed'], 0, 0, true);
  const oldest = jobs[0];
  const seconds = oldest ? Math.max(0, (Date.now() - oldest.timestamp) / 1000) : 0;
  const { jobMetrics } = await import('./observability/job-metrics.js');
  jobMetrics.queueLagSeconds(name, seconds);
}
const worker = new Worker('campaign-execution', async job => {
  return runWithJobContext({
    traceId: typeof job.data?.traceId === 'string' ? job.data.traceId : randomUUID(),
    tenantId: typeof job.data?.tenantId === 'string' ? job.data.tenantId : null,
    jobName: job.name,
    jobId: job.id ?? null,
    campaignId: typeof job.data?.campaignId === 'string' ? job.data.campaignId : null,
  }, async () => {
  workerLogger.info({ event: 'job.started' }, 'job.started');
  await Promise.all([
    recordQueueLag(campaignQueue, 'campaign-execution'),
    recordQueueLag(importQueue, IMPORT_QUEUE),
    recordQueueLag(bulkQueue, BULK_QUEUE),
  ]);
  switch(job.name){
    case 'campaign-misfire-scan': {
      const databaseUrl = process.env.OUTBOX_DATABASE_URL;
      if (!databaseUrl) throw new Error('OUTBOX_DATABASE_URL is required for the narrow cross-tenant campaign dispatch scan. Owner/superuser credentials are forbidden.');
      const results = await scanDueCampaigns(databaseUrl, SCHEDULE_MISFIRE_GRACE_SECONDS);
      return { dispatched: results.filter(r => r.outcome === 'dispatched').length, missed: results.filter(r => r.outcome === 'missed').length, blocked: results.filter(r => r.outcome === 'blocked').length };
    }
    case 'campaign-send-scan': {
      // M5-S3 CP3 (BR-SEND-001, D-87). Same narrow OUTBOX_DATABASE_URL
      // boundary as campaign-misfire-scan: a cross-tenant sweep for queued
      // campaigns, re-entering a tenant transaction per campaign for the
      // actual validate/freeze/partition work (SS3.4/DEC-102). Replaces the
      // 'validate'/'snapshot'/'send-batch'/'aggregate'/'notify' stub cases
      // that used to live here -- nothing ever enqueued those job names
      // (verified: only campaign-misfire-scan/outbox-publish/
      // progress-reconcile are enqueued by apps/scheduler), so they were
      // pure fabricated-success dead code (D-87), not a contract to honour.
      const databaseUrl = process.env.OUTBOX_DATABASE_URL;
      if (!databaseUrl) throw new Error('OUTBOX_DATABASE_URL is required for the narrow cross-tenant campaign send scan. Owner/superuser credentials are forbidden.');
      const results = await scanQueuedCampaigns(databaseUrl, process.env.REDIS_URL ?? 'redis://localhost:6379', CAMPAIGN_SEND_BATCH_SIZE, publishCampaignEvent);
      return {
        sent: results.filter(r => r.outcome === 'sent').length,
        completed: results.filter(r => r.outcome === 'completed' || r.outcome === 'completed_empty').length,
        partialFailed: results.filter(r => r.outcome === 'partial_failed').length,
        failed: results.filter(r => r.outcome === 'failed').length,
      };
    }
    case 'outbox-publish': {
      const databaseUrl = process.env.OUTBOX_DATABASE_URL;
      if (!databaseUrl) throw new Error('OUTBOX_DATABASE_URL is required for the narrow cross-tenant outbox relay boundary. Owner/superuser credentials are forbidden.');
      return {
        importEventsPublished: await relayUnpublishedImportEvents(databaseUrl, importQueue),
        bulkEventsPublished: await relayUnpublishedBulkEvents(databaseUrl, bulkQueue),
      };
    }
    case 'progress-reconcile': {
      // M6-S1 CP9 (BR-HIS-008, ADR-026). Same narrow OUTBOX_DATABASE_URL
      // boundary as every other cross-tenant scan on this worker: an
      // unlocked SELECT over reconcilable_campaign_executions() decides
      // which executions to visit, then a tenant transaction per execution
      // repairs campaign_recipient from the delivery_event ledger and
      // corrects the stored campaign_execution summary -- D-115: this case
      // was a fabricated-success stub (`{reconcileAccepted:true}`) reporting
      // success once per tick while doing nothing, the same class of defect
      // as D-87.
      const databaseUrl = process.env.OUTBOX_DATABASE_URL;
      if (!databaseUrl) throw new Error('OUTBOX_DATABASE_URL is required for the narrow cross-tenant progress reconciliation scan. Owner/superuser credentials are forbidden.');
      const results = await reconcileProgress(databaseUrl, publishCampaignEvent);
      return { executionsScanned: results.length, executionsRepaired: results.filter(r => r.drift > 0 || r.repairedRecipients > 0).length };
    }
    case 'export-scan': {
      // M6-S3 CP8 (BR-HIS-003, ADR-027). Same narrow OUTBOX_DATABASE_URL
      // boundary as every other cross-tenant scan on this worker: an
      // unlocked SELECT over queued_export_jobs() decides which jobs to
      // visit, then a tenant transaction per job does the actual render.
      // No dedicated BullMQ queue is needed -- a queued export_job row is
      // itself the durable work item, the same shape campaign-send-scan
      // already established for queued campaigns.
      const databaseUrl = process.env.OUTBOX_DATABASE_URL;
      if (!databaseUrl) throw new Error('OUTBOX_DATABASE_URL is required for the narrow cross-tenant export scan. Owner/superuser credentials are forbidden.');
      const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
      let due: { rows: Array<{ id: string; tenant_id: string }> };
      try {
        due = await pool.query(`SELECT id, tenant_id FROM queued_export_jobs($1)`, [100]);
      } finally {
        await pool.end();
      }
      for (const row of due.rows) await processExportJob(databaseUrl, row.tenant_id, row.id, publishJobEvent, publishUserEvent);
      return { exportsProcessed: due.rows.length };
    }
    case 'history-purge-scan': {
      // M6-S4 (BR-HIS-006, DEC-140/141/142). Same narrow OUTBOX_DATABASE_URL
      // boundary as every other cross-tenant scan on this worker: an
      // unlocked SELECT over purgeable_retention_tenants() decides which
      // tenants are past their own window, then a tenant transaction per
      // tenant deletes detail rows through purge_message_events() and
      // writes the one audit row that outlives them.
      const databaseUrl = process.env.OUTBOX_DATABASE_URL;
      if (!databaseUrl) throw new Error('OUTBOX_DATABASE_URL is required for the narrow cross-tenant history retention scan. Owner/superuser credentials are forbidden.');
      const results = await purgeHistoryEvents(databaseUrl, historyRetentionDefaultDays(process.env.HISTORY_EVENT_RETENTION_DAYS));
      return {
        tenantsPurged: results.length,
        messageAttemptsDeleted: results.reduce((sum, row) => sum + row.messageAttemptsDeleted, 0),
        deliveryEventsDeleted: results.reduce((sum, row) => sum + row.deliveryEventsDeleted, 0),
      };
    }
    case 'export-artifact-purge-scan': {
      // D-131: export_job.expires_at (029) already gates *download*, but
      // nothing ever cleared artifact_bytes once an export passed its own
      // expiry. Same narrow OUTBOX_DATABASE_URL boundary as every other
      // cross-tenant scan on this worker: an unlocked SELECT over
      // expired_export_artifacts() decides which rows to visit, then a
      // tenant transaction per row clears the bytea payload and audits it.
      // Driven by EXPORT_ARTIFACT_TTL_HOURS, not by HISTORY_EVENT_RETENTION_DAYS
      // -- a distinct scan from history-purge-scan on purpose.
      const databaseUrl = process.env.OUTBOX_DATABASE_URL;
      if (!databaseUrl) throw new Error('OUTBOX_DATABASE_URL is required for the narrow cross-tenant export artifact purge scan. Owner/superuser credentials are forbidden.');
      const results = await purgeExpiredExportArtifacts(databaseUrl);
      return { artifactsCleared: results.length };
    }
    default: throw new Error(`Unknown job ${job.name}`);
  }
  });
}, { connection, concurrency:Number(process.env.WORKER_CONCURRENCY ?? 10), lockDuration:300_000, maxStalledCount:2 });
const importWorker = new Worker(IMPORT_QUEUE, async job => {
  return runWithJobContext({
    traceId: typeof job.data?.traceId === 'string' ? job.data.traceId : randomUUID(),
    tenantId: typeof job.data?.tenantId === 'string' ? job.data.tenantId : null,
    jobName: job.name,
    jobId: job.id ?? null,
  }, async () => {
  if (job.name !== IMPORT_JOB_NAME || typeof job.data?.jobId !== 'string' || typeof job.data?.tenantId !== 'string') {
    throw new Error(`Unknown import job ${job.name}`);
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required for import processing.');
  await processImportJob(databaseUrl, job.data.tenantId, job.data.jobId, publishJobEvent, publishUserEvent);
  return { jobId: job.data.jobId, processed: true };
  });
}, { connection, concurrency:Number(process.env.WORKER_CONCURRENCY ?? 10), lockDuration:300_000, maxStalledCount:2 });
const bulkWorker = new Worker(BULK_QUEUE, async job => {
  return runWithJobContext({
    traceId: typeof job.data?.traceId === 'string' ? job.data.traceId : randomUUID(),
    tenantId: typeof job.data?.tenantId === 'string' ? job.data.tenantId : null,
    jobName: job.name,
    jobId: job.id ?? null,
  }, async () => {
  if (job.name !== BULK_JOB_NAME || typeof job.data?.jobId !== 'string' || typeof job.data?.tenantId !== 'string') {
    throw new Error(`Unknown bulk job ${job.name}`);
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required for bulk processing.');
  await processBulkJob(databaseUrl, job.data.tenantId, job.data.jobId, publishJobEvent, publishUserEvent);
  return { jobId: job.data.jobId, processed: true };
  });
}, { connection, concurrency:Number(process.env.WORKER_CONCURRENCY ?? 10), lockDuration:300_000, maxStalledCount:2 });
const shutdown=async()=>{await Promise.all([worker.close(), importWorker.close(), bulkWorker.close(), campaignQueue.close(), importQueue.close(), bulkQueue.close()]);await connection.quit();process.exit(0);};
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
