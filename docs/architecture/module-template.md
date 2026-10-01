# Canonical feature-module template

Use this shape for new API features after the standardization restructure:

```text
apps/api/src/<feature>/
  <feature>.module.ts
  <feature>.controller.ts
  <feature>.service.ts
  <feature>.repository.ts       # required when tenant-owned data is touched
  dto/
    <feature>.dto.ts
  *.test.ts                     # pure unit tests, co-located with the subject

apps/api/test/integration/
  <feature>.test.ts             # PostgreSQL, Redis, Nest boot, or HTTP tests
```

Controllers own HTTP translation only. They read `request.auth.tenantId` after the global
guard, apply `@RequirePermission`, Zod DTO schemas through `ZodValidationPipe`, CSRF guards
for cookie-authenticated mutations, and `@AuditLog` for auditable actions. Controllers must
not import database entities.

Services own business rules and accept the trusted tenant id explicitly. Tenant-owned work
runs through `runInTenantContext`; every repository used inside the callback is constructed
from that callback's `EntityManager`. Do not use a default injected repository from inside a
tenant transaction.

Repositories are the only feature-layer files allowed to call `manager.getRepository` for
tenant-owned entities. They extend `TenantScopedRepository`, retaining explicit tenant
predicates and tenant stamping as application-level defence in depth beneath PostgreSQL RLS.

The `jobs/` directory remains one bounded context: import and bulk-recipient jobs share the
idempotency, outbox, selection-snapshot, custom-field, and worker contracts. It may contain
multiple controllers/services, but keeps one `JobsModule`, one `dto/` boundary, and tenant-
scoped repository boundaries; splitting directories without splitting those contracts would
only create cross-module coupling.

Frontend production modules live below `app/`, `api/`, `auth/`, `overlays/`, `screens/`, or
`types/`; only `main.tsx` may live directly under `apps/web/src`.

Generate the canonical starting shape with
`corepack pnpm generate:api-module -- <kebab-name> <EntityNameEntity> <entity-file>`. This
command builds and runs the workspace's `@eow/api-schematics` Angular DevKit collection,
which is also registered as the API's Nest collection in `apps/api/nest-cli.json`. Optional
fourth and fifth arguments select the read and manage permission constants.

The schematic refuses overwrites and emits the post-restructure module/controller/service/
tenant-repository/dto shape, a co-located unit-test placeholder, and an integration-test
placeholder under `apps/api/test/integration`. Register the module in `AppModule`, replace
both placeholders with behavioral coverage, and confirm the selected entity and permissions;
generated placeholders are never completion evidence.

The generator dependencies are development-only, MIT-licensed official NestJS/Angular
packages. They do not enter application source imports or browser bundles. Dependency and
container-impact review must be repeated when their pinned versions change.
