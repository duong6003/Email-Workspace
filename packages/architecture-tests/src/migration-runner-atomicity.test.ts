import { describe, expect, it } from 'vitest';
import { read } from './repo.js';

/**
 * DEPLOY-005: a migration's DDL and schema_migrations ledger record must commit
 * together. Without one psql session and transaction, an interrupted run leaves
 * schema state that a retry cannot safely distinguish from a published migration.
 */
describe('ARCH-MIGRATION: migration runner records DDL atomically (DEPLOY-005)', () => {
  it('streams each migration and its ledger record through one transaction', () => {
    const script = read('database/migrate.sh');

    const include = script.indexOf('\\i :migration_file');
    const ledgerInsert = script.indexOf('INSERT INTO schema_migrations');
    const commit = script.indexOf("printf 'COMMIT;\\n'");
    const applied = script.indexOf('Migration :id applied.');

    expect(script).toMatch(/printf 'BEGIN ISOLATION LEVEL READ COMMITTED;\\n'/);
    expect(script).toMatch(/CREATE TABLE IF NOT EXISTS schema_migrations/);
    expect(include).toBeGreaterThanOrEqual(0);
    expect(ledgerInsert).toBeGreaterThan(include);
    expect(commit).toBeGreaterThan(ledgerInsert);
    expect(applied).toBeGreaterThan(commit);
    expect(script).toMatch(/\} \| psql -X -w -v ON_ERROR_STOP=1 -v app_password=.*-v id=.*-v checksum=.*-v migration_file=/);
    expect(script).not.toMatch(/cat "\$migration_file"/);
    expect(script).not.toMatch(/\\g \/dev\/null/);
    expect(script).not.toMatch(/psql -v ON_ERROR_STOP=1 -v app_password="\$EOW_POSTGRES_APP_PASSWORD" -f "\$migration_file"/);

    const transactionId = script.indexOf('migration_outer_transaction_id');
    const transactionIntact = script.lastIndexOf('migration_outer_transaction_id');
    const sourceGuard = script.indexOf('migration_source_is_safe');
    expect(sourceGuard).toBeGreaterThanOrEqual(0);
    expect(sourceGuard).toBeLessThan(include);
    expect(script).toMatch(/if ! migration_source_is_safe "\$migration_file"; then/);
    expect(script).toContain('if (copy_data && unsafe == 0) reject()');
    expect(transactionId).toBeGreaterThanOrEqual(0);
    expect(transactionId).toBeLessThan(include);
    expect(transactionIntact).toBeGreaterThan(include);
    expect(transactionIntact).toBeLessThan(ledgerInsert);
    expect(script).toMatch(/SELECT txid_current\(\) = :%s::bigint AS migration_outer_transaction_intact \\\\gset/);
    expect(script).toContain("'migration_outer_transaction_id'");
  });

  it('locks competing runners before rechecking migration ledger state', () => {
    const script = read('database/migrate.sh');
    const lock = script.indexOf('pg_advisory_xact_lock');
    const recheck = script.indexOf('migration_checksum_mismatch');

    expect(lock).toBeGreaterThanOrEqual(0);
    expect(recheck).toBeGreaterThan(lock);
    expect(script).toMatch(/NOT EXISTS \(SELECT FROM schema_migrations WHERE id = :%s\) AS migration_pending/);
    expect(script).toMatch(/\\if :migration_pending/);
    expect(script).toMatch(/SELECT 'Published migration ' \|\| :%s \|\| ' changed; add a forward migration instead\.' AS migration_error.*\\gset/);
    expect(script).toMatch(/SELECT :'migration_error'::text::integer;/);
    expect(script).toMatch(/-- Published migration :id changed; add a forward migration instead\./);
    expect(script).not.toMatch(/\\quit 1/);
    expect(script).not.toMatch(/stored="\$\(printf 'SELECT checksum FROM schema_migrations/);
  });

  it('computes SHA-256 without requiring GNU sha256sum', () => {
    const script = read('database/migrate.sh');

    expect(script).toMatch(/command -v sha256sum/);
    expect(script).toMatch(/command -v shasum/);
    expect(script).toMatch(/command -v openssl/);
    expect(script).toMatch(/Migration checksum tool unavailable/);
    expect(script).toMatch(/Migration checksum command failed: sha256sum/);
    expect(script).toMatch(/Migration checksum command failed: shasum/);
    expect(script).toMatch(/Migration checksum command failed: openssl/);
    expect(script).toMatch(/Migration checksum output is not a lowercase SHA-256 digest/);
    expect(script).toMatch(/\[ "\$\{#checksum\}" -ne 64 \]/);
    expect(script).toContain("LC_ALL=C awk '");
    expect(script).toContain('if (position > 1)');
    expect(script).toContain('if (is_identifier_continuation(previous)) return ""');
    expect(script).toContain('character ~ /[\\200-\\377]/');
    expect(script).toContain('checksum_output="$(sha256sum "$1")" || {');
    expect(script).toContain('checksum_output="$(shasum -a 256 "$1")" || {');
    expect(script).toContain('checksum_output="$(openssl dgst -sha256 "$1")" || {');
    expect(script).not.toContain('sha256sum "$1" | awk');
    expect(script).not.toContain('shasum -a 256 "$1" | awk');
    expect(script).not.toContain('openssl dgst -sha256 "$1" | awk');

    const checksumCall = script.indexOf('checksum="$(migration_checksum "$migration_file")"');
    const psql = script.indexOf('| psql -X -w');
    expect(checksumCall).toBeGreaterThanOrEqual(0);
    expect(psql).toBeGreaterThan(checksumCall);
  });
});
