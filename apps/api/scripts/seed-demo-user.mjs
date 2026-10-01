import { config } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, '../../../.env'), quiet: true });

const pgUser = process.env.EOW_POSTGRES_USER ?? 'eow';
const pgPassword = process.env.EOW_POSTGRES_PASSWORD;
const pgDb = process.env.EOW_POSTGRES_DB ?? 'eow';
const pgBind = process.env.EOW_POSTGRES_BIND ?? '127.0.0.1';
const pgPort = process.env.EOW_POSTGRES_PORT ?? '55432';
process.env.DATABASE_URL = `postgresql://${pgUser}:${pgPassword}@${pgBind}:${pgPort}/${pgDb}`;

const { createDataSource } = await import('../src/database/data-source.ts');
const { TenantEntity } = await import('../src/database/entities/tenant.entity.ts');
const { AppUserEntity } = await import('../src/database/entities/app-user.entity.ts');
const { hashPassword } = await import('../src/auth/password.service.ts');

const ds = createDataSource(process.env.DATABASE_URL);
await ds.initialize();

let tenant = await ds.getRepository(TenantEntity).findOne({ where: { name: 'Acme Demo' } });
if (!tenant) tenant = await ds.getRepository(TenantEntity).save({ name: 'Acme Demo' });

const passwordHash = await hashPassword('Demo!Passw0rd');

// M1-S2 (RBAC): a Viewer fixture alongside the existing Admin fixture, so
// apps/web/e2e can prove BR-AUTH-003/004 (Viewer -> /settings/senders shows
// permission_denied; Viewer -> POST /campaigns/:id/send is 403) against a
// real seeded account, the same way the Admin fixture already backs
// e2e/auth.spec.ts. No explicit user_role row is inserted -- the legacy
// app_user.role text is resolved through PermissionsService's fallback
// (see apps/api/src/auth/permissions.service.ts), the same path every
// pre-004_rbac user-creation call site already relies on.
const demoUsers = [
  { email: 'demo@acme.vn', displayName: 'Nguyễn Demo', role: 'admin' },
  { email: 'demo-viewer@acme.vn', displayName: 'Trần Viewer', role: 'viewer' },
];

for (const fixture of demoUsers) {
  let user = await ds.getRepository(AppUserEntity).findOne({ where: { email: fixture.email } });
  if (!user) {
    user = await ds.getRepository(AppUserEntity).save({
      tenantId: tenant.id,
      email: fixture.email,
      displayName: fixture.displayName,
      role: fixture.role,
      passwordHash,
      status: 'active',
    });
  } else {
    user.passwordHash = passwordHash;
    user.status = 'active';
    user.role = fixture.role;
    await ds.getRepository(AppUserEntity).save(user);
  }
  console.log('Seeded demo user:', fixture.email, 'password: Demo!Passw0rd', 'role:', fixture.role, 'tenant:', tenant.id);
}

await ds.destroy();
