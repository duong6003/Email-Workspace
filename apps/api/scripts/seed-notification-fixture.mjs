// Dev/e2e-only fixture: creates one real notification via the real
// NotificationsService (not a raw INSERT), for apps/web/e2e visual-capture
// scenarios that need a controlled severity/deep-link/category combination
// that the currently-wired import/bulk triggers cannot produce on demand.
// Intentionally not an HTTP endpoint -- notifications have no public create
// API (BR-NOT-002: recipients are resolved server-side from real events),
// so this stays a repo-local script, invoked from Node, never shipped.
import { config } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, '../../../.env'), quiet: true });

const pgUser = process.env.EOW_POSTGRES_USER ?? 'eow';
const pgPassword = process.env.EOW_POSTGRES_PASSWORD;
const pgDb = process.env.EOW_POSTGRES_DB ?? 'eow';
const pgBind = process.env.EOW_POSTGRES_BIND ?? '127.0.0.1';
const pgPort = process.env.EOW_POSTGRES_PORT ?? '55432';
process.env.DATABASE_URL = `postgresql://${pgUser}:${pgPassword}@${pgBind}:${pgPort}/${pgDb}`;

const args = JSON.parse(process.argv[2]);

// From `dist`, not `src`. These are NestJS/TypeORM classes, and D-22 applies
// here exactly as it does to running the API itself: tsx/esbuild does not emit
// TypeScript decorator metadata, so importing the sources throws
// ColumnTypeUndefinedError before this script reaches its first query. Run
// `pnpm build` (or `pnpm --filter @eow/api build`) before the e2e suite.
const { createDataSource } = await import('../dist/database/data-source.js');
const { AppUserEntity } = await import('../dist/database/entities/app-user.entity.js');
const { NotificationsService } = await import('../dist/notifications/notifications.service.js');

const ds = createDataSource(process.env.DATABASE_URL);
await ds.initialize();
const user = await ds.getRepository(AppUserEntity).findOneByOrFail({ email: args.email });

const service = new NotificationsService(ds);
let entityType = null;
let entityId = null;
if (args.deepLinkRoute) {
  const [target] = await ds.query(
    `INSERT INTO import_job (tenant_id, file_name, total_rows) VALUES ($1, $2, 0) RETURNING id`,
    [user.tenantId, `notification-fixture-${randomUUID()}.csv`],
  );
  entityType = 'import_job';
  entityId = target.id;
}
await service.createForUsers(user.tenantId, {
  sourceEventId: `${args.type}:${randomUUID()}`,
  type: args.type,
  severity: args.severity,
  title: args.title,
  body: args.body,
  category: args.category,
  userIds: [user.id],
  messageKey: args.messageKey ?? args.type,
  params: {},
  deepLinkRoute: args.deepLinkRoute ?? null,
  entityType,
  entityId,
});

await ds.destroy();
