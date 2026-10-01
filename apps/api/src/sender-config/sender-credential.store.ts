import { decryptSenderSecret, encryptSenderSecret, parseSenderCredentialKey } from '@eow/sender-credentials';
import type { EntityManager } from 'typeorm';

export class SenderCredentialStore {
  private readonly key: Buffer;

  constructor(key: string) {
    this.key = parseSenderCredentialKey(key);
  }

  async put(manager: EntityManager, tenantId: string, secretRef: string, secret: string): Promise<void> {
    const ciphertext = encryptSenderSecret(this.key, tenantId, secretRef, secret);
    await manager.query(
      `INSERT INTO sender_credential (tenant_id, secret_ref, ciphertext)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, secret_ref)
       DO UPDATE SET ciphertext = EXCLUDED.ciphertext, updated_at = now()`,
      [tenantId, secretRef, ciphertext],
    );
  }

  async resolve(manager: EntityManager, tenantId: string, secretRef: string): Promise<string | undefined> {
    const legacySecret = process.env[secretRef];
    if (legacySecret !== undefined) return legacySecret;
    const [row] = await manager.query(
      `SELECT ciphertext FROM sender_credential WHERE tenant_id = $1 AND secret_ref = $2`,
      [tenantId, secretRef],
    ) as Array<{ ciphertext: string }>;
    return row ? decryptSenderSecret(this.key, tenantId, secretRef, row.ciphertext) : undefined;
  }

  async has(manager: EntityManager, tenantId: string, secretRef: string): Promise<boolean> {
    try {
      return await this.resolve(manager, tenantId, secretRef) !== undefined;
    } catch {
      return false;
    }
  }

  async configuredReferences(manager: EntityManager, tenantId: string, secretRefs: string[]): Promise<Set<string>> {
    const configured = new Set(secretRefs.filter((secretRef) => process.env[secretRef] !== undefined));
    if (secretRefs.length === 0) return configured;
    const rows = await manager.query(
      `SELECT secret_ref, ciphertext FROM sender_credential WHERE tenant_id = $1 AND secret_ref = ANY($2::text[])`,
      [tenantId, secretRefs],
    ) as Array<{ secret_ref: string; ciphertext: string }>;
    for (const row of rows) {
      try {
        decryptSenderSecret(this.key, tenantId, row.secret_ref, row.ciphertext);
        configured.add(row.secret_ref);
      } catch {
        continue;
      }
    }
    return configured;
  }
}
