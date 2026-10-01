import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, type EntityManager } from 'typeorm';
import type { ValidatedEnv } from '../config/env.js';
import { readUnsubscribeToken } from './unsubscribe-token.js';

/**
 * ADR-049. What the recipient-facing opt-out route may do, and nothing else.
 *
 * Every method here takes the raw token from the URL and verifies it before
 * touching the database, so the signature is the only thing that authorises an
 * unsubscribe. A caller that holds a recipient id and no signature gets the
 * same answer as one that holds nothing.
 *
 * Both database calls go through SECURITY DEFINER functions
 * (079_unsubscribe_redeem.sql) because this route is `@Public()` and therefore
 * has no tenant context -- the precise trap 077_asset_serve_bypass.sql
 * documented, where a tenant-blind query as `eow_app` silently matches zero
 * rows against an RLS policy comparing `tenant_id` to NULL.
 */

/** What both routes report. `null` when the token does not verify OR the recipient is gone -- deliberately the same answer, so the route cannot be used to tell a real recipient id from a forged one. */
export type UnsubscribeTarget = { email: string; alreadyUnsubscribed: boolean };

type TargetRow = { email: string; already_unsubscribed: boolean };

@Injectable()
export class UnsubscribeService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService<ValidatedEnv, true>,
  ) {}

  private recipientIdFrom(token: string): string | null {
    return readUnsubscribeToken(token, this.config.get('SESSION_SECRET', { infer: true }));
  }

  /**
   * What the confirmation page shows. Read-only on purpose: mail security
   * scanners fetch links in transit, so a GET that unsubscribed would
   * unsubscribe people who never clicked anything.
   */
  async describe(token: string): Promise<UnsubscribeTarget | null> {
    const recipientId = this.recipientIdFrom(token);
    if (!recipientId) return null;
    return this.dataSource.transaction(async (manager: EntityManager) => {
      const rows = await manager.query<TargetRow[]>('SELECT * FROM find_unsubscribe_target($1)', [recipientId]);
      const row = rows[0];
      return row ? { email: row.email, alreadyUnsubscribed: row.already_unsubscribed } : null;
    });
  }

  /**
   * The act itself, and the only write this route can make. Idempotent: a
   * second click reports success rather than failing, because the recipient's
   * intent is already satisfied and an error would read as "it did not work".
   */
  async redeem(token: string, traceId: string): Promise<UnsubscribeTarget | null> {
    const recipientId = this.recipientIdFrom(token);
    if (!recipientId) return null;
    return this.dataSource.transaction(async (manager: EntityManager) => {
      const rows = await manager.query<TargetRow[]>('SELECT * FROM redeem_unsubscribe($1, $2)', [recipientId, traceId]);
      const row = rows[0];
      return row ? { email: row.email, alreadyUnsubscribed: row.already_unsubscribed } : null;
    });
  }
}
