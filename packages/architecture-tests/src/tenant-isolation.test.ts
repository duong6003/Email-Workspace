import { describe, expect, it } from 'vitest';
import { describeViolations, listFiles, read } from './repo.js';

/**
 * ARCH-TENANT: the highest-severity invariant in the product. AGENTS.md §4 —
 * "Every tenant-owned row carries tenant_id; authorization is enforced
 * server-side" — and BR-GEN-002 (P0): "Mọi truy vấn và lệnh ghi bắt buộc có
 * organization_id **lấy từ token**".
 *
 * TenantScopedRepository enforces this for ORM access. Raw SQL bypasses it
 * completely and silently: a `SELECT ... WHERE id = $1` with no tenant
 * predicate returns another tenant's row with no error, no log and no failing
 * test — the exact shape of a cross-tenant leak.
 *
 * Scope is deliberately `apps/api` only. BR-GEN-002's subject is the
 * *request-scoped* path, where a caller token exists and must constrain the
 * query. `apps/worker` has no token: it is a trusted background processor that
 * by design works across every tenant's jobs, so demanding a tenant predicate
 * there would be incoherent and would train agents to add meaningless filters.
 * The worker's isolation guarantee is a different one — a job may only touch
 * rows belonging to the tenant frozen into its own selection snapshot — and it
 * is covered by real integration tests ("applies a frozen custom-data update
 * only to in-tenant recipients" in bulk-processor.integration.test.ts).
 */
const RAW_QUERY = /\.query\s*\(/;
const TRANSACTION_CONTROL = /\.query\s*\(\s*['"`](BEGIN|COMMIT|ROLLBACK)/i;
const TENANT_ENTITY_IMPORT = /entities\/(recipient|recipient-list|recipient-list-member|recipient-tag|tag|custom-field-definition|campaign|campaign-recipient|campaign-snapshot|email-template|email-template-version|import-job|import-job-row|bulk-job|bulk-job-row|notification|user-notification|audit-log|outbox-event|idempotency-key|user-role|reusable-block|asset)\.entity\.js/;
/**
 * Matches `.getRepository(` on ANY receiver, deliberately.
 *
 * A previous version anchored this to `(?:dataSource|manager)\.getRepository`,
 * which made the rule name-dependent: a review found that renaming the variable
 * to `em`, `db` or anything else slipped straight through, while `manager` and
 * `dataSource` were caught. Since agents choose variable names freely, a
 * name-anchored rule cannot hold the invariant it exists for — and this is the
 * exact rule that exists to prevent the `segments` cross-tenant bypass.
 *
 * Broadening is safe here because a file only reaches this check when it also
 * imports a tenant-owned entity (TENANT_ENTITY_IMPORT). The auth module's
 * `.getRepository()` calls operate on app_user/user_session/login_attempt/
 * password_reset_token, which are intentionally not tenant-owned for RLS
 * purposes, so they are filtered out before this pattern is applied.
 */
const ORM_REPOSITORY_ACCESS = /\.getRepository\s*\(/;

/** Raw queries that legitimately carry no tenant predicate. Each entry must say why. */
const ALLOWED: ReadonlyArray<{ file: string; reason: string }> = [
  {
    file: 'apps/api/src/database/tenant-scoped.repository.ts',
    reason: 'this IS the tenant-scoping primitive every other call site goes through',
  },
  {
    file: 'apps/api/src/health/readiness.service.ts',
    reason:
      'BR-SEC-005 readiness probe (M7-S4). Its only statement is `SELECT 1`, which reads no table and therefore ' +
      'has no tenant dimension to scope by; the route is @Public() and returns a boolean plus a latency, never a row',
  },
  {
    file: 'apps/api/src/auth/permissions.service.ts',
    reason:
      'scoped by user_id, a primary key that is itself a tenant boundary and is resolved from the validated session ' +
      'by AuthGuard; role/permission/role_permission are global catalogues (004_rbac.sql), not tenant-owned',
  },
];

describe('ARCH-TENANT: raw SQL cannot bypass tenant scoping (AGENTS.md §4, BR-GEN-002)', () => {
  it('has no request-scoped raw query without a tenant_id predicate outside the documented allowlist', () => {
    const sources = listFiles('apps/api/src', ['.ts']).filter((file) => !file.endsWith('.test.ts'));
    expect(sources.length, 'no sources found — scanner path is wrong').toBeGreaterThan(0);

    const allowedFiles = new Set(ALLOWED.map((entry) => entry.file));
    const violations: string[] = [];

    for (const file of sources) {
      if (allowedFiles.has(file)) continue;
      const lines = read(file).split(/\r?\n/);

      lines.forEach((line, index) => {
        if (!RAW_QUERY.test(line) || TRANSACTION_CONTROL.test(line)) return;
        // A query's SQL may span several lines; inspect the statement window.
        const window = lines.slice(index, index + 12).join('\n');
        if (!/\b(SELECT|INSERT|UPDATE|DELETE)\b/i.test(window)) return;
        if (!/tenant_id/i.test(window)) violations.push(`${file}:${index + 1}  ${line.trim().slice(0, 80)}`);
      });
    }

    expect(
      violations,
      `Raw SQL without a tenant_id predicate on the request-scoped path. Either scope it by tenant, route it ` +
        `through TenantScopedRepository, or add it to ALLOWED in this file with a written reason:${describeViolations(violations)}`,
    ).toEqual([]);
  });

  it('keeps the allowlist documented — every entry states why it is safe', () => {
    for (const entry of ALLOWED) {
      expect(entry.reason.length, `${entry.file} has no reason recorded`).toBeGreaterThan(30);
    }
  });
  it('routes ORM access to tenant-owned entities through a tenant-scoped repository', () => {
    const sources = listFiles('apps/api/src', ['.ts']).filter(
      (file) => !file.endsWith('.test.ts') && !file.includes('/database/') && !file.endsWith('.repository.ts'),
    );
    const tenantAwareInfrastructure: ReadonlyArray<{ file: string; reason: string }> = [
      {
        file: 'apps/api/src/common/audit-writer.ts',
        reason: 'shared audit primitive receives an already tenant-bound EntityManager and always writes tenantId',
      },
      {
        file: 'apps/api/src/common/idempotency.service.ts',
        reason: 'shared idempotency primitive receives an already tenant-bound EntityManager and keys every access by tenantId',
      },
      {
        file: 'apps/api/src/outbox/outbox-writer.ts',
        reason: 'shared outbox primitive receives an already tenant-bound EntityManager and always writes tenantId',
      },
    ];
    const infrastructureFiles = new Set(tenantAwareInfrastructure.map((entry) => entry.file));
    const violations: string[] = [];

    for (const file of sources) {
      if (infrastructureFiles.has(file)) continue;
      const source = read(file);
      if (!TENANT_ENTITY_IMPORT.test(source) || !ORM_REPOSITORY_ACCESS.test(source)) continue;
      source.split(/\r?\n/).forEach((line, index) => {
        if (ORM_REPOSITORY_ACCESS.test(line)) violations.push(`${file}:${index + 1}  ${line.trim().slice(0, 90)}`);
      });
    }

    expect(
      violations,
      `Direct TypeORM repository access to a tenant-owned entity bypasses TenantScopedRepository. ` +
        `Move it into a tenant-scoped *.repository.ts boundary:${describeViolations(violations)}`,
    ).toEqual([]);
    for (const entry of tenantAwareInfrastructure) {
      expect(entry.reason.length, `${entry.file} has no reason recorded`).toBeGreaterThan(30);
    }
  });

  it('keeps repository files tenant-scoped or explicitly transaction-bound', () => {
    const repositories = listFiles('apps/api/src', ['.repository.ts']);
    const transactionBound: ReadonlyArray<{ file: string; reason: string }> = [
      {
        file: 'apps/api/src/jobs/jobs.repository.ts',
        reason: 'constructed only from the EntityManager supplied by runInTenantContext; every parent entity read also carries tenantId',
      },
    ];
    const allowed = new Set(transactionBound.map((entry) => entry.file));
    const violations = repositories.filter((file) => {
      const source = read(file);
      if (!TENANT_ENTITY_IMPORT.test(source) || !ORM_REPOSITORY_ACCESS.test(source)) return false;
      return !/extends\s+TenantScopedRepository/.test(source) && !allowed.has(file);
    });
    expect(
      violations,
      `Repository files with direct tenant-entity access must extend TenantScopedRepository or be a documented transaction-bound unit-of-work boundary:${describeViolations(violations)}`,
    ).toEqual([]);
    for (const entry of transactionBound) {
      expect(entry.reason.length, `${entry.file} has no reason recorded`).toBeGreaterThan(30);
      const source = read(entry.file);
      expect(source, `${entry.file} must accept a transaction-bound EntityManager`).toMatch(/constructor\([^)]*EntityManager/);
    }
  });
});
