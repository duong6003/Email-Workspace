import type pg from 'pg';

export const OUTBOX_MAX_ATTEMPTS = 5;

export type OutboxFailure = { attempts: number; deadLettered: boolean };

export function deadLetterDepthMetric(tenantId: string): Record<string, string | number> {
  return { metric: 'eow_dead_letter_depth', tenant_id: tenantId, value: 1 };
}

export async function recordOutboxFailure(
  pool: pg.Pool,
  eventId: string,
  error: unknown,
  tenantId: string,
): Promise<OutboxFailure> {
  const message = error instanceof Error ? error.message : String(error);
  const result = await pool.query<{ attempts: number; dead_lettered: boolean }>(
    `SELECT attempts, dead_lettered
     FROM relay_record_outbox_failure($1, $2, $3)`,
    [eventId, message, OUTBOX_MAX_ATTEMPTS],
  );
  const row = result.rows[0];
  const failure = { attempts: Number(row?.attempts ?? 0), deadLettered: row?.dead_lettered ?? false };
  if (failure.deadLettered) console.log(JSON.stringify(deadLetterDepthMetric(tenantId)));
  return failure;
}
