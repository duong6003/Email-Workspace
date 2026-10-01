import {
  BadRequestException,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import { runInTenantContext } from '../database/tenant-transaction.js';
import type { MessageStatus } from '../campaigns/send-state-machine.js';
import { publishProgressSnapshot } from '../campaigns/progress-snapshot.js';
import { EnvSecretStore, type SecretStore } from '../sender-config/secret-store.js';
import { resolveProviderAdapter } from './provider-registry.js';
import { verifyWebhookSignature } from './webhook-signature.js';
import { decideWebhookOutcome } from './apply-decision.js';
import { suppressRecipient } from './suppression.js';
import { RedisCampaignPublisher } from '../realtime/redis-campaign-publisher.js';
import type { ProviderWebhookResult } from './dto/provider-webhook.dto.js';
import type { ProviderWebhookEvent } from '../sender-config/provider-adapter.js';
import { trace } from '@opentelemetry/api';
import { metrics } from '../observability/metrics-registry.js';
import { updateRequestContext } from '../observability/request-context.js';
import { appLogger } from '../observability/logger.js';

/** One secret per provider per deployment (DEC-114) -- resolved through the
 * existing SecretStore seam (apps/api/src/sender-config/secret-store.ts) so
 * there is no second secret mechanism to audit. A per-tenant secret cannot
 * be selected before the tenant is known, and the tenant is only knowable by
 * reading the database on behalf of an unverified caller -- an enumeration
 * oracle gated on nothing. */
const WEBHOOK_SECRET_REFERENCE = 'PROVIDER_WEBHOOK_SECRET';

/** 16x tighter than the global JSON_BODY_LIMIT_BYTES (16 MiB, for CSV import
 * previews): a delivery event is ~200 bytes, and an unauthenticated endpoint
 * has no business accepting the same allowance as an authenticated one
 * (M5-S4-WEBHOOK-PLAN.md SS3.8, A16). Enforced inside the handler because
 * this app's one JSON body-parser instance is shared by every route -- see
 * D-109 for why a second, route-scoped parser is not the fix. */
export const WEBHOOK_BODY_LIMIT_BYTES = 1024 * 1024;

type ResolvedRecipientRow = { tenant_id: string; campaign_recipient_id: string; execution_id: string | null };
type LockedCampaignRecipientRow = { status: MessageStatus; delivery_state_at: Date | null; recipient_id: string; campaign_id: string };
type ApplyOutcome = ProviderWebhookResult & { campaignId?: string };

@Injectable()
export class WebhooksService {
  private readonly secrets: SecretStore = new EnvSecretStore();

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly campaignPublisher: RedisCampaignPublisher,
  ) {}

  /**
   * The whole of M5-S4-WEBHOOK-PLAN.md SS1's binding sentence: the payload is
   * evidence, never authority. Steps 1-2 (verify, parse) write nothing; the
   * tenant is resolved server-side from `resolve_provider_message()` (a
   * Message-ID this system itself minted, DEC-104), never trusted from the
   * request body -- any `tenantId`/`campaignRecipientId` key in the payload
   * is simply never read (A12).
   */
  async ingest(
    provider: string,
    rawBody: Buffer | undefined,
    signatureHeader: string | undefined,
    now: Date,
  ): Promise<ProviderWebhookResult> {
    return trace.getTracer('eow-api').startActiveSpan('webhook.receive', async (span) => {
      span.setAttribute('eow.provider', provider);
      try {
    const adapter = resolveProviderAdapter(provider);
    if (!adapter) throw new NotFoundException(`Unknown webhook provider '${provider}'.`);

    if (!rawBody) throw new BadRequestException('Missing request body.');
    if (rawBody.length > WEBHOOK_BODY_LIMIT_BYTES) {
      throw new PayloadTooLargeException('Request body exceeds the maximum allowed webhook size.');
    }

    const secret = await this.secrets.resolve(WEBHOOK_SECRET_REFERENCE);
    if (!secret) throw new ServiceUnavailableException('Webhook signing secret is not configured.');

    const verification = verifyWebhookSignature({ rawBody, header: signatureHeader, secret, now });
    if (!verification.ok) {
      if (verification.reason === 'malformed') throw new BadRequestException('Malformed webhook signature.');
      throw new UnauthorizedException('Webhook signature verification failed.');
    }
    metrics.webhookLagSeconds(provider, Math.max(0, now.getTime() / 1000 - verification.timestampSeconds));

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new BadRequestException('Malformed JSON payload.');
    }
    const event = adapter.parseWebhookEvent(parsedJson);
    if (!event.eventId || !event.providerMessageId) {
      throw new BadRequestException('Webhook payload is missing a required field.');
    }
    // A provider omission falls back to its own already-verified signature
    // timestamp (inside the tolerance window by construction) -- never
    // request-processing time, which is not a fact about the event.
    const occurredAt = event.occurredAt ?? new Date(verification.timestampSeconds * 1000);

    const resolvedRows = (await this.dataSource.query(
      'SELECT tenant_id, campaign_recipient_id, execution_id FROM resolve_provider_message($1)',
      [event.providerMessageId],
    )) as ResolvedRecipientRow[];
    if (resolvedRows.length !== 1) {
      // Zero: no submitted attempt ever carried this Message-ID. Two: an
      // ambiguous mapping across distinct recipients (D-107) -- neither is a
      // mapping this route can act on (DEC-111).
      return { status: 'unmatched' as const, eventId: event.eventId };
    }
    const { tenant_id: tenantId, campaign_recipient_id: campaignRecipientId, execution_id: executionId } = resolvedRows[0];

    const result = await runInTenantContext(this.dataSource, tenantId, (manager) =>
      this.applyInTransaction(manager, {
        tenantId,
        provider,
        campaignRecipientId,
        executionId,
        eventId: event.eventId!,
        eventType: event.type,
        providerMessageId: event.providerMessageId!,
        occurredAt,
      }),
    );

    // Publish strictly after the apply transaction above has committed
    // (A13): a published event a rollback then erases would make the
    // counters on screen unfalsifiable. Only a genuinely applied delivery
    // event moves progress -- duplicate/ignored/unmatched change nothing.
    if (result.status === 'applied' && executionId && result.campaignId) {
      updateRequestContext({ tenantId, campaignId: result.campaignId, module: 'webhooks' });
      appLogger.info({ provider, event_id: result.eventId, status: result.status }, 'webhook.applied');
      await publishProgressSnapshot(this.dataSource, tenantId, result.campaignId, executionId, this.campaignPublisher.publish);
    }

    return { status: result.status, eventId: result.eventId } satisfies ProviderWebhookResult;
      } finally {
        span.end();
      }
    });
  }

  private async applyInTransaction(
    manager: EntityManager,
    input: {
      tenantId: string;
      provider: string;
      campaignRecipientId: string;
      executionId: string | null;
      eventId: string;
      eventType: ProviderWebhookEvent['type'];
      providerMessageId: string;
      occurredAt: Date;
    },
  ): Promise<ApplyOutcome> {
    const { tenantId, provider, campaignRecipientId, executionId, eventId, eventType, providerMessageId, occurredAt } = input;

    // The row lock is what makes A13's concurrency case deterministic: a
    // second, genuinely concurrent request for the same recipient blocks
    // here until the first commits, then re-reads its already-updated state.
    const [locked] = (await manager.query(
      `SELECT status, delivery_state_at, recipient_id, campaign_id FROM campaign_recipient WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [campaignRecipientId, tenantId],
    )) as LockedCampaignRecipientRow[];

    const decision = decideWebhookOutcome(eventType, locked.status, occurredAt, locked.delivery_state_at);

    const inserted = (await manager.query(
      `INSERT INTO delivery_event (tenant_id, provider, provider_event_id, event_type, provider_message_id, campaign_recipient_id, execution_id, occurred_at, outcome, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
       ON CONFLICT (provider, provider_event_id) DO NOTHING
       RETURNING id`,
      [
        tenantId,
        provider,
        eventId,
        eventType,
        providerMessageId,
        campaignRecipientId,
        executionId,
        occurredAt,
        decision.outcome,
        JSON.stringify({ eventId, type: eventType, providerMessageId, occurredAt: occurredAt.toISOString() }),
      ],
    )) as Array<{ id: string }>;

    if (inserted.length === 0) {
      // This exact (provider, provider_event_id) pair already has a ledger
      // row -- BR-SEND-008's "trùng không tăng count" is enforced right
      // here, before any state write is even attempted.
      return { status: 'duplicate', eventId };
    }

    if (decision.outcome === 'applied') {
      if (decision.nextStatus !== null) {
        await manager.query(
          `UPDATE campaign_recipient SET status = $3, delivery_state_at = $4, updated_at = now() WHERE id = $1 AND tenant_id = $2`,
          [campaignRecipientId, tenantId, decision.nextStatus, occurredAt],
        );
      }
      if (decision.suppress !== null) {
        await suppressRecipient(manager, tenantId, locked.recipient_id, decision.suppress, `webhook:${eventId}`);
      }
      return { status: 'applied', eventId, campaignId: locked.campaign_id };
    }

    return { status: 'ignored', eventId };
  }
}
