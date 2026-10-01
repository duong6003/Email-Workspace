// Dev/e2e-only fixture: reaches 'delivered'/'bounced' campaign_recipient
// states through the REAL, running webhook HTTP route
// (POST /api/v1/webhooks/providers/smtp), signed with the same HMAC scheme a
// real provider uses -- not a raw status UPDATE. This is the most direct
// evidence apps/web/e2e's visual-capture scenarios can produce for M5-S4's
// own delivered/bounced-driven UI, since the webhook is the only thing that
// ever writes those two states (M5-S3 declined to, DEC-096).
//
// Prerequisite: the campaign must already be 'completed' via
// seed-campaign-send-fixture.mjs, so every actionable campaign_recipient row
// carries a real message_attempt(outcome='submitted', provider_message_id).
import { config } from 'dotenv';
import { createHmac } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, '../../../.env'), quiet: true });

const pgUser = process.env.EOW_POSTGRES_USER ?? 'eow';
const pgBind = process.env.EOW_POSTGRES_BIND ?? '127.0.0.1';
const pgPort = process.env.EOW_POSTGRES_PORT ?? '55432';
const pgDb = process.env.EOW_POSTGRES_DB ?? 'eow';

const [, , campaignId, deliveredCountArg] = process.argv;
if (!campaignId) {
  console.error('usage: seed-campaign-webhook-fixture.mjs <campaignId> [deliveredCount]');
  process.exit(2);
}
const deliveredCount = deliveredCountArg !== undefined ? Number(deliveredCountArg) : undefined;

// The packaged stack publishes no API port; Nginx fronts both the SPA and
// `/api/` on E2E_BASE_URL. Same single-origin contract the specs follow -- see
// apps/web/playwright.config.ts.
const apiBase = process.env.E2E_API_BASE ?? `${process.env.E2E_BASE_URL ?? 'http://localhost:8080'}/api/v1`;
const webhookSecret = process.env.PROVIDER_WEBHOOK_SECRET;
if (!webhookSecret) {
  console.error('PROVIDER_WEBHOOK_SECRET is required (must match the running host API\'s own env).');
  process.exit(2);
}

function sign(rawBody, secret, timestampSeconds) {
  const digest = createHmac('sha256', secret).update(`${timestampSeconds}.${rawBody}`).digest('hex');
  return `t=${timestampSeconds},v1=${digest}`;
}

async function postWebhookEvent(type, providerMessageId, eventId) {
  const payload = JSON.stringify({ id: eventId, type, messageId: providerMessageId, occurredAt: new Date().toISOString() });
  const timestamp = Math.floor(Date.now() / 1000);
  const response = await fetch(`${apiBase}/webhooks/providers/smtp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-eow-signature': sign(payload, webhookSecret, timestamp) },
    body: payload,
  });
  const body = await response.json();
  if (response.status !== 200 || body.status !== 'applied') {
    throw new Error(`Unexpected webhook response for ${type} ${providerMessageId}: ${response.status} ${JSON.stringify(body)}`);
  }
  return body;
}

const pool = new pg.Pool({
  connectionString: `postgresql://${pgUser}:${process.env.EOW_POSTGRES_PASSWORD}@${pgBind}:${pgPort}/${pgDb}`,
});

const attempts = (await pool.query(
  `SELECT ma.provider_message_id, ma.campaign_recipient_id
   FROM message_attempt ma
   JOIN campaign_recipient cr ON cr.id = ma.campaign_recipient_id
   WHERE cr.campaign_id = $1 AND ma.outcome = 'submitted'
   ORDER BY ma.provider_message_id`,
  [campaignId],
)).rows;
await pool.end();

if (attempts.length === 0) throw new Error(`No submitted message_attempt rows found for campaign ${campaignId}. Run seed-campaign-send-fixture.mjs to 'completed' first.`);

const splitAt = deliveredCount ?? Math.ceil(attempts.length / 2);
const results = { delivered: 0, bounced: 0 };
for (let i = 0; i < attempts.length; i += 1) {
  const type = i < splitAt ? 'delivered' : 'bounced';
  const eventId = `evt-e2e-${type}-${attempts[i].campaign_recipient_id}`;
  await postWebhookEvent(type, attempts[i].provider_message_id, eventId);
  results[type] += 1;
}

console.log(JSON.stringify({ campaignId, total: attempts.length, ...results }));
