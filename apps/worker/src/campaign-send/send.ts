import pg from 'pg';
import nodemailer from 'nodemailer';
import { Redis } from 'ioredis';
import { resolveSenderSecret } from '@eow/sender-credentials';
import { runInTenantTransaction } from '../tenant-database.js';
import { buildMessageId, classifySmtpError, computeContentHash, safeSmtpFailureReason, type FrozenEmail } from './message.js';
import { nextRetryDelayMs } from './retry-backoff.js';
import { checkAndIncrementRateLimit } from './rate-limiter.js';
import { suppressRecipient } from './suppression.js';
import { countRecipient, createThrottleState, markPublished, shouldPublishProgress } from './progress-throttle.js';
import { publishProgressSnapshot } from './progress-snapshot.js';
import type { CampaignEventPublisher } from './progress-event.js';

export type SmtpSendFn = (message: {
  host: string;
  port: number;
  username: string;
  secret: string;
  from: { name: string; email: string };
  replyTo: string | null;
  to: string;
  subject: string;
  html: string;
  text: string;
  messageId: string;
}) => Promise<{ providerMessageId: string }>;

export type SendBatchOutcome = { submitted: number; retrying: number; failed: number };

type ClaimedRow = {
  id: string;
  recipient_id: string;
  to_email: string;
  email_snapshot: FrozenEmail;
  attempt_count: number;
};

type SenderInfo = {
  host: string;
  port: number;
  username: string;
  secretRef: string;
  secretCiphertext: string | null;
  fromName: string;
  fromEmail: string;
  replyTo: string | null;
  senderConfigId: string | null;
  rateLimitPerMinute: number | null;
  dailySendLimit: number | null;
  tenantRateLimitPerMinute: number;
  quotaLimit: number | null;
  quotaPeriod: 'day' | 'month';
};

const DEFAULT_TENANT_RATE_LIMIT_PER_MINUTE = 600;
const STALE_CLAIM_MINUTES = 5;

/**
 * BR-SEND-009 / D-123 / ADR-027. The scheduler's own tick defaults to 60s
 * (apps/scheduler/src/main.ts), far too slow to meet the rule's 10-second
 * pause bound on its own -- an in-flight batch would otherwise keep
 * submitting for up to a full batchSize after the operator's click. This is
 * the bounded re-check interval sendClaimedBatch's own loop uses instead:
 * worst case is one in-flight message plus this interval, comfortably
 * inside 10 seconds.
 */
export const PAUSE_CHECK_INTERVAL_MS = 2_000;

/**
 * The send path's half of the implicit-TLS rule the API adapter documents on
 * SMTP_IMPLICIT_TLS_PORT. Port 465 hands back TLS on connect with no
 * plaintext 220 greeting, so a sender saved on it stalled here until
 * socketTimeout and then burned a retry -- every other port stays
 * plaintext-first and lets nodemailer negotiate STARTTLS on its own. The two
 * copies are deliberate: worker and API share no runtime module, and the
 * predicate is small enough that a new shared package would cost more than
 * it saves. They are tested in lockstep.
 */
const IMPLICIT_TLS_PORT = 465;

export function sendTransportOptions(message: { host: string; port: number; username: string; secret: string }) {
  return {
    host: message.host,
    port: message.port,
    secure: message.port === IMPLICIT_TLS_PORT,
    auth: message.username ? { user: message.username, pass: message.secret } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  };
}

const defaultSendFn: SmtpSendFn = async (message) => {
  const transport = nodemailer.createTransport(sendTransportOptions(message));
  try {
    const info = await transport.sendMail({
      from: { name: message.from.name, address: message.from.email },
      replyTo: message.replyTo ?? undefined,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
      messageId: message.messageId,
    });
    return { providerMessageId: info.messageId };
  } finally {
    transport.close();
  }
};

/**
 * BR-SEND-006/007/011/012's "send" DAG node (SS3.4/SS3.5/SS3.6). Reserve ->
 * send -> record (DEC-051's precedent): the network call happens outside
 * any transaction that could roll it back, so a crash between provider
 * acceptance and recording it is detectable via the deterministic
 * Message-ID (DEC-104), never a silent duplicate. The reserve claim also
 * excludes rows another in-flight call already reserved less than
 * STALE_CLAIM_MINUTES ago (A15) -- PostgreSQL, not this function's own
 * memory, is what a re-run trusts.
 */
export async function sendClaimedBatch(
  databaseUrl: string,
  redisUrl: string,
  tenantId: string,
  campaignId: string,
  executionId: string,
  batchSize: number,
  sendFn: SmtpSendFn = defaultSendFn,
  publishProgress: CampaignEventPublisher | null = null,
  now: () => number = Date.now,
): Promise<SendBatchOutcome> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1, lazyConnect: true });
  // DEC-103's own failure path (checkRateLimits' try/catch) is what handles
  // an unreachable Redis; this listener only stops ioredis logging an
  // "Unhandled error event" for the same already-handled rejection.
  redis.on('error', () => {});
  try {
    const reserved = await runInTenantTransaction(pool, tenantId, (client) => reserveBatch(client, tenantId, campaignId, executionId, batchSize));
    if (reserved.rows.length === 0) return { submitted: 0, retrying: 0, failed: 0 };

    let dailyRemaining = Infinity;
    if (reserved.sender.senderConfigId && reserved.sender.dailySendLimit !== null) {
      const used = await runInTenantTransaction(pool, tenantId, (client) =>
        dailySubmittedCount(client, tenantId, reserved.sender.senderConfigId!));
      dailyRemaining = Math.max(0, reserved.sender.dailySendLimit - used);
    }
    const quotaPeriodKey = new Date().toISOString().slice(0, reserved.sender.quotaPeriod === 'month' ? 7 : 10);
    const quotaRemaining = reserved.sender.quotaLimit === null
      ? Infinity
      : await runInTenantTransaction(pool, tenantId, async (client) => {
          const [row] = ((await client.query(
            `SELECT LEAST(
                      COALESCE(SUM(amount - consumed), 0),
                      GREATEST($4 - COALESCE(SUM(consumed), 0), 0)
                    )::int AS remaining
             FROM quota_reservation
             WHERE tenant_id = $1 AND campaign_id = $2 AND period_key = $3 AND state = 'held'`,
            [tenantId, campaignId, quotaPeriodKey, reserved.sender.quotaLimit],
          )) as { rows: Array<{ remaining: number }> }).rows;
          return Number(row?.remaining ?? 0);
        });
    let quotaAvailable = quotaRemaining;

    const outcome: SendBatchOutcome = { submitted: 0, retrying: 0, failed: 0 };
    const overBudget: ClaimedRow[] = [];
    // ADR-016: no faster than 1/s or 250 recipients. Counted per row whose
    // status actually changed this pass (submitted or a recorded failure) --
    // an overBudget row is rescheduled unchanged and does not itself move
    // the needle on what a viewer would see.
    let throttle = createThrottleState(now());

    // BR-SEND-009. Initialised already-stale so the very first row of a
    // batch always checks once (catches a pause that landed just before
    // this call started), then throttled to PAUSE_CHECK_INTERVAL_MS.
    let lastPauseCheckAt = now() - PAUSE_CHECK_INTERVAL_MS;
    let pausedFromIndex: number | null = null;

    for (let rowIndex = 0; rowIndex < reserved.rows.length; rowIndex += 1) {
      const row = reserved.rows[rowIndex]!;

      if (now() - lastPauseCheckAt >= PAUSE_CHECK_INTERVAL_MS) {
        lastPauseCheckAt = now();
        const paused = await runInTenantTransaction(pool, tenantId, (client) => campaignIsPaused(client, tenantId, campaignId));
        if (paused) {
          pausedFromIndex = rowIndex;
          break;
        }
      }

      if (dailyRemaining <= 0) {
        overBudget.push(row);
        continue;
      }
      if (quotaAvailable <= 0) {
        overBudget.push(row);
        continue;
      }
      const withinRateLimit = await checkRateLimits(redis, reserved.sender, tenantId);
      if (!withinRateLimit) {
        overBudget.push(row);
        continue;
      }

      const contentHash = computeContentHash(row.email_snapshot);
      const messageId = buildMessageId(row.id, executionId, reserved.sender.fromEmail);
      try {
        let secret = '';
        if (reserved.sender.username) {
          try {
            secret = resolveSenderSecret({ tenantId, secretRef: reserved.sender.secretRef, ciphertext: reserved.sender.secretCiphertext }) ?? '';
          } catch {
            throw Object.assign(new Error('SMTP credential cannot be decrypted. Save the sender credential and verify the connection again.'), { code: 'EAUTH' });
          }
          if (!secret) {
            throw Object.assign(new Error('SMTP credential is unavailable. Save the sender credential and verify the connection again.'), { code: 'EAUTH' });
          }
        }
        const result = await sendFn({
          host: reserved.sender.host,
          port: reserved.sender.port,
          username: reserved.sender.username,
          secret,
          from: { name: reserved.sender.fromName, email: reserved.sender.fromEmail },
          replyTo: reserved.sender.replyTo,
          to: row.to_email,
          subject: row.email_snapshot.subject,
          html: row.email_snapshot.html,
          text: row.email_snapshot.textBody,
          messageId,
        });
        await runInTenantTransaction(pool, tenantId, (client) => recordSubmitted(client, tenantId, campaignId, reserved.sender.quotaLimit === null ? null : quotaPeriodKey, row, contentHash, result.providerMessageId));
        outcome.submitted += 1;
        dailyRemaining -= 1;
        quotaAvailable -= 1;
      } catch (error) {
        const classification = classifySmtpError(error as Record<string, unknown>);
        const failedTerminal = classification.errorClass !== 'transient' || row.attempt_count + 1 >= reserved.sender.maxAttempts;
        await runInTenantTransaction(pool, tenantId, (client) =>
          recordFailure(client, tenantId, row, contentHash, classification, error as Record<string, unknown>, failedTerminal));
        if (failedTerminal) outcome.failed += 1;
        else outcome.retrying += 1;
      }

      throttle = countRecipient(throttle);
      if (publishProgress && shouldPublishProgress(throttle, now())) {
        // Published after the row's own commit above -- a published event
        // a rollback then erases would make the counters on screen
        // unfalsifiable (AGENTS.md: realtime is a hint, never the only copy
        // of business state).
        await publishProgressSnapshot(pool, tenantId, campaignId, executionId, publishProgress);
        throttle = markPublished(throttle, now());
      }
    }

    if (pausedFromIndex !== null) {
      // Rows already claimed but never attempted this pass -- released
      // immediately (claimed_at = NULL, no next_retry_at delay) rather than
      // rescheduled to the next minute boundary the way an over-budget row
      // is: a paused row is not "reservation still outstanding", it is
      // "must not be sent right now", and resume should be able to reclaim
      // it the instant the campaign goes back to 'sending'.
      const releasedRows = reserved.rows.slice(pausedFromIndex);
      await runInTenantTransaction(pool, tenantId, (client) => releaseClaimedRows(client, tenantId, releasedRows));
    }

    if (overBudget.length > 0) {
      await runInTenantTransaction(pool, tenantId, (client) => rescheduleOverBudget(client, tenantId, overBudget));
      outcome.retrying += overBudget.length;
    }
    return outcome;
  } finally {
    await pool.end();
    redis.disconnect();
  }
}

/**
 * DEC-103: Redis holds counters only, never work -- a flushed or
 * unreachable Redis loses rate *accounting* for one minute, never a
 * message, because every unsent recipient stays a 'queued' row in
 * PostgreSQL regardless of what this function returns. Redis being
 * unreachable therefore fails the batch closed (no submission this pass)
 * rather than open (bypassing the limit).
 */
async function checkRateLimits(redis: Redis, sender: SenderInfo, tenantId: string): Promise<boolean> {
  try {
    if (sender.senderConfigId && sender.rateLimitPerMinute !== null) {
      const senderCheck = await checkAndIncrementRateLimit(redis, 'sender', sender.senderConfigId, sender.rateLimitPerMinute);
      if (!senderCheck.allowed) return false;
    }
    const tenantCheck = await checkAndIncrementRateLimit(redis, 'tenant', tenantId, sender.tenantRateLimitPerMinute);
    return tenantCheck.allowed;
  } catch {
    return false;
  }
}

async function reserveBatch(
  client: pg.PoolClient,
  tenantId: string,
  campaignId: string,
  executionId: string,
  batchSize: number,
): Promise<{ rows: ClaimedRow[]; sender: SenderInfo & { maxAttempts: number } }> {
  const emptySender: SenderInfo & { maxAttempts: number } = {
    host: '', port: 0, username: '', secretRef: '', secretCiphertext: null, fromName: '', fromEmail: '',
    replyTo: null,
    senderConfigId: null, rateLimitPerMinute: null, dailySendLimit: null,
    tenantRateLimitPerMinute: DEFAULT_TENANT_RATE_LIMIT_PER_MINUTE, maxAttempts: 5,
    quotaLimit: null, quotaPeriod: 'month',
  };

  const [execution] = ((await client.query(
    `SELECT ce.sender_config_id, ce.max_attempts, cs.sender_json
     FROM campaign_execution ce
     JOIN campaign_snapshot cs ON cs.id = ce.snapshot_id
     WHERE ce.id = $1 AND ce.tenant_id = $2 AND ce.campaign_id = $3`,
    [executionId, tenantId, campaignId],
  )) as { rows: Array<{ sender_config_id: string | null; max_attempts: number; sender_json: { fromEmail?: string; fromName?: string; replyTo?: string | null } }> }).rows;
  if (!execution) return { rows: [], sender: emptySender };

  const [policy] = ((await client.query(
    `SELECT tenant_rate_limit_per_minute, send_quota_limit, send_quota_period FROM sending_policy WHERE tenant_id = $1`,
    [tenantId],
  )) as { rows: Array<{ tenant_rate_limit_per_minute: number; send_quota_limit: number | null; send_quota_period: 'day' | 'month' }> }).rows;
  const tenantRateLimitPerMinute = policy?.tenant_rate_limit_per_minute ?? DEFAULT_TENANT_RATE_LIMIT_PER_MINUTE;

  let sender: SenderInfo;
  if (execution.sender_config_id) {
    const [row] = ((await client.query(
      `SELECT sender.host, sender.port, sender.username, sender.secret_ref, credential.ciphertext AS secret_ciphertext,
              sender.from_name, sender.from_email, sender.reply_to, sender.rate_limit_per_minute, sender.daily_send_limit
       FROM sender_config sender
       LEFT JOIN sender_credential credential
         ON credential.tenant_id = sender.tenant_id AND credential.secret_ref = sender.secret_ref
       WHERE sender.id = $1 AND sender.tenant_id = $2`,
      [execution.sender_config_id, tenantId],
    )) as { rows: Array<{ host: string; port: number; username: string; secret_ref: string; secret_ciphertext: string | null; from_name: string; from_email: string; reply_to: string | null; rate_limit_per_minute: number; daily_send_limit: number | null }> }).rows;
    sender = {
      host: row.host, port: row.port, username: row.username, secretRef: row.secret_ref, secretCiphertext: row.secret_ciphertext,
      fromName: row.from_name, fromEmail: row.from_email, senderConfigId: execution.sender_config_id,
      replyTo: execution.sender_json.replyTo ?? row.reply_to,
      rateLimitPerMinute: row.rate_limit_per_minute, dailySendLimit: row.daily_send_limit, tenantRateLimitPerMinute,
      quotaLimit: policy?.send_quota_limit ?? null, quotaPeriod: policy?.send_quota_period ?? 'month',
    };
  } else {
    sender = {
      host: process.env.SMTP_HOST ?? 'mailpit',
      port: Number(process.env.SMTP_PORT ?? 1025),
      username: '', secretRef: '', secretCiphertext: null,
      fromName: execution.sender_json.fromName ?? '',
      fromEmail: execution.sender_json.fromEmail ?? process.env.SMTP_FROM ?? 'no-reply@example.test',
      replyTo: execution.sender_json.replyTo ?? null,
      senderConfigId: null, rateLimitPerMinute: null, dailySendLimit: null, tenantRateLimitPerMinute,
      quotaLimit: policy?.send_quota_limit ?? null, quotaPeriod: policy?.send_quota_period ?? 'month',
    };
  }

  const claimed = (await client.query(
    `WITH rows_to_claim AS (
       SELECT id
       FROM campaign_recipient
       WHERE tenant_id = $1 AND campaign_id = $2 AND execution_id = $3 AND status = 'queued'
         AND (next_retry_at IS NULL OR next_retry_at <= now())
         AND (claimed_at IS NULL OR claimed_at <= now() - ($5::double precision * interval '1 minute'))
       ORDER BY id
       FOR UPDATE SKIP LOCKED
       LIMIT $4
     )
     UPDATE campaign_recipient row
     SET claimed_at = now()
     FROM rows_to_claim
     WHERE row.id = rows_to_claim.id
     RETURNING row.id, row.recipient_id, row.recipient_email AS to_email, row.email_snapshot, row.attempt_count`,
    [tenantId, campaignId, executionId, batchSize, STALE_CLAIM_MINUTES],
  )) as { rows: ClaimedRow[] };

  return { rows: claimed.rows, sender: { ...sender, maxAttempts: execution.max_attempts } };
}

async function dailySubmittedCount(client: pg.PoolClient, tenantId: string, senderConfigId: string): Promise<number> {
  const [row] = ((await client.query(
    `SELECT count(*)::int AS count
     FROM message_attempt ma
     JOIN campaign_execution ce ON ce.id = ma.execution_id AND ce.tenant_id = ma.tenant_id
     WHERE ma.tenant_id = $1 AND ce.sender_config_id = $2 AND ma.outcome = 'submitted'
       AND ma.attempted_at >= date_trunc('day', now() AT TIME ZONE 'UTC')`,
    [tenantId, senderConfigId],
  )) as { rows: Array<{ count: number }> }).rows;
  return row?.count ?? 0;
}

/**
 * BR-SEND-009's re-check itself. Checks specifically for 'paused', not
 * merely "status is not 'sending'" -- D-124: a long-running test fixture in
 * this same file (A7's 600-recipient throttle test) deliberately parks
 * campaign.status at a value outside queued_campaign_executions()'s own
 * IN-list to hide from the live docker-compose worker's cross-tenant scan
 * (D-118's mechanism), and used 'paused' for that purpose before this
 * checkpoint gave 'paused' a real enforcement meaning. A "not sending"
 * check would misfire on that fixture (and on any other incidental
 * non-sending value); checking specifically for 'paused' does not, and is
 * also the more precise reading of what this rule actually asks for.
 */
async function campaignIsPaused(client: pg.PoolClient, tenantId: string, campaignId: string): Promise<boolean> {
  const [row] = ((await client.query(
    `SELECT status FROM campaign WHERE id = $1 AND tenant_id = $2`,
    [campaignId, tenantId],
  )) as { rows: Array<{ status: string }> }).rows;
  return row?.status === 'paused';
}

async function releaseClaimedRows(client: pg.PoolClient, tenantId: string, rows: ClaimedRow[]): Promise<void> {
  for (const row of rows) {
    await client.query(
      `UPDATE campaign_recipient SET claimed_at = NULL, updated_at = now()
       WHERE id = $1 AND tenant_id = $2 AND status = 'queued'`,
      [row.id, tenantId],
    );
  }
}

async function rescheduleOverBudget(client: pg.PoolClient, tenantId: string, rows: ClaimedRow[]): Promise<void> {
  const nextMinuteBoundary = new Date(Math.ceil(Date.now() / 60_000) * 60_000);
  for (const row of rows) {
    // claimed_at resets to NULL for the same reason recordFailure's retry
    // branch does: this row was reserved but never attempted (budget, not
    // an error), so it is not "possibly abandoned mid-flight" and must not
    // be blocked by the stale-claim guard once next_retry_at is due.
    await client.query(
      `UPDATE campaign_recipient SET next_retry_at = $3, claimed_at = NULL, updated_at = now()
       WHERE id = $1 AND tenant_id = $2 AND status = 'queued'`,
      [row.id, tenantId, nextMinuteBoundary],
    );
  }
}

async function recordSubmitted(
  client: pg.PoolClient,
  tenantId: string,
  campaignId: string,
  periodKey: string | null,
  row: ClaimedRow,
  contentHash: string,
  providerMessageId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO message_attempt (tenant_id, execution_id, campaign_recipient_id, attempt_no, outcome, provider_message_id, content_hash)
     SELECT $1, execution_id, id, attempt_count + 1, 'submitted', $3, $4 FROM campaign_recipient WHERE id = $2 AND tenant_id = $1
     ON CONFLICT (campaign_recipient_id, attempt_no) DO NOTHING`,
    [tenantId, row.id, providerMessageId, contentHash],
  );
  await client.query(
    `UPDATE campaign_recipient SET status = 'submitted', content_hash = $3, attempt_count = attempt_count + 1, next_retry_at = NULL, updated_at = now()
     WHERE id = $1 AND tenant_id = $2 AND status = 'queued'`,
    [row.id, tenantId, contentHash],
  );
  // BR-CFG-006 consumption, but only for a tenant that actually has a quota.
  // periodKey is null when send_quota_limit is NULL (unlimited), which is the
  // pre-M7-S1 default and therefore every tenant that existed before this rule.
  // Issuing this UPDATE unconditionally cost one extra round-trip per recipient
  // on the hot send path for tenants that can never have a reservation to
  // consume -- measured at roughly 2.5x on the 600-recipient A7 case. There is
  // no correctness loss: with no quota configured there is no held reservation,
  // so the statement always matched zero rows. See EXECPLAN D-171.
  if (periodKey !== null) {
    await client.query(
      `UPDATE quota_reservation
       SET consumed = consumed + 1
       WHERE tenant_id = $1 AND campaign_id = $2 AND period_key = $3 AND state = 'held' AND consumed < amount`,
      [tenantId, campaignId, periodKey],
    );
  }
}

async function recordFailure(
  client: pg.PoolClient,
  tenantId: string,
  row: ClaimedRow,
  contentHash: string,
  classification: ReturnType<typeof classifySmtpError>,
  rawError: Record<string, unknown>,
  terminal: boolean,
): Promise<void> {
  const errorCode = typeof rawError.code === 'string' ? rawError.code : typeof rawError.responseCode === 'number' ? String(rawError.responseCode) : 'UNKNOWN';
  const providerResponse = safeSmtpFailureReason(rawError);
  const nextRetryAt = terminal ? null : new Date(Date.now() + Math.max(nextRetryDelayMs(row.attempt_count + 1), (classification.retryAfterSeconds ?? 0) * 1000));

  await client.query(
    `INSERT INTO message_attempt (tenant_id, execution_id, campaign_recipient_id, attempt_no, outcome, error_code, error_class, provider_response, retry_after_seconds, next_retry_at, content_hash)
     SELECT $1, execution_id, id, attempt_count + 1, $3, $4, $5, $6, $7, $8, $9 FROM campaign_recipient WHERE id = $2 AND tenant_id = $1
     ON CONFLICT (campaign_recipient_id, attempt_no) DO NOTHING`,
    [tenantId, row.id, classification.errorClass === 'transient' ? 'transient_error' : 'permanent_error', errorCode, classification.errorClass, providerResponse, classification.retryAfterSeconds, nextRetryAt, contentHash],
  );

  if (terminal) {
    await client.query(
      `UPDATE campaign_recipient SET status = 'failed', last_error_code = $3, attempt_count = attempt_count + 1, next_retry_at = NULL, updated_at = now()
       WHERE id = $1 AND tenant_id = $2 AND status = 'queued'`,
      [row.id, tenantId, errorCode],
    );
  } else {
    // claimed_at resets to NULL: a recorded verdict (retry scheduled for
    // next_retry_at) is no longer "possibly abandoned mid-flight" -- the
    // stale-claim guard (reserveBatch) exists only for a row that never got
    // a verdict at all, and must not also block this legitimate future
    // reclaim once next_retry_at is due (A9's second attempt).
    await client.query(
      `UPDATE campaign_recipient SET last_error_code = $4, attempt_count = attempt_count + 1, next_retry_at = $3, claimed_at = NULL, updated_at = now()
       WHERE id = $1 AND tenant_id = $2 AND status = 'queued'`,
      [row.id, tenantId, nextRetryAt, errorCode],
    );
  }

  if (classification.hardBounce) {
    await suppressRecipient(client, tenantId, row.recipient_id, 'hard_bounce', `campaign-send:${row.id}`);
  }
}
