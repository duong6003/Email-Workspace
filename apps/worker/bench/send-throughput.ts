/**
 * Send-path throughput benchmark (audit evidence, not a test).
 *
 * Seeds one campaign with N frozen recipients and drives the REAL worker code
 * (`sendClaimedBatch` / `scanQueuedCampaigns`) against PostgreSQL, Redis and an
 * SMTP sink (Mailpit), optionally through a TCP proxy that adds network latency
 * so the per-message SMTP handshake cost of a real provider becomes visible.
 *
 * Run from apps/worker with the same .env the integration tests use:
 *   pnpm exec tsx bench/send-throughput.ts
 * Env knobs: BENCH_N (default 300), BENCH_LATENCY_MS (one-way, default 0),
 * BENCH_SMTP_PORT (default 1025), BENCH_HTML_KB (default 20).
 */
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import pg from 'pg';
import nodemailer from 'nodemailer';
import { sendClaimedBatch, sendTransportOptions, type SmtpSendFn } from '../src/campaign-send/send.js';
import { scanQueuedCampaigns } from '../src/campaign-send/run.js';
import { testAppDatabaseUrl, testOwnerDatabaseUrl, testRedisUrl } from '../src/test-urls.js';
import { purgeCampaignSendFixtures } from '../src/test-cleanup-helpers.js';

const N = Number(process.env.BENCH_N ?? 300);
const LATENCY_MS = Number(process.env.BENCH_LATENCY_MS ?? 0);
const SMTP_PORT = Number(process.env.BENCH_SMTP_PORT ?? 1025);
const HTML_KB = Number(process.env.BENCH_HTML_KB ?? 20);

/**
 * nodemailer never calls setNoDelay(), so the small "\r\n.\r\n" write that ends
 * DATA waits on Nagle until the server's delayed ACK (~40 ms on Linux). This
 * toggle patches every socket the process opens, to measure what the fix buys.
 */
let forceNoDelay = false;
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function patchedConnect(this: net.Socket, ...args: unknown[]) {
  if (forceNoDelay) this.setNoDelay(true);
  return (originalConnect as (...a: unknown[]) => net.Socket).apply(this, args);
} as typeof net.Socket.prototype.connect;

const owner = new pg.Pool({ connectionString: testOwnerDatabaseUrl(), max: 4 });

/** One-way delay on every chunk, both directions: a crude but honest RTT model. */
async function startLatencyProxy(targetPort: number, delayMs: number): Promise<{ port: number; close(): void }> {
  const server = net.createServer((client) => {
    const upstream = net.connect(targetPort, '127.0.0.1');
    const pipe = (from: net.Socket, to: net.Socket) => from.on('data', (chunk) => setTimeout(() => to.write(chunk), delayMs));
    pipe(client, upstream);
    pipe(upstream, client);
    const end = () => { client.destroy(); upstream.destroy(); };
    client.on('close', end); upstream.on('close', end); client.on('error', end); upstream.on('error', end);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as net.AddressInfo).port, close: () => server.close() };
}

type Seed = { tenantId: string; campaignId: string; executionId: string };

async function seed(opts: { n: number; senderPort: number | null; rateLimitPerMinute?: number; status: 'sending' | 'queued'; tenantRate: number; batchSize: number }): Promise<Seed> {
  const tenantId = (await owner.query<{ id: string }>('INSERT INTO tenant (name) VALUES ($1) RETURNING id', [`bench-${randomUUID()}`])).rows[0].id;
  await owner.query(`INSERT INTO sending_policy (tenant_id, batch_size, tenant_rate_limit_per_minute) VALUES ($1, $2, $3)`, [tenantId, opts.batchSize, opts.tenantRate]);
  let senderId: string | null = null;
  if (opts.senderPort !== null) {
    senderId = (await owner.query<{ id: string }>(
      `INSERT INTO sender_config (tenant_id, name, from_email, host, port, secret_ref, status, verified_at${opts.rateLimitPerMinute ? ', rate_limit_per_minute' : ''})
       VALUES ($1, 'bench', $2, '127.0.0.1', $3, '', 'verified', now()${opts.rateLimitPerMinute ? ', $4' : ''}) RETURNING id`,
      opts.rateLimitPerMinute ? [tenantId, `bench-${randomUUID()}@example.test`, opts.senderPort, opts.rateLimitPerMinute] : [tenantId, `bench-${randomUUID()}@example.test`, opts.senderPort],
    )).rows[0].id;
  }
  const template = (await owner.query<{ id: string }>(`INSERT INTO email_template (tenant_id, name, status) VALUES ($1, $2, 'published') RETURNING id`, [tenantId, `bench-${randomUUID()}`])).rows[0];
  const versionId = (await owner.query<{ id: string }>(
    `INSERT INTO email_template_version (tenant_id, template_id, version, subject, html, text_body, variable_schema_json, content_hash, published_at)
     VALUES ($1, $2, 1, 's', '<p>b</p>', 'b', '{"required":[],"optional":[]}'::jsonb, repeat('3', 64), now()) RETURNING id`,
    [tenantId, template.id],
  )).rows[0].id;
  const senderJson = JSON.stringify(senderId ? { senderConfigId: senderId, fromEmail: 'bench@example.test' } : { fromEmail: 'bench@example.test' });
  const campaignId = (await owner.query<{ id: string }>(
    `INSERT INTO campaign (tenant_id, name, status, template_version_id, sender_json) VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING id`,
    [tenantId, `bench-${randomUUID()}`, opts.status, versionId, senderJson],
  )).rows[0].id;
  const snapshotId = (await owner.query<{ id: string }>(
    `INSERT INTO campaign_snapshot (tenant_id, campaign_id, template_version_id, sender_json, audience_query_json, policy_result_json, total_snapshot, sendable_count, skipped_count)
     VALUES ($1, $2, $3, $4::jsonb, '{}'::jsonb, '{}'::jsonb, $5, $5, 0) RETURNING id`,
    [tenantId, campaignId, versionId, senderJson, opts.n],
  )).rows[0].id;
  let executionId = '';
  if (opts.status === 'sending') {
    executionId = (await owner.query<{ id: string }>(
      `INSERT INTO campaign_execution (tenant_id, campaign_id, snapshot_id, correlation_id, sender_config_id, status, batch_size)
       VALUES ($1, $2, $3, $4, $5, 'sending', $6) RETURNING id`,
      [tenantId, campaignId, snapshotId, `bench:${campaignId}`, senderId, opts.batchSize],
    )).rows[0].id;
  }
  const html = `<p>${'x'.repeat(HTML_KB * 1024)}</p>`;
  await owner.query(
    `WITH r AS (
       INSERT INTO recipient (tenant_id, email)
       SELECT $1, 'bench-' || g || '-' || $4 || '@example.test' FROM generate_series(1, $2) g
       RETURNING id, email)
     INSERT INTO campaign_recipient (tenant_id, campaign_id, snapshot_id, recipient_id, recipient_email, merge_data_json, email_snapshot, eligibility, status, execution_id)
     SELECT $1, $3, $5, r.id, r.email, '{}'::jsonb, jsonb_build_object('subject', 'Bench', 'html', $6::text, 'textBody', 'Bench'), 'sendable',
            CASE WHEN $7::uuid IS NULL THEN 'pending' ELSE 'queued' END, $7::uuid
     FROM r`,
    [tenantId, opts.n, campaignId, randomUUID().slice(0, 8), snapshotId, html, executionId || null],
  );
  return { tenantId, campaignId, executionId };
}

async function cleanup(tenantId: string): Promise<void> {
  // Immutability triggers block plain DELETEs; reuse the integration tests' purge.
  await purgeCampaignSendFixtures(owner, tenantId, 'eow_bench_send_throughput_cleanup');
  for (const table of ['recipient', 'email_template', 'sender_config', 'sending_policy']) {
    await owner.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenantId]);
  }
  await owner.query('DELETE FROM tenant WHERE id = $1', [tenantId]);
}

/** Same behaviour as send.ts's defaultSendFn (new transport per message), timed. */
function perMessageTransport(stats: { smtpMs: number }): SmtpSendFn {
  return async (message) => {
    const started = performance.now();
    const transport = nodemailer.createTransport(sendTransportOptions(message));
    try {
      const info = await transport.sendMail({ from: { name: message.from.name, address: message.from.email }, to: message.to, subject: message.subject, html: message.html, text: message.text, messageId: message.messageId });
      return { providerMessageId: info.messageId };
    } finally {
      transport.close();
      stats.smtpMs += performance.now() - started;
    }
  };
}

/** What a pooled transport would cost per message (one connection reused). */
function pooledTransport(port: number, stats: { smtpMs: number }): SmtpSendFn & { close(): void } {
  const transport = nodemailer.createTransport({ ...sendTransportOptions({ host: '127.0.0.1', port, username: '', secret: '' }), pool: true, maxConnections: 1, maxMessages: Infinity });
  const fn = (async (message) => {
    const started = performance.now();
    try {
      const info = await transport.sendMail({ from: { name: message.from.name, address: message.from.email }, to: message.to, subject: message.subject, html: message.html, text: message.text, messageId: message.messageId });
      return { providerMessageId: info.messageId };
    } finally {
      stats.smtpMs += performance.now() - started;
    }
  }) as SmtpSendFn & { close(): void };
  fn.close = () => transport.close();
  return fn;
}

async function codeRun(label: string, port: number, makeSend: (stats: { smtpMs: number }) => SmtpSendFn & { close?: () => void }): Promise<void> {
  const s = await seed({ n: N, senderPort: null, status: 'sending', tenantRate: 1_000_000, batchSize: N });
  process.env.SMTP_HOST = '127.0.0.1';
  process.env.SMTP_PORT = String(port);
  const stats = { smtpMs: 0 };
  const sendFn = makeSend(stats);
  const started = performance.now();
  const out = await sendClaimedBatch(testAppDatabaseUrl(), testRedisUrl(), s.tenantId, s.campaignId, s.executionId, N, sendFn);
  const totalMs = performance.now() - started;
  sendFn.close?.();
  const perMsg = totalMs / out.submitted;
  console.log(JSON.stringify({
    scenario: label, latencyOneWayMs: LATENCY_MS, recipients: N, submitted: out.submitted,
    totalSec: +(totalMs / 1000).toFixed(2), msgPerSec: +(out.submitted / (totalMs / 1000)).toFixed(1),
    msPerMsg: +perMsg.toFixed(1), smtpMsPerMsg: +(stats.smtpMs / out.submitted).toFixed(1),
    dbRedisOverheadMsPerMsg: +((totalMs - stats.smtpMs) / out.submitted).toFixed(1),
  }));
  await cleanup(s.tenantId);
}

/** One real scheduler tick with stock defaults: how many leave per 60s tick. */
async function configRun(label: string, port: number, rateLimitPerMinute: number | undefined, batchSize: number, tenantRate: number): Promise<void> {
  const s = await seed({ n: N, senderPort: port, rateLimitPerMinute, status: 'queued', tenantRate, batchSize });
  const started = performance.now();
  // Fresh minute bucket for the Redis counters so earlier runs do not bleed in.
  const results = await scanQueuedCampaigns(testAppDatabaseUrl(), testRedisUrl(), 100);
  const totalMs = performance.now() - started;
  const sent = (await owner.query<{ c: number }>(`SELECT count(*)::int c FROM campaign_recipient WHERE campaign_id = $1 AND status = 'submitted'`, [s.campaignId])).rows[0].c;
  const deferred = (await owner.query<{ c: number }>(`SELECT count(*)::int c FROM campaign_recipient WHERE campaign_id = $1 AND status = 'queued' AND next_retry_at IS NOT NULL`, [s.campaignId])).rows[0].c;
  console.log(JSON.stringify({
    scenario: label, senderRateLimitPerMinute: rateLimitPerMinute ?? 60, policyBatchSize: batchSize, tenantRatePerMinute: tenantRate,
    sentThisTick: sent, deferredToNextMinute: deferred, tickWorkSec: +(totalMs / 1000).toFixed(2),
    outcome: results.find((r) => r.campaignId === s.campaignId)?.outcome ?? null,
    projectedPerHourAt60sTick: sent * 60,
  }));
  await cleanup(s.tenantId);
}

const proxy = LATENCY_MS > 0 ? await startLatencyProxy(SMTP_PORT, LATENCY_MS) : null;
const port = proxy?.port ?? SMTP_PORT;
const only = process.env.BENCH_ONLY;
// Leftovers from an interrupted earlier run would be swept by scanQueuedCampaigns
// and distort the config scenarios, so purge any stale bench tenant first.
for (const row of (await owner.query<{ id: string }>(`SELECT id FROM tenant WHERE name LIKE 'bench-%'`)).rows) await cleanup(row.id);
try {
  if (!only || only === 'code') {
    await codeRun('code: current (new SMTP connection per message, sequential)', port, (stats) => perMessageTransport(stats));
    forceNoDelay = true;
    await codeRun('code: current + TCP_NODELAY', port, (stats) => perMessageTransport(stats));
    await codeRun('code: pooled SMTP connection + TCP_NODELAY, still sequential', port, (stats) => pooledTransport(port, stats));
    forceNoDelay = false;
    await codeRun('code: no-op provider (pure DB+Redis overhead)', port, (stats) => Object.assign(async () => ({ providerMessageId: `<noop-${randomUUID()}>` }), { close() {} , stats }));
  }
  if (!only || only === 'config') {
    await configRun('config: stock defaults (sender 60/min, batch 100, tenant 600)', port, undefined, 100, 600);
    await configRun('config: user raised tenant to 6000/min & batch 1000 in UI', port, undefined, 1000, 6000);
    await configRun('config: sender limit raised to 6000 (not settable today), batch 1000', port, 6000, 1000, 6000);
  }
} finally {
  proxy?.close();
  await owner.end();
}
