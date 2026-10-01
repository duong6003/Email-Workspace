import type pg from 'pg';

export type SuppressionReason = 'hard_bounce' | 'complaint';

/**
 * BR-SEND-011. Suppression is a single fact with two producers: this app's
 * synchronous hard-bounce path (send.ts) and apps/api's webhook path
 * (apps/api/src/webhooks/suppression.ts). Cross-app import is impossible
 * (rootDir: src, no shared package) and the two callers hold different client
 * types, so the API copy is a transliteration, not a duplicate that could have
 * been an import -- DEC-107, following DEC-106's retry-backoff.ts precedent.
 * ARCH-SUPPRESSION-PARITY holds the two in step mechanically.
 *
 * MUST be called inside the caller's existing tenant transaction: the rule's
 * own acceptance is that the suppression is created atomically with the event.
 * First cause wins -- a later complaint does not overwrite an earlier
 * hard_bounce, and writes no second audit row (D-108's own regression case).
 */
export async function suppressRecipient(
  client: pg.PoolClient,
  tenantId: string,
  recipientId: string,
  reason: SuppressionReason,
  traceId: string,
): Promise<boolean> {
  const updated = (await client.query(
    `UPDATE recipient SET subscription_status = 'bounced', suppressed_at = now(), suppression_reason = $3,
            version = version + 1, updated_at = now()
     WHERE id = $1 AND tenant_id = $2 AND suppressed_at IS NULL`,
    [recipientId, tenantId, reason],
  )) as { rowCount: number };
  if (updated.rowCount === 0) return false;
  await client.query(
    `INSERT INTO audit_log (tenant_id, actor_id, action, entity_type, entity_id, trace_id, metadata)
     VALUES ($1, NULL, 'recipient.suppressed', 'recipient', $2, $3, $4::jsonb)`,
    [tenantId, recipientId, traceId, JSON.stringify({ reason })],
  );
  return true;
}
