// Dev/e2e-only fixture: drives a real, already-frozen ('queued') campaign
// through the actual validate/partition/send/aggregate DAG (not a raw
// status UPDATE) so apps/web/e2e's visual-capture scenarios can reach
// 'sending'/'completed'/'partial_failed'/'failed' on demand -- states no
// HTTP endpoint can produce directly (M5-S3 owns the transition, not the
// API surface). apps/worker has no NestJS/TypeORM decorators, so unlike
// apps/api/scripts/seed-demo-user.mjs this can run straight against the
// .ts sources under tsx (no emitDecoratorMetadata gap).
import { config } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, '../../../.env'), quiet: true });

const pgUser = process.env.EOW_POSTGRES_USER ?? 'eow';
const pgAppPassword = process.env.EOW_POSTGRES_APP_PASSWORD;
const pgDb = process.env.EOW_POSTGRES_DB ?? 'eow';
const pgBind = process.env.EOW_POSTGRES_BIND ?? '127.0.0.1';
const pgPort = process.env.EOW_POSTGRES_PORT ?? '55432';
const databaseUrl = `postgresql://eow_app:${pgAppPassword}@${pgBind}:${pgPort}/${pgDb}`;
const redisPassword = process.env.EOW_REDIS_PASSWORD;
const redisBind = process.env.EOW_REDIS_BIND ?? '127.0.0.1';
const redisPort = process.env.EOW_REDIS_PORT ?? '56379';
const redisUrl = `redis://:${encodeURIComponent(redisPassword)}@${redisBind}:${redisPort}/0`;
const mailpitHost = process.env.EOW_MAILPIT_BIND ?? '127.0.0.1';
const mailpitSmtpPort = Number(process.env.EOW_MAILPIT_SMTP_PORT ?? 1025);
process.env.SMTP_HOST = mailpitHost;
process.env.SMTP_PORT = String(mailpitSmtpPort);

const { runValidation } = await import('../src/campaign-send/validate.ts');
const { partitionBatch } = await import('../src/campaign-send/partition.ts');
const { sendClaimedBatch } = await import('../src/campaign-send/send.ts');
const { aggregateExecution } = await import('../src/campaign-send/aggregate.ts');
const { publishProgressSnapshot } = await import('../src/campaign-send/progress-snapshot.ts');

const [, , campaignId, targetState, failEmailPrefix] = process.argv;
if (!campaignId || !targetState) {
  console.error('usage: seed-campaign-send-fixture.mjs <campaignId> <sending|completed|partial_failed|failed> [failEmailPrefix]');
  process.exit(2);
}

const ownerPool = new pg.Pool({
  connectionString: `postgresql://${pgUser}:${process.env.EOW_POSTGRES_PASSWORD}@${pgBind}:${pgPort}/${pgDb}`,
});
const [campaign] = (await ownerPool.query('SELECT tenant_id FROM campaign WHERE id = $1', [campaignId])).rows;
if (!campaign) throw new Error(`Campaign ${campaignId} not found.`);
const tenantId = campaign.tenant_id;
await ownerPool.end();

const failingSend = async (message) => {
  if (failEmailPrefix && message.to.startsWith(failEmailPrefix)) {
    throw { responseCode: 552, response: '552 5.2.3 Message too large (visual fixture failure)' };
  }
  const nodemailer = (await import('nodemailer')).default;
  // Mailpit's published host port, not `message.host`. The DAG hands us the
  // campaign's own sender_config host, which under the packaged stack is the
  // compose service name `mailpit` -- resolvable from the api/worker
  // containers, never from this script, which runs on the host. That is the
  // same override the SMTP_HOST/SMTP_PORT lines at the top of this file
  // already make for the no-sender-config path; the draft fixtures in
  // apps/web/e2e now always carry a verified senderConfigId (the composer
  // refuses to confirm a send without one), so they take the other branch.
  const transport = nodemailer.createTransport({ host: mailpitHost, port: mailpitSmtpPort, secure: false });
  try {
    const info = await transport.sendMail({ from: { name: message.from.name, address: message.from.email }, to: message.to, subject: message.subject, html: message.html, text: message.text, messageId: message.messageId });
    return { providerMessageId: info.messageId };
  } finally {
    transport.close();
  }
};

const validation = await runValidation(databaseUrl, tenantId, campaignId);
if (validation.result !== 'validated') throw new Error(`Unexpected validation result: ${JSON.stringify(validation)}`);
const { executionId } = validation;

// M6-S3 (found capturing this node's own visual evidence, not
// pre-registered): publishProgressSnapshot's own first line is
// `if (!publish) return;` -- it is the ONLY place that writes
// campaign_execution's migration-028 stored counter columns
// (pending_count/delivered_count/etc), so calling sendClaimedBatch/
// aggregateExecution alone, the way this script always had, leaves those
// columns at their table default of 0 forever, regardless of the real
// campaign_recipient facts. apps/worker/src/campaign-send/run.ts's own
// production orchestrator never hits this gap -- its "mandatory flush"
// after aggregate always passes a real Redis publisher -- so no shipped
// runtime path was ever affected; this script (dev/e2e-only) just never
// replicated that flush. A no-op publish function is enough: it only
// needs to be non-null to clear the early-return guard.
const flushPool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
const noopPublish = async () => {};

if (targetState === 'sending') {
  // Partition claims the whole batch into 'queued', then send only the
  // first half -- the rest stays genuinely 'pending'/'queued', so the
  // campaign is left mid-flight rather than faked.
  await partitionBatch(databaseUrl, tenantId, campaignId, executionId, 100);
  const totalRows = (await new pg.Pool({ connectionString: databaseUrl }).query(
    'SELECT count(*)::int AS count FROM campaign_recipient WHERE tenant_id = $1 AND execution_id = $2', [tenantId, executionId],
  )).rows[0].count;
  await sendClaimedBatch(databaseUrl, redisUrl, tenantId, campaignId, executionId, Math.max(1, Math.floor(totalRows / 2)), failingSend);
  await publishProgressSnapshot(flushPool, tenantId, campaignId, executionId, noopPublish);
} else {
  await partitionBatch(databaseUrl, tenantId, campaignId, executionId, 100);
  await sendClaimedBatch(databaseUrl, redisUrl, tenantId, campaignId, executionId, 100, failingSend);
  const outcome = await aggregateExecution(databaseUrl, tenantId, campaignId, executionId);
  if (outcome.result !== targetState) throw new Error(`Expected aggregate result '${targetState}', got '${outcome.result}'.`);
  await publishProgressSnapshot(flushPool, tenantId, campaignId, executionId, noopPublish);
}
await flushPool.end();

console.log(JSON.stringify({ campaignId, executionId, targetState }));
