import type { EntityManager } from 'typeorm';

export type SuppressionReason = 'hard_bounce' | 'complaint';

/**
 * BR-SEND-011. Suppression is a single fact with two producers: this app's
 * webhook path (webhooks.service.ts, a bounced/complaint event) and
 * apps/worker's synchronous hard-bounce path
 * (apps/worker/src/campaign-send/suppression.ts, send.ts). Cross-app import
 * is impossible (rootDir: src, no shared package) and the two callers hold
 * different client types -- an EntityManager here, a pg.PoolClient there --
 * so this is a transliteration, not a duplicate that could have been an
 * import -- DEC-107, following DEC-106's retry-backoff.ts precedent.
 * ARCH-SUPPRESSION-PARITY holds the two in step mechanically.
 *
 * MUST be called inside the caller's existing tenant transaction
 * (runInTenantContext): the rule's own acceptance is that the suppression is
 * created atomically with the event. First cause wins -- a later complaint
 * does not overwrite an earlier hard_bounce, and writes no second audit row.
 */
export async function suppressRecipient(
  manager: EntityManager,
  tenantId: string,
  recipientId: string,
  reason: SuppressionReason,
  traceId: string,
): Promise<boolean> {
  const updated = (await manager.query(
    `UPDATE recipient SET subscription_status = 'bounced', suppressed_at = now(), suppression_reason = $3,
            version = version + 1, updated_at = now()
     WHERE id = $1 AND tenant_id = $2 AND suppressed_at IS NULL`,
    [recipientId, tenantId, reason],
  )) as [unknown[], number];
  const [, rowCount] = updated;
  if (rowCount === 0) return false;
  await manager.query(
    `INSERT INTO audit_log (tenant_id, actor_id, action, entity_type, entity_id, trace_id, metadata)
     VALUES ($1, NULL, 'recipient.suppressed', 'recipient', $2, $3, $4::jsonb)`,
    [tenantId, recipientId, traceId, JSON.stringify({ reason })],
  );
  return true;
}
