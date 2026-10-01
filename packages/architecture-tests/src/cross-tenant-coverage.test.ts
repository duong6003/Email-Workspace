import { describe, expect, it } from 'vitest';
import { describeViolations, listFiles, read } from './repo.js';

/**
 * ARCH-CROSS-TENANT.
 *
 * Every tenant-owned controller route must be named by a cross-tenant
 * negative test. This turns the M7-S2 success condition into a build rule:
 * adding a route without adding its negative test fails in the same change.
 */

type Route = { method: string; path: string };

const PUBLIC_OR_TENANTLESS: Array<{ route: string; reason: string }> = [
  { route: 'GET /health', reason: '@Public() liveness probe; no tenant resource is read.' },
  {
    route: 'GET /health/ready',
    reason:
      '@Public() readiness probe added by M7-S4 (BR-SEC-005). It reads no tenant-owned row at all -- it runs '
      + 'SELECT 1 and a Redis PING -- and is consumed by the compose healthcheck, which holds no session. Same '
      + 'class as GET /health above.',
  },
  { route: 'POST /auth/login', reason: 'Pre-session route; tenant identity is established by authentication.' },
  { route: 'POST /auth/refresh', reason: 'Session rotation derives the tenant from the signed session cookie.' },
  { route: 'POST /auth/logout', reason: 'Session revocation derives the tenant from the signed session cookie.' },
  { route: 'GET /auth/me', reason: 'Returns only the principal resolved from the signed session cookie.' },
  { route: 'POST /auth/forgot-password', reason: 'Pre-session route with a non-enumerating response.' },
  { route: 'POST /auth/reset-password', reason: 'Pre-session route guarded by a single-use reset token.' },
  {
    route: 'POST /webhooks/providers/:id',
    reason: 'Provider-authenticated by HMAC; tenant identity comes from the verified provider payload.',
  },
  {
    route: 'GET /assets/:id/:id',
    reason:
      'ADR-043 §2: the asset serving route is @Public() because the fetch comes from a recipient mail client that '
      + 'carries none of our cookies, so there is no session to derive a tenant from and a cross-tenant negative test '
      + 'would be asserting the opposite of the design. The unguessable id IS the capability; the tenant is read off '
      + 'the row the id resolves to and can never be supplied by a caller, and no path or storage key is accepted, so '
      + 'there is nothing to traverse. assets-http.test.ts covers this route from the other direction -- it asserts '
      + 'that a caller with NO session is served, which is the property that would otherwise be "fixed" away.',
  },
  {
    route: 'GET /unsubscribe/:id',
    reason:
      'ADR-049: the recipient-facing opt-out route is @Public() because the click comes from a mail client with none '
      + 'of our cookies -- the same position as the asset serving route above, and a cross-tenant negative test would '
      + 'assert the opposite of the design. There is no tenant to supply: the signed token resolves to one recipient, '
      + 'the tenant is read off that row, and a caller can supply neither. This route is read-only and reports the '
      + 'same 404 for a bad signature as for an unknown recipient, so it cannot be used to probe which ids exist. '
      + 'unsubscribe-rls.test.ts covers it from the other direction, as eow_app, which is the only role that can see '
      + 'the RLS behaviour this depends on.',
  },
  {
    route: 'POST /unsubscribe/:id',
    reason:
      'ADR-049, and the only public state-changing route in the API. The capability is the HMAC signature in the '
      + 'token, not a session, so there is no tenant context to cross. What bounds the damage is that the write goes '
      + 'through redeem_unsubscribe (079), whose target status is a literal in the function body: it can only ever '
      + 'unsubscribe, never reactivate (BR-REC-004 reserves that for an Admin) and never touch another column. '
      + 'unsubscribe-rls.test.ts asserts exactly that, against the real runtime role.',
  },
];

const CROSS_TENANT_MARKERS = /cross-tenant|other tenant|another tenant|BR-GEN-002|TC-SEC-009/i;
const ROUTE_DECORATOR = /@(Get|Post|Patch|Put|Delete)\s*\(\s*([^)]*)\)/g;
const HTTP_CALL = /\.(get|post|patch|put|delete)\s*\(\s*(['"`])([^'"`]+)\2/g;
const COVERAGE_DECLARATION = /['"`]((?:GET|POST|PATCH|PUT|DELETE) \/[^'"`]+)['"`]/g;

function unquote(value: string | undefined): string {
  return (value ?? '').trim().replace(/^['"`]|['"`]$/g, '');
}

function normalizePath(value: string): string {
  const withoutQuery = value.split('?')[0] ?? value;
  const withoutPrefix = withoutQuery.replace(/^\/api\/v1(?=\/|$)/, '');
  const normalized = withoutPrefix
    .replace(/\$\{[^}]+\}/g, ':id')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, ':id')
    .replace(/\{[^}]+\}/g, ':id')
    .replace(/:[A-Za-z][A-Za-z0-9_]*/g, ':id')
    .replace(/\/+/, '/')
    .replace(/\/$/, '');
  return normalized.startsWith('/') ? normalized || '/' : `/${normalized}`;
}

function controllerRoutes(): string[] {
  const controllers = listFiles('apps/api/src', ['.ts']).filter(
    (file) => read(file).includes('@Controller') && !file.endsWith('.test.ts'),
  );
  const routes = new Set<string>();

  for (const file of controllers) {
    const source = read(file);
    const controllerPath = unquote(/@Controller\s*\(\s*([^)]*)\)/.exec(source)?.[1]);
    ROUTE_DECORATOR.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ROUTE_DECORATOR.exec(source)) !== null) {
      const method = match[1]!.toUpperCase();
      const handlerPath = unquote(match[2]);
      routes.add(`${method} ${normalizePath([controllerPath, handlerPath].filter(Boolean).join('/'))}`);
    }
  }

  expect(routes.size, 'no controller routes found — the scanner path is probably wrong').toBeGreaterThan(0);
  return [...routes].sort();
}

function coveredRoutes(): Set<string> {
  const tests = [
    ...listFiles('apps/api/test', ['.test.ts', '.spec.ts']),
    ...listFiles('apps/api/src', ['.test.ts', '.spec.ts']),
  ];
  const covered = new Set<string>();

  for (const file of tests) {
    const source = read(file);
    if (!CROSS_TENANT_MARKERS.test(source)) continue;
    HTTP_CALL.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = HTTP_CALL.exec(source)) !== null) {
      covered.add(`${match[1]!.toUpperCase()} ${normalizePath(match[3]!)}`);
    }
    COVERAGE_DECLARATION.lastIndex = 0;
    while ((match = COVERAGE_DECLARATION.exec(source)) !== null) {
      const separator = match[1]!.indexOf(' ');
      covered.add(`${match[1]!.slice(0, separator)} ${normalizePath(match[1]!.slice(separator + 1))}`);
    }
  }
  return covered;
}

describe('ARCH-CROSS-TENANT: every tenant-owned route has a negative test', () => {
  it('has no uncovered tenant-owned controller route', () => {
    const routes = controllerRoutes();
    const covered = coveredRoutes();
    const exclusions = new Set(PUBLIC_OR_TENANTLESS.map(({ route }) => route));
    const uncovered = routes.filter((route) => !covered.has(route) && !exclusions.has(route));

    expect(
      uncovered,
      `Tenant-owned route(s) have no cross-tenant negative test:${describeViolations(uncovered)}`,
    ).toEqual([]);
  });

  it('keeps every public-or-tenantless exception reasoned and current', () => {
    const routes = new Set(controllerRoutes());
    const violations = PUBLIC_OR_TENANTLESS.flatMap(({ route, reason }) => {
      const failures: string[] = [];
      if (!reason.trim()) failures.push(`${route}: missing reason`);
      if (!routes.has(route)) failures.push(`${route}: route no longer exists`);
      return failures;
    });
    expect(violations, `Stale or unexplained exception(s):${describeViolations(violations)}`).toEqual([]);
  });
});
