# Configured-Variable Defect Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the 5 logic/product defects and 2 infrastructure gaps found in the `template-variables` work (HEAD `4813b17`), plus the UX/a11y debt introduced by the new shared modal primitives.

**Architecture:** The API keeps its existing service/repository split — key-availability rules and the delete-dependency query are corrected in place and covered by real-database integration tests modelled on `custom-field-dependency.test.ts`. The web app keeps its established convention of *pure logic in `.ts` modules, tested with vitest; React components stay untested* — every behavioural fix therefore lands as a small exported function plus a component that calls it. Tenant-wide (`global`) variables regain a dedicated management surface under Settings, recorded in a new ADR because ADR-032 is Accepted and must not be edited silently (AGENTS.md §5).

**Tech Stack:** NestJS + TypeORM + PostgreSQL (api), React + React Router (web), Zod DTOs, Vitest, node:test for `scripts/`, OpenAPI 3.0 contract with a CI compatibility gate.

---

## Locked decisions

| Decision | Choice | Consequence |
| --- | --- | --- |
| Global variable ownership | **Restore a dedicated management surface** | New `/settings/global-variables` screen; ADR-033 supersedes ADR-032's UI-placement clause only |
| Scope | **All findings: P1 + P2 + P3 + infrastructure** | 12 tasks below |

## Baseline

- HEAD `4813b17`, clean tree (7 untracked `.agents/runs/` dirs are unrelated evidence — leave them).
- Verified green baseline: **1263 passed / 0 skipped / 210 files**, via `pnpm check`.
- ⚠️ **`pnpm test` alone fails two `boot.test.ts` cases** because `packages/sender-credentials/dist` does not exist. Always `pnpm build` (or `pnpm check`) first. This is an environment trap, not a regression.
- API integration tests need infra: `pnpm infra:up`.

## File structure

**Modify (api):**
- `apps/api/src/configured-variables/configured-variables.repository.ts` — add one lookup for template-scoped keys across templates.
- `apps/api/src/configured-variables/configured-variables.service.ts` — symmetric shadow rules; template-scoped delete-dependency query.

**Create (api tests):**
- `apps/api/test/integration/configured-variable-keys.test.ts` — the four key-availability rules.
- `apps/api/test/integration/configured-variable-dependency.test.ts` — delete blocking, scoped per template.
- `apps/api/test/integration/test-password.ts` — per-file argon2id hash memoisation.

**Create (web):**
- `apps/web/src/overlays/configured-variable-form.ts` + `.test.ts` — payload/validation logic pulled out of the overlay (this is where the P1 bug lives).
- `apps/web/src/screens/settings/GlobalVariablesScreen.tsx` — restored management surface.
- `apps/web/src/components/focus-trap.ts` + `.test.ts` — Tab-wrapping logic for `ModalFrame`.
- `apps/web/src/api/sequence-guard.ts` + `.test.ts` — last-write-wins guard for debounced analysis.

**Modify (web):**
- `apps/web/src/overlays/ManageConfiguredVariableOverlay.tsx` — consume the pure form module.
- `apps/web/src/components/ModalFrame.tsx` — Escape, focus trap, focus restore.
- `apps/web/src/screens/templates/TemplatesScreen.tsx` — unsaved-changes guard, analysis race guard.
- `apps/web/src/screens/templates/template-editor.ts` + `.test.ts` — dirty-state helper.
- `apps/web/src/screens/drafts/DraftsScreen.tsx` — confirmation before deleting a draft.
- `apps/web/src/app/nav.ts`, `apps/web/src/app/AppRoutes.tsx` — register the new screen.

**Modify (infra/docs):**
- `scripts/openapi-compat-check.mjs` + `scripts/openapi-compat-check.test.mjs` — enum-narrowing detection.
- `scripts/no-skipped-tests-reporter.mjs` — report the hook failure that caused the skips.
- `.github/workflows/ci.yml` — run the `scripts/` node:test suite.
- `docs/adr/adr-033-tenant-global-variable-ownership.md` — new ADR.

⚠️ `packages/architecture-tests/src/structure.test.ts` enforces **ARCH-NO-ORPHANS**: every production web module must be reachable from `apps/web/src/main.tsx`. Each new `.ts`/`.tsx` file above must be imported by something reachable, or that test fails.

---

### Task 1: API — symmetric shadow rules for variable keys

ADR-032 states a template-local key may not shadow a system variable, a tenant-global variable or a recipient field. Today that is enforced only when creating the *template* variable. Creating a **global** variable whose key a template already owns silently produces the forbidden shadow.

**Files:**
- Modify: `apps/api/src/configured-variables/configured-variables.repository.ts`
- Modify: `apps/api/src/configured-variables/configured-variables.service.ts:124-140`
- Test: `apps/api/test/integration/configured-variable-keys.test.ts` (create)

- [ ] **Step 1: Start infra (once for the whole plan)**

```bash
pnpm infra:up
```

Expected: `postgres`, `redis`, `mailpit` report healthy.

- [ ] **Step 2: Write the failing test**

Create `apps/api/test/integration/configured-variable-keys.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { createDataSource } from '../../src/database/data-source.js';
import { ConfiguredVariablesService } from '../../src/configured-variables/configured-variables.service.js';
import { TenantEntity } from '../../src/database/entities/tenant.entity.js';
import { testDatabaseUrl } from './test-database-url.js';

/**
 * ADR-032: a template-local key is unique inside its own template, but may
 * never shadow a system variable, a tenant-global variable or a recipient
 * field. The invariant is symmetric -- it must hold no matter which side is
 * created second.
 */
describe('configured variable key availability', () => {
  let dataSource: DataSource;
  let tenantId: string;
  let templateA: string;
  let templateB: string;
  const service = () => new ConfiguredVariablesService(dataSource);

  const insertTemplate = async (): Promise<string> => {
    const [row] = await dataSource.query(
      `INSERT INTO email_template (tenant_id, name) VALUES ($1, $2) RETURNING id`,
      [tenantId, `Template ${randomUUID()}`],
    ) as Array<{ id: string }>;
    return row.id;
  };

  beforeAll(async () => {
    dataSource = createDataSource(testDatabaseUrl());
    await dataSource.initialize();
    tenantId = (await dataSource.getRepository(TenantEntity).save({ name: `variable-keys-${randomUUID()}` })).id;
    templateA = await insertTemplate();
    templateB = await insertTemplate();
  });

  afterAll(async () => {
    await dataSource.query('DELETE FROM configured_variable WHERE tenant_id = $1', [tenantId]);
    await dataSource.query('DELETE FROM email_template WHERE tenant_id = $1', [tenantId]);
    await dataSource.getRepository(TenantEntity).delete(tenantId);
    await dataSource.destroy();
  });

  it('lets two templates own the same local key independently', async () => {
    const first = await service().createTemplate(tenantId, templateA, { key: 'campaign_note', label: 'Ghi chú A', required: false, allowCampaignOverride: false });
    const second = await service().createTemplate(tenantId, templateB, { key: 'campaign_note', label: 'Ghi chú B', required: false, allowCampaignOverride: false });
    expect([first.templateId, second.templateId]).toEqual([templateA, templateB]);
    expect(first.label).not.toBe(second.label);
  });

  it('refuses a second variable with the same key inside one template', async () => {
    await service().createTemplate(tenantId, templateA, { key: 'quarter', label: 'Quý', required: false, allowCampaignOverride: false });
    await expect(service().createTemplate(tenantId, templateA, { key: 'quarter', label: 'Quý (lặp)', required: false, allowCampaignOverride: false }))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: 'CONFIGURED_VARIABLE_KEY_CONFLICT' }) });
  });

  it('refuses a template variable that would shadow an existing global', async () => {
    await service().createGlobal(tenantId, { key: 'company_name', label: 'Tên công ty', defaultValue: 'Alta', allowCampaignOverride: false, required: false });
    await expect(service().createTemplate(tenantId, templateA, { key: 'company_name', label: 'Tên công ty', required: false, allowCampaignOverride: false }))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: 'CONFIGURED_VARIABLE_GLOBAL_KEY', variableKey: 'company_name' }) });
  });

  it('refuses a global variable that a template already owns, and names the owning template', async () => {
    await service().createTemplate(tenantId, templateB, { key: 'signature_block', label: 'Chữ ký', required: false, allowCampaignOverride: false });
    await expect(service().createGlobal(tenantId, { key: 'signature_block', label: 'Chữ ký chung', defaultValue: 'Alta', allowCampaignOverride: false, required: false }))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: 'CONFIGURED_VARIABLE_TEMPLATE_KEY', variableKey: 'signature_block', templateId: templateB }) });
  });
});
```

- [ ] **Step 3: Run the test to verify the last case fails**

```bash
cd apps/api && npx vitest run test/integration/configured-variable-keys.test.ts
```

Expected: 3 passed, 1 failed — *"refuses a global variable that a template already owns"* fails because `createGlobal` resolves instead of rejecting.

- [ ] **Step 4: Add the repository lookup**

In `apps/api/src/configured-variables/configured-variables.repository.ts`, directly below `findTemplateByKey`:

```ts
  findAnyTemplateByKey(variableKey: string): Promise<ConfiguredVariableEntity | null> {
    return this.repository.findOne({ where: { tenantId: this.tenantId, scope: 'template', variableKey } });
  }
```

- [ ] **Step 5: Enforce the rule in both directions**

In `apps/api/src/configured-variables/configured-variables.service.ts`, replace the whole body of `assertKeyAvailable` after the recipient-field check with:

```ts
    const repository = new ConfiguredVariablesRepository(manager, tenantId);
    if (scope === 'template' && await repository.findGlobalByKey(key)) {
      throw new UnprocessableEntityException({ code: 'CONFIGURED_VARIABLE_GLOBAL_KEY', message: 'Template variables cannot shadow a global variable.', variableKey: key });
    }
    if (scope === 'global') {
      if (await repository.findGlobalByKey(key)) {
        throw new ConflictException({ code: 'CONFIGURED_VARIABLE_KEY_CONFLICT', message: 'This global variable key already exists.' });
      }
      // The shadow rule is symmetric: a global created after the template would
      // be permanently shadowed by that template's local key (ADR-032).
      const owner = await repository.findAnyTemplateByKey(key);
      if (owner) {
        throw new UnprocessableEntityException({ code: 'CONFIGURED_VARIABLE_TEMPLATE_KEY', message: 'A template already owns this variable key.', variableKey: key, templateId: owner.templateId });
      }
    }
    if (scope === 'template' && templateId && await repository.findTemplateByKey(templateId, key)) {
      throw new ConflictException({ code: 'CONFIGURED_VARIABLE_KEY_CONFLICT', message: 'This template already has the selected variable key.' });
    }
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
cd apps/api && npx vitest run test/integration/configured-variable-keys.test.ts
```

Expected: `Tests 4 passed (4)`.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/configured-variables apps/api/test/integration/configured-variable-keys.test.ts
git commit -m "fix(api): enforce the ADR-032 shadow rule in both directions"
```

---

### Task 2: API — scope the delete-dependency check to the owning template

`remove()` blocks deletion when a *published* version references the key with the same scope, but never filters by `template_id`. Since ADR-032 deliberately allows two templates to own the same local key, deleting template A's variable is refused because template B published one with the same name — and the error points the user at the wrong template.

**Files:**
- Modify: `apps/api/src/configured-variables/configured-variables.service.ts:92-104`
- Test: `apps/api/test/integration/configured-variable-dependency.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/integration/configured-variable-dependency.test.ts`:

```ts
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { createDataSource } from '../../src/database/data-source.js';
import { ConfiguredVariablesService } from '../../src/configured-variables/configured-variables.service.js';
import { TenantEntity } from '../../src/database/entities/tenant.entity.js';
import { testDatabaseUrl } from './test-database-url.js';
import { deleteTemplateVersionFixtures } from './template-version-fixtures.js';

/**
 * A published version freezes its own variable schema, so it may only pin the
 * variables of *its own* template. ADR-032 lets a local key repeat across
 * templates, which makes the owning template_id part of the dependency, not
 * just the key and the scope.
 */
describe('configured variable delete dependency', () => {
  let dataSource: DataSource;
  let tenantId: string;
  let publishedTemplate: string;
  let otherTemplate: string;
  const service = () => new ConfiguredVariablesService(dataSource);

  const insertTemplate = async (status: 'draft' | 'published'): Promise<string> => {
    const [row] = await dataSource.query(
      `INSERT INTO email_template (tenant_id, name, status) VALUES ($1, $2, $3) RETURNING id`,
      [tenantId, `Template ${randomUUID()}`, status],
    ) as Array<{ id: string }>;
    return row.id;
  };

  beforeAll(async () => {
    dataSource = createDataSource(testDatabaseUrl());
    await dataSource.initialize();
    tenantId = (await dataSource.getRepository(TenantEntity).save({ name: `variable-dependency-${randomUUID()}` })).id;
    publishedTemplate = await insertTemplate('published');
    otherTemplate = await insertTemplate('draft');
    await dataSource.query(
      `INSERT INTO email_template_version (tenant_id, template_id, version, subject, html, text_body, required_variables, variable_schema_json, content_hash, published_at)
       VALUES ($1,$2,1,'Xin chào','<p>{{campaign_note}}</p>','Xin chào',ARRAY[]::text[],$3::jsonb,$4,now())`,
      [
        tenantId,
        publishedTemplate,
        JSON.stringify({ required: [], optional: ['campaign_note'], configured: { campaign_note: { label: 'Ghi chú', scope: 'template', allowCampaignOverride: false } } }),
        createHash('sha256').update(randomUUID()).digest('hex'),
      ],
    );
  });

  afterAll(async () => {
    await dataSource.query('DELETE FROM configured_variable WHERE tenant_id = $1', [tenantId]);
    await deleteTemplateVersionFixtures(dataSource, [tenantId]);
    await dataSource.query('DELETE FROM email_template WHERE tenant_id = $1', [tenantId]);
    await dataSource.getRepository(TenantEntity).delete(tenantId);
    await dataSource.destroy();
  });

  it('refuses to delete the variable the published version froze', async () => {
    const pinned = await service().createTemplate(tenantId, publishedTemplate, { key: 'campaign_note', label: 'Ghi chú', required: false, allowCampaignOverride: false });
    await expect(service().remove(tenantId, pinned.id, 'template'))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: 'CONFIGURED_VARIABLE_IN_USE', templateId: publishedTemplate }) });
  });

  it('still deletes another template\'s variable that merely shares the key', async () => {
    const unrelated = await service().createTemplate(tenantId, otherTemplate, { key: 'campaign_note', label: 'Ghi chú khác', required: false, allowCampaignOverride: false });
    await expect(service().remove(tenantId, unrelated.id, 'template')).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify the second case fails**

```bash
cd apps/api && npx vitest run test/integration/configured-variable-dependency.test.ts
```

Expected: 1 passed, 1 failed — the second case rejects with `CONFIGURED_VARIABLE_IN_USE` naming `publishedTemplate`.

- [ ] **Step 3: Scope the query to the owning template**

In `apps/api/src/configured-variables/configured-variables.service.ts`, replace the `dependency` query inside `remove()` with:

```ts
      const dependency = await manager.query(
        `SELECT t.id, t.name FROM email_template_version v
         JOIN email_template t ON t.id = v.template_id AND t.tenant_id = v.tenant_id
         WHERE v.tenant_id = $1
           AND v.variable_schema_json #>> ARRAY['configured', $2, 'scope'] = $3
           AND ($4::uuid IS NULL OR v.template_id = $4::uuid)
         ORDER BY v.published_at DESC LIMIT 1`,
        [tenantId, current.variableKey, current.scope, current.scope === 'template' ? current.templateId : null],
      ) as Array<{ id: string; name: string }>;
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd apps/api && npx vitest run test/integration/configured-variable-dependency.test.ts
```

Expected: `Tests 2 passed (2)`.

- [ ] **Step 5: Guard against regressions in the neighbouring suites**

```bash
cd apps/api && npx vitest run test/integration/custom-field-dependency.test.ts test/integration/templates.test.ts
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/configured-variables apps/api/test/integration/configured-variable-dependency.test.ts
git commit -m "fix(api): scope configured-variable delete blocking to the owning template"
```

---

### Task 3: Web — fix the global default value the overlay always nulls out

`ManageConfiguredVariableOverlay` initialises `defaultMode` to `'inherit'` when creating, but only renders `OverrideChoice` for template scope. A global create therefore always sends `defaultValue: null`, which `createGlobalVariableSchema` rejects with 422. Extract the decision into a pure module (the repo tests logic, not components) and fix it there.

**Files:**
- Create: `apps/web/src/overlays/configured-variable-form.ts`
- Create: `apps/web/src/overlays/configured-variable-form.test.ts`
- Modify: `apps/web/src/overlays/ManageConfiguredVariableOverlay.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/overlays/configured-variable-form.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { configuredVariableDefaultValue, configuredVariableFormError } from './configured-variable-form.js';

describe('configured variable form', () => {
  it('keeps the shared value of a global variable', () => {
    expect(configuredVariableDefaultValue({ scope: 'global', defaultMode: 'inherit', defaultValue: 'Alta Software' })).toBe('Alta Software');
  });

  it('sends no default when a template variable inherits', () => {
    expect(configuredVariableDefaultValue({ scope: 'template', defaultMode: 'inherit', defaultValue: 'bỏ qua' })).toBeNull();
  });

  it('sends the typed default when a template variable overrides', () => {
    expect(configuredVariableDefaultValue({ scope: 'template', defaultMode: 'override', defaultValue: 'Quý 3' })).toBe('Quý 3');
  });

  it('reports each blocking field in form order', () => {
    expect(configuredVariableFormError({ scope: 'template', defaultMode: 'inherit', defaultValue: '', key: 'Bad Key', label: 'Nhãn', isEdit: false }))
      .toBe('Mã biến phải bắt đầu bằng chữ thường và chỉ gồm chữ, số hoặc dấu gạch dưới.');
    expect(configuredVariableFormError({ scope: 'template', defaultMode: 'inherit', defaultValue: '', key: 'quarter', label: '  ', isEdit: false }))
      .toBe('Nhập tên hiển thị để người dùng nhận biết biến.');
    expect(configuredVariableFormError({ scope: 'global', defaultMode: 'inherit', defaultValue: '  ', key: 'company_name', label: 'Tên công ty', isEdit: false }))
      .toBe('Biến toàn hệ thống cần có giá trị dùng chung.');
    expect(configuredVariableFormError({ scope: 'template', defaultMode: 'override', defaultValue: '', key: 'quarter', label: 'Quý', isEdit: false }))
      .toBe('Nhập giá trị mặc định hoặc chọn không đặt mặc định.');
  });

  it('does not re-validate the immutable key when editing', () => {
    expect(configuredVariableFormError({ scope: 'global', defaultMode: 'override', defaultValue: 'Alta', key: 'Legacy Key', label: 'Tên công ty', isEdit: true })).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/web && npx vitest run src/overlays/configured-variable-form.test.ts
```

Expected: FAIL — `Cannot find module './configured-variable-form.js'`.

- [ ] **Step 3: Write the module**

Create `apps/web/src/overlays/configured-variable-form.ts`:

```ts
import type { OverrideMode } from '../components/OverrideChoice.js';

export type ConfiguredVariableFormState = {
  scope: 'global' | 'template';
  defaultMode: OverrideMode;
  defaultValue: string;
};

/**
 * A tenant-global variable is *defined* by its shared value, so the
 * inherit/override choice never applies to it — the form does not even render
 * that control. Only a template variable may deliberately carry no default and
 * demand the value from send data or an allowed campaign override.
 */
export function configuredVariableDefaultValue({ scope, defaultMode, defaultValue }: ConfiguredVariableFormState): string | null {
  const filled = defaultValue.trim().length > 0;
  if (scope === 'global') return filled ? defaultValue : null;
  return defaultMode === 'override' && filled ? defaultValue : null;
}

export function configuredVariableFormError(state: ConfiguredVariableFormState & { key: string; label: string; isEdit: boolean }): string | null {
  if (!state.isEdit && !/^[a-z][a-z0-9_]*$/.test(state.key.trim())) return 'Mã biến phải bắt đầu bằng chữ thường và chỉ gồm chữ, số hoặc dấu gạch dưới.';
  if (!state.label.trim()) return 'Nhập tên hiển thị để người dùng nhận biết biến.';
  if (state.scope === 'global' && !state.defaultValue.trim()) return 'Biến toàn hệ thống cần có giá trị dùng chung.';
  if (state.scope === 'template' && state.defaultMode === 'override' && !state.defaultValue.trim()) return 'Nhập giá trị mặc định hoặc chọn không đặt mặc định.';
  return null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd apps/web && npx vitest run src/overlays/configured-variable-form.test.ts
```

Expected: `Tests 5 passed (5)`.

- [ ] **Step 5: Consume the module in the overlay**

In `apps/web/src/overlays/ManageConfiguredVariableOverlay.tsx`, add the import:

```tsx
import { configuredVariableDefaultValue, configuredVariableFormError } from './configured-variable-form.js';
```

and replace the four inline validation lines plus the `value` assignment inside `save()` with:

```tsx
  const save = async () => {
    setError(null);
    const invalid = configuredVariableFormError({ scope, defaultMode, defaultValue, key, label, isEdit });
    if (invalid) { setError(invalid); return; }
    setBusy(true);
    try {
      const value = configuredVariableDefaultValue({ scope, defaultMode, defaultValue });
```

Leave the rest of `save()` (the four create/update calls, `onSaved()`, `catch`, `finally`) exactly as it is.

- [ ] **Step 6: Typecheck**

```bash
cd apps/web && pnpm typecheck
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/overlays
git commit -m "fix(web): stop nulling the shared value when creating a global variable"
```

---

### Task 4: ADR-033 — tenant-global variable ownership

ADR-032 is Accepted; AGENTS.md forbids editing it. Restoring a management surface for global variables is a change to its UI-placement clause and needs its own record before the screen is built.

**Files:**
- Create: `docs/adr/adr-033-tenant-global-variable-ownership.md`

- [ ] **Step 1: Write the ADR**

Create `docs/adr/adr-033-tenant-global-variable-ownership.md`:

```markdown
# ADR-033: Tenant-global variable ownership

Status: Accepted

Supersedes: ADR-032 for the placement of tenant-global variable management only.
ADR-032 remains authoritative for template-owned authoring, catalogue separation and
token insertion. ADR-031 remains authoritative for resolution precedence, published
version immutability and campaign snapshot freezing.

## Context

ADR-032 moved variable management out of the recipient-data settings module and
described tenant-global variables as "read-only catalogue inputs for compatibility".
The implementation removed the only surface that could create, edit or delete them, so
a tenant with existing global variables could no longer maintain them, and a value that
genuinely belongs to the whole tenant — a company name, a support address — had to be
redefined inside every template that used it.

That was a side effect of the move, not a decision anyone recorded.

## Decision

Tenant-global variables keep a first-class management surface, separate from both
recipient-data settings and template authoring:

- `/settings/global-variables` lists, creates, edits and deletes them. It requires
  `settings:manage`, matching the existing API permissions on those routes.
- They remain read-only *inside* the template editor and the campaign composer, exactly
  as ADR-032 specifies. Authoring a template never edits tenant-wide state.
- The key-shadow rule is symmetric: a global key may not be created when a template
  already owns that local key, and a template may not adopt a key an existing global
  owns.
- Deleting a global remains blocked while a published template version froze it.

## Rationale

Separation of ownership was the goal of ADR-032, and it is preserved: three surfaces,
three owners — recipient schema, template content, tenant-wide values. Removing the
third surface altogether was not required by that separation and cost a real capability.

## Compatibility

No API, contract or storage change. The screen consumes the `global-variables` routes
that have existed since ADR-031. Existing rows and published snapshots are untouched.

## Recovery

Removing the nav entry and route restores the previous state without touching data.
```

- [ ] **Step 2: Commit**

```bash
git add docs/adr/adr-033-tenant-global-variable-ownership.md
git commit -m "docs(adr): record tenant-global variable ownership as ADR-033"
```

---

### Task 5: Web — restore the global variables management screen

**Files:**
- Create: `apps/web/src/screens/settings/GlobalVariablesScreen.tsx`
- Modify: `apps/web/src/app/nav.ts:44-80`
- Modify: `apps/web/src/app/AppRoutes.tsx:85-93`

- [ ] **Step 1: Create the screen**

Create `apps/web/src/screens/settings/GlobalVariablesScreen.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react';
import { deleteGlobalVariable, listGlobalVariables, type ConfiguredVariable } from '../../api/configuredVariables.js';
import { ApiError } from '../../api/problem.js';
import { UiIcon } from '../../app/ui-icons.js';
import { EntityActionMenu } from '../../components/EntityActionMenu.js';
import { ManageConfiguredVariableOverlay } from '../../overlays/ManageConfiguredVariableOverlay.js';

/** ADR-033: tenant-wide values keep their own surface, separate from recipient schema and template authoring. */
export function GlobalVariablesScreen() {
  const [items, setItems] = useState<ConfiguredVariable[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [overlay, setOverlay] = useState<'create' | { kind: 'edit'; variable: ConfiguredVariable } | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(null), 2800);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try { setItems((await listGlobalVariables()).items); }
    catch (cause) { setError(cause); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleDelete = async (variable: ConfiguredVariable) => {
    try {
      await deleteGlobalVariable(variable.id);
      showToast(`Đã xóa biến "${variable.label}"`);
      void load();
    } catch (cause) {
      showToast(cause instanceof ApiError ? cause.message : 'Không thể xóa biến dùng chung.');
    }
  };

  return <section className="workspace-module-frame standard-module-frame custom-fields-module">
    <header className="module-frame-toolbar standard-filter-bar">
      <div><h2 style={{ margin: 0 }}>Biến dùng chung</h2><small>Giá trị áp dụng cho toàn hệ thống và có thể chèn vào mọi template.</small></div>
      <button className="primary-button" onClick={() => setOverlay('create')}><UiIcon name="plus" size={16} /> Tạo biến dùng chung</button>
    </header>
    <div className="module-frame-body">
      <div className="info-banner">Biến riêng của từng template được tạo trong màn hình chỉnh sửa template; biến ở đây dùng chung cho cả hệ thống.</div>
      {loading && items === null && <div className="module-card" role="status" style={{ padding: 24 }}>Đang tải biến dùng chung…</div>}
      {Boolean(error) && <div className="module-card permission-denied-card">
        <i aria-hidden="true"><UiIcon name="warning" size={22} /></i>
        <span className="status danger" role="status">Không thể tải dữ liệu</span>
        <h2>Không thể tải biến dùng chung</h2>
        <p>Đã xảy ra lỗi khi tải danh sách. Vui lòng thử lại.</p>
        <button type="button" className="secondary-button" onClick={() => void load()}><UiIcon name="refresh" size={16} /> Thử lại</button>
      </div>}
      {!error && items !== null && items.length === 0 && <div className="module-card" style={{ padding: 24 }}><h2 style={{ marginTop: 0 }}>Chưa có biến dùng chung</h2><p>Tạo biến đầu tiên để dùng lại một giá trị cố định trong nhiều template.</p></div>}
      {!error && items !== null && items.length > 0 && <div className="table-wrap"><table>
        <thead><tr><th>MÃ BIẾN</th><th>TÊN HIỂN THỊ</th><th>GIÁ TRỊ DÙNG CHUNG</th><th>ĐỔI KHI GỬI</th><th><span className="visually-hidden">Hành động</span></th></tr></thead>
        <tbody>{items.map((variable) => <tr key={variable.id}>
          <td><code>{`{{${variable.key}}}`}</code></td><td><b>{variable.label}</b></td>
          <td>{variable.defaultValue == null ? '—' : String(variable.defaultValue)}</td>
          <td><span className={`status ${variable.allowCampaignOverride ? 'warning' : 'success'}`}>{variable.allowCampaignOverride ? 'Cho phép' : 'Giữ cố định'}</span></td>
          <td><EntityActionMenu label={`Tùy chọn ${variable.label}`} items={[
            { label: 'Cập nhật biến', icon: 'edit', onSelect: () => setOverlay({ kind: 'edit', variable }) },
            { label: 'Xóa biến', icon: 'trash', tone: 'danger', onSelect: () => void handleDelete(variable) },
          ]} /></td>
        </tr>)}</tbody>
      </table></div>}
    </div>
    {overlay === 'create' && <ManageConfiguredVariableOverlay scope="global" existing={null} onClose={() => setOverlay(null)} onSaved={() => { setOverlay(null); showToast('Đã tạo biến dùng chung'); void load(); }} />}
    {overlay && typeof overlay === 'object' && <ManageConfiguredVariableOverlay scope="global" existing={overlay.variable} onClose={() => setOverlay(null)} onSaved={() => { setOverlay(null); showToast('Đã lưu thay đổi'); void load(); }} />}
    {toast && <div className="toast" role="status" aria-live="polite"><span>✓</span>{toast}</div>}
  </section>;
}

export default GlobalVariablesScreen;
```

- [ ] **Step 2: Register navigation, permission and page metadata**

In `apps/web/src/app/nav.ts`, add to the `HỆ THỐNG` group immediately after the `custom-fields` item:

```ts
      // ADR-033: tenant-wide values keep their own destination, separate from
      // recipient schema (custom-fields) and template-owned authoring.
      { id: 'global-variables', label: 'Biến dùng chung', icon: 'settings', path: '/settings/global-variables', requiredPermission: 'settings:manage' },
```

In the same file add to `routePermissions`:

```ts
  '/settings/global-variables': 'settings:manage',
```

and to `pageMeta`:

```ts
  '/settings/global-variables': { title: 'Biến dùng chung', description: 'Quản lý giá trị dùng chung cho toàn hệ thống.' },
```

- [ ] **Step 3: Register the route**

In `apps/web/src/app/AppRoutes.tsx`, add the import beside the other screen imports:

```tsx
import { GlobalVariablesScreen } from '../screens/settings/GlobalVariablesScreen.js';
```

and add this `<Route>` directly after the `/settings/custom-fields` route:

```tsx
        <Route
          path="/settings/global-variables"
          element={
            <RequirePermission permission={routePermissions['/settings/global-variables']!}>
              <GlobalVariablesScreen />
            </RequirePermission>
          }
        />
```

- [ ] **Step 4: Verify the screen is reachable and typed**

```bash
cd apps/web && pnpm typecheck
```

```bash
cd packages/architecture-tests && npx vitest run src/structure.test.ts
```

Expected: typecheck clean; `ARCH-NO-ORPHANS` passes (the screen is now reachable from `main.tsx` through `AppRoutes.tsx`).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/screens/settings/GlobalVariablesScreen.tsx apps/web/src/app/nav.ts apps/web/src/app/AppRoutes.tsx
git commit -m "feat(web): restore tenant-global variable management (ADR-033)"
```

---

### Task 6: Contract gate — detect enum narrowing

The gate lets `openapi.yaml` grow but never shrink. It compares paths, operations, responses and required properties — not enum members. That is how `suggestedActions` dropping `OPEN_CUSTOM_FIELDS` passed unflagged.

**Files:**
- Modify: `scripts/openapi-compat-check.mjs:41-89`
- Modify: `scripts/openapi-compat-check.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `scripts/openapi-compat-check.test.mjs`:

```js
const ENUM_BASE_SPEC = `
openapi: 3.0.3
info:
  title: fixture
  version: '1'
paths: {}
components:
  schemas:
    Suggestion:
      type: object
      properties:
        action:
          type: string
          enum: [OPEN_CUSTOM_FIELDS, RENAME_VARIABLE]
`;

const ENUM_NARROWED_SPEC = ENUM_BASE_SPEC.replace('[OPEN_CUSTOM_FIELDS, RENAME_VARIABLE]', '[CREATE_TEMPLATE_VARIABLE, RENAME_VARIABLE]');
const ENUM_WIDENED_SPEC = ENUM_BASE_SPEC.replace('[OPEN_CUSTOM_FIELDS, RENAME_VARIABLE]', '[OPEN_CUSTOM_FIELDS, RENAME_VARIABLE, CREATE_TEMPLATE_VARIABLE]');

test('openapi-compat-check blocks an enum value that disappears from a response schema', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'openapi-compat-'));
  try {
    writeFileSync(join(dir, 'old.yaml'), ENUM_BASE_SPEC);
    writeFileSync(join(dir, 'new.yaml'), ENUM_NARROWED_SPEC);
    const failure = await execFileAsync('node', [SCRIPT, join(dir, 'old.yaml'), join(dir, 'new.yaml')]).catch((error) => error);
    assert.equal(failure.code, 1);
    assert.match(failure.stderr, /enum values removed/);
    assert.match(failure.stderr, /OPEN_CUSTOM_FIELDS/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('openapi-compat-check allows an enum that only gains values', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'openapi-compat-'));
  try {
    writeFileSync(join(dir, 'old.yaml'), ENUM_BASE_SPEC);
    writeFileSync(join(dir, 'new.yaml'), ENUM_WIDENED_SPEC);
    const { stdout } = await execFileAsync('node', [SCRIPT, join(dir, 'old.yaml'), join(dir, 'new.yaml')]);
    assert.match(stdout, /No breaking OpenAPI changes detected/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
node --test scripts/openapi-compat-check.test.mjs
```

Expected: the narrowing test fails — the script exits 0 and prints "No breaking OpenAPI changes detected."

- [ ] **Step 3: Implement the enum walk**

In `scripts/openapi-compat-check.mjs`, add this function directly after `checkSchemas`:

```js
/**
 * An enum is a promise about the values a client may receive. Removing one is a
 * narrowing exactly like dropping a required property, so it belongs to the
 * same "may only grow" rule. Nodes are aligned by key path (array members by
 * index), which is why a deliberate reordering of an allOf list reads as a
 * change here — keep allOf order stable.
 */
function checkEnums(oldNode, newNode, breaks, path) {
  if (!oldNode || typeof oldNode !== 'object' || !newNode || typeof newNode !== 'object') return;
  if (Array.isArray(oldNode.enum) && Array.isArray(newNode.enum)) {
    const kept = new Set(newNode.enum);
    const removed = oldNode.enum.filter((value) => !kept.has(value));
    if (removed.length > 0) breaks.push(`enum values removed: ${path} -> ${removed.join(', ')}`);
  }
  for (const [key, oldChild] of Object.entries(oldNode)) {
    if (key === 'enum' || !oldChild || typeof oldChild !== 'object') continue;
    const newChild = newNode[key];
    if (!newChild || typeof newChild !== 'object') continue;
    checkEnums(oldChild, newChild, breaks, `${path}.${key}`);
  }
}
```

and in `main()`, directly below the two existing check calls:

```js
  checkEnums(oldDoc.components?.schemas ?? {}, newDoc.components?.schemas ?? {}, breaks, 'components.schemas');
  checkEnums(oldDoc.paths ?? {}, newDoc.paths ?? {}, breaks, 'paths');
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
node --test scripts/openapi-compat-check.test.mjs
```

Expected: all tests pass, including the three pre-existing ones.

- [ ] **Step 5: Prove the gate now catches the change that slipped through**

```bash
git show 4c4f5ee:contracts/openapi.yaml > /tmp/base-openapi.yaml && node scripts/openapi-compat-check.mjs /tmp/base-openapi.yaml contracts/openapi.yaml
```

Expected: exit 1, naming `OPEN_CUSTOM_FIELDS`. This is the historical narrowing — a real finding, not a new break. Record it in the commit body; do **not** revert the enum, because the web client already migrated to `CREATE_TEMPLATE_VARIABLE` and no other consumer exists. CI compares against the current `origin/main`, where both sides already carry the new value, so this does not block the branch.

- [ ] **Step 6: Confirm the branch itself is still compatible**

```bash
git show origin/main:contracts/openapi.yaml > /tmp/main-openapi.yaml && node scripts/openapi-compat-check.mjs /tmp/main-openapi.yaml contracts/openapi.yaml
```

Expected: exit 0, "No breaking OpenAPI changes detected."

- [ ] **Step 7: Wire the script's own tests into CI**

The gate's test file is documented as "run with node --test" and no workflow runs it. In `.github/workflows/ci.yml`, immediately after the "OpenAPI backward-compatibility check" step, add:

```yaml
      - name: Repository script tests
        run: node --test "scripts/*.test.mjs"
```

- [ ] **Step 8: Verify the CI command locally**

```bash
node --test "scripts/*.test.mjs"
```

Expected: all `scripts/*.test.mjs` files pass.

- [ ] **Step 9: Commit**

```bash
git add scripts/openapi-compat-check.mjs scripts/openapi-compat-check.test.mjs .github/workflows/ci.yml
git commit -m "fix(ci): fail the OpenAPI gate on enum narrowing and run the script tests"
```

---

### Task 7: Test suite — remove the argon2id flake window

`vitest.shared.ts` already documents this failure mode: a `beforeAll` that hashes several passwords with argon2id blows its budget under `pnpm -r test` contention, vitest reports the suite's tests as *skipped*, and `no-skipped-tests-reporter.mjs` turns that into a hard failure that reads like a regression. It happened to `rbac-matrix.test.ts` before; it happened to `campaign-snapshot-immutability.test.ts` during this review (23 tests). Every fixture in a given file hashes the *same* constant password, so the work is redundant.

**Files:**
- Create: `apps/api/test/integration/test-password.ts`
- Modify: `apps/api/test/integration/campaign-snapshot-immutability.test.ts`
- Modify: `apps/api/test/integration/sending-quota-http.test.ts`
- Modify: `apps/api/test/integration/realtime-campaign.test.ts`
- Modify: `apps/api/test/integration/templates-http.test.ts`
- Modify: `apps/api/test/integration/campaign-export-download.test.ts`

- [ ] **Step 1: Measure the current cost (baseline for the claim)**

```bash
cd apps/api && npx vitest run test/integration/campaign-snapshot-immutability.test.ts
```

Expected: passes on an idle machine. Note the reported `Duration` — the next steps must not increase it.

- [ ] **Step 2: Write the helper**

Create `apps/api/test/integration/test-password.ts`:

```ts
import { hashPassword } from '../../src/auth/password.service.js';

const hashes = new Map<string, Promise<string>>();

/**
 * argon2id is deliberately CPU-hard, and `pnpm -r test` oversubscribes the CPU
 * across six workspaces. A fixture file that hashes the same constant password
 * for three users pays that cost three times inside one `beforeAll`, which is
 * what pushed `campaign-snapshot-immutability` past its hook timeout — vitest
 * then reports the whole suite as skipped and the run fails for a reason that
 * looks nothing like the cause (see vitest.shared.ts).
 *
 * Vitest isolates modules per test file, so this cache is per file: the win is
 * removing the redundant hashes inside a single fixture, not sharing across
 * files.
 */
export function testPasswordHash(password: string): Promise<string> {
  const existing = hashes.get(password);
  if (existing) return existing;
  const created = hashPassword(password);
  hashes.set(password, created);
  return created;
}
```

- [ ] **Step 3: Use it in the five heaviest fixtures**

In each of the five files listed above, replace the import

```ts
import { hashPassword } from '../../src/auth/password.service.js';
```

with

```ts
import { testPasswordHash } from './test-password.js';
```

and replace every call `hashPassword(` with `testPasswordHash(`. Do not change any argument. Verify none remain:

```bash
cd apps/api && grep -rn "hashPassword(" test/integration/campaign-snapshot-immutability.test.ts test/integration/sending-quota-http.test.ts test/integration/realtime-campaign.test.ts test/integration/templates-http.test.ts test/integration/campaign-export-download.test.ts
```

Expected: no output.

- [ ] **Step 4: Run the five suites and compare the duration**

```bash
cd apps/api && npx vitest run test/integration/campaign-snapshot-immutability.test.ts test/integration/sending-quota-http.test.ts test/integration/realtime-campaign.test.ts test/integration/templates-http.test.ts test/integration/campaign-export-download.test.ts
```

Expected: all pass, 0 skipped, and total duration lower than Step 1's baseline plus the other four files' previous cost. Password-based login assertions must still pass — the hash is real, only computed once.

- [ ] **Step 5: Commit**

```bash
git add apps/api/test/integration
git commit -m "test(api): hash each fixture password once per file to widen the hook budget"
```

---

### Task 8: Test reporter — name the hook failure behind the skips

Even with Task 7, a slow machine can still trip a hook. When it does, the reporter must say so instead of accusing the author of committing `.skip`.

**Files:**
- Modify: `scripts/no-skipped-tests-reporter.mjs`

- [ ] **Step 1: Create a temporary fixture that fails a hook**

Create `apps/api/test/integration/zz-hook-failure-fixture.test.ts`:

```ts
import { beforeAll, describe, expect, it } from 'vitest';

describe('temporary hook failure fixture', () => {
  beforeAll(() => { throw new Error('deliberate fixture hook failure'); });
  it('never runs', () => { expect(true).toBe(true); });
});
```

- [ ] **Step 2: Observe the current, misleading message**

```bash
cd apps/api && npx vitest run test/integration/zz-hook-failure-fixture.test.ts --reporter=default --reporter=../../scripts/no-skipped-tests-reporter.mjs
```

Expected: the thrown error says only "Skipped/todo tests are forbidden (1)" and never mentions `deliberate fixture hook failure`.

- [ ] **Step 3: Rewrite the reporter**

Replace the whole of `scripts/no-skipped-tests-reporter.mjs` with:

```js
/**
 * A skipped test is either committed `.skip`/`.todo` (forbidden here) or a test
 * that never ran because its hook failed — vitest reports both as "skipped".
 * The second case is the common one under CPU contention (see vitest.shared.ts),
 * so the message must carry the hook error or the reader chases the wrong bug.
 */
export default class NoSkippedTestsReporter {
  onTestRunEnd(testModules) {
    const skipped = testModules.flatMap((module) => [...module.children.allTests('skipped')]);
    if (skipped.length === 0) return;
    const names = skipped.map((test) => `  - ${test.module.relativeModuleId} > ${test.fullName}`).join('\n');
    const failures = testModules.flatMap((module) => [
      ...(module.errors?.() ?? []),
      ...[...module.children.allSuites()].flatMap((suite) => suite.errors?.() ?? []),
    ]).map((error) => `  ! ${error?.message ?? String(error)}`);
    const cause = failures.length > 0
      ? `\n\nA hook or collection step failed, so these tests never ran. Fix this first:\n${failures.join('\n')}`
      : '\n\nNo hook error was reported. If this run was under heavy load, re-run before investigating: a timed-out beforeAll also surfaces as skipped (see vitest.shared.ts).';
    throw new Error(`Skipped/todo tests are forbidden (${skipped.length}):\n${names}${cause}`);
  }
}
```

- [ ] **Step 4: Verify the message now names the cause**

```bash
cd apps/api && npx vitest run test/integration/zz-hook-failure-fixture.test.ts --reporter=default --reporter=../../scripts/no-skipped-tests-reporter.mjs
```

Expected: the thrown error contains `deliberate fixture hook failure`.

If it does **not** — i.e. `errors()` returns empty for hook failures in this vitest version — keep the rewritten reporter anyway (the fallback sentence is still an improvement) and record in the commit body that the hook error was not retrievable through the reporter API. Do not invent another API.

- [ ] **Step 5: Delete the fixture**

```bash
rm apps/api/test/integration/zz-hook-failure-fixture.test.ts
```

- [ ] **Step 6: Confirm a normal run is unaffected**

```bash
cd apps/api && npx vitest run test/integration/configured-variable-keys.test.ts
```

Expected: passes, reporter silent.

- [ ] **Step 7: Commit**

```bash
git add scripts/no-skipped-tests-reporter.mjs
git commit -m "test: report the hook failure that caused skipped tests"
```

---

### Task 9: Web — keyboard and focus behaviour for ModalFrame

`ModalFrame` declares `aria-modal="true"` but has no Escape handler, no focus trap and no focus restore. It now wraps the full-screen template editor, so this is the one place worth fixing rather than each caller.

**Files:**
- Create: `apps/web/src/components/focus-trap.ts`
- Create: `apps/web/src/components/focus-trap.test.ts`
- Modify: `apps/web/src/components/ModalFrame.tsx`
- Modify: `apps/web/src/components/EntityActionMenu.tsx:31`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/focus-trap.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { nextFocusTarget } from './focus-trap.js';

describe('modal focus trap', () => {
  const items = ['first', 'middle', 'last'];

  it('wraps forward from the last element to the first', () => {
    expect(nextFocusTarget(items, 'last', false)).toBe('first');
  });

  it('wraps backward from the first element to the last', () => {
    expect(nextFocusTarget(items, 'first', true)).toBe('last');
  });

  it('leaves ordinary movement to the browser', () => {
    expect(nextFocusTarget(items, 'first', false)).toBeNull();
    expect(nextFocusTarget(items, 'last', true)).toBeNull();
  });

  it('pulls focus back in when it sits outside the dialog', () => {
    expect(nextFocusTarget(items, 'somewhere-else', false)).toBe('first');
    expect(nextFocusTarget(items, null, true)).toBe('last');
  });

  it('does nothing when the dialog has no focusable element', () => {
    expect(nextFocusTarget([], null, false)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/web && npx vitest run src/components/focus-trap.test.ts
```

Expected: FAIL — `Cannot find module './focus-trap.js'`.

- [ ] **Step 3: Write the module**

Create `apps/web/src/components/focus-trap.ts`:

```ts
export const FOCUSABLE_SELECTOR = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Returns the element focus must jump to, or null when the browser's own Tab
 * order already keeps focus inside the dialog. Intervening only at the edges
 * keeps native behaviour (and screen-reader announcements) intact everywhere
 * else.
 */
export function nextFocusTarget<T>(focusable: readonly T[], current: T | null, shiftKey: boolean): T | null {
  if (focusable.length === 0) return null;
  const index = current === null ? -1 : focusable.indexOf(current);
  if (index === -1) return shiftKey ? focusable[focusable.length - 1]! : focusable[0]!;
  if (!shiftKey && index === focusable.length - 1) return focusable[0]!;
  if (shiftKey && index === 0) return focusable[focusable.length - 1]!;
  return null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd apps/web && npx vitest run src/components/focus-trap.test.ts
```

Expected: `Tests 5 passed (5)`.

- [ ] **Step 5: Wire it into ModalFrame**

In `apps/web/src/components/ModalFrame.tsx`, change the imports to:

```tsx
import { useEffect, useRef, type FormEvent, type ReactNode } from 'react';
import { FOCUSABLE_SELECTOR, nextFocusTarget } from './focus-trap.js';
```

Add this **above** the component (module scope):

```tsx
/**
 * Dialogs stack: the template editor opens a discard-confirmation on top of
 * itself. Every mounted frame listens on `document`, so without this only the
 * topmost one may act on Escape or Tab — otherwise the outer frame reacts to
 * the same keystroke and immediately undoes what the inner one did.
 */
const openDialogs: symbol[] = [];
```

Add this inside the component, above `const content = ...`:

```tsx
  const dialog = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const id = Symbol('dialog');
    openDialogs.push(id);
    const restoreTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (openDialogs[openDialogs.length - 1] !== id) return;
      if (event.defaultPrevented) return; // a nested control (e.g. EntityActionMenu) already handled it
      if (event.key === 'Escape') { onClose(); return; }
      if (event.key !== 'Tab' || !dialog.current) return;
      const focusable = [...dialog.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)];
      const target = nextFocusTarget(focusable, document.activeElement instanceof HTMLElement ? document.activeElement : null, event.shiftKey);
      if (!target) return;
      event.preventDefault();
      target.focus();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      openDialogs.splice(openDialogs.indexOf(id), 1);
      restoreTo?.focus();
    };
  }, [onClose]);
```

Then attach the ref and `tabIndex={-1}` to **both** branches. Use a callback ref so one `HTMLElement | null` ref serves the `<form>` and the `<section>` without a cast (`React` is not imported as a namespace in this file, so `React.RefObject<…>` would not compile):

```tsx
      ? <form ref={(node) => { dialog.current = node; }} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId} className={`action-overlay modal-${size}`} noValidate onSubmit={onSubmit} onMouseDown={(event) => event.stopPropagation()}>{content}</form>
      : <section ref={(node) => { dialog.current = node; }} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId} className={`action-overlay modal-${size}`} onMouseDown={(event) => event.stopPropagation()}>{content}</section>
```

- [ ] **Step 6: Let the action menu claim Escape first**

In `apps/web/src/components/EntityActionMenu.tsx`, change the escape handler so an open menu closes without also closing the dialog behind it:

```tsx
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setOpen(false); } };
```

- [ ] **Step 7: Typecheck and run the web suite**

```bash
cd apps/web && pnpm typecheck && npx vitest run
```

Expected: typecheck clean, all web tests pass.

- [ ] **Step 8: Verify in the running app**

Start the preview, open `/settings/global-variables`, press `Tab` repeatedly inside the create dialog (focus must stay inside), press `Escape` (dialog closes), and confirm focus returns to the "Tạo biến dùng chung" button.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/components
git commit -m "fix(web): trap focus, restore focus and honour Escape in ModalFrame"
```

---

### Task 10: Web — do not discard template edits without asking

The template editor is now a full authoring surface inside a dialog whose backdrop click, `×` and "Lưu trữ" all close it immediately. Losing an HTML body to a stray click is a much bigger cost than losing a name field.

**Files:**
- Modify: `apps/web/src/screens/templates/template-editor.ts`
- Modify: `apps/web/src/screens/templates/template-editor.test.ts`
- Modify: `apps/web/src/screens/templates/TemplatesScreen.tsx`

- [ ] **Step 1: Write the failing test**

Append to `apps/web/src/screens/templates/template-editor.test.ts`:

```ts
import { hasTemplateDraftChanges } from './template-editor.js';

describe('template draft dirty state', () => {
  const saved = { name: 'Chào mừng', subject: 'Xin chào', html: '<p>Hi</p>', textBody: 'Hi' };

  it('reports no change when every field matches what was loaded', () => {
    expect(hasTemplateDraftChanges(saved, { ...saved })).toBe(false);
  });

  it('reports a change for each editable field', () => {
    expect(hasTemplateDraftChanges(saved, { ...saved, name: 'Khác' })).toBe(true);
    expect(hasTemplateDraftChanges(saved, { ...saved, subject: 'Khác' })).toBe(true);
    expect(hasTemplateDraftChanges(saved, { ...saved, html: '<p>Khác</p>' })).toBe(true);
    expect(hasTemplateDraftChanges(saved, { ...saved, textBody: 'Khác' })).toBe(true);
  });
});
```

Merge the new import into the file's existing import statement rather than adding a second one.

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/web && npx vitest run src/screens/templates/template-editor.test.ts
```

Expected: FAIL — `hasTemplateDraftChanges is not a function`.

- [ ] **Step 3: Add the helper**

Append to `apps/web/src/screens/templates/template-editor.ts`:

```ts
export type TemplateDraftFields = { name: string; subject: string; html: string; textBody: string };

export function hasTemplateDraftChanges(saved: TemplateDraftFields, current: TemplateDraftFields): boolean {
  return saved.name !== current.name || saved.subject !== current.subject || saved.html !== current.html || saved.textBody !== current.textBody;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd apps/web && npx vitest run src/screens/templates/template-editor.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Guard the exits in TemplateActionsOverlay**

In `apps/web/src/screens/templates/TemplatesScreen.tsx`, extend the `template-editor.js` import with `hasTemplateDraftChanges`, then add this state and handler inside `TemplateActionsOverlay`, below the existing `useState` calls:

```tsx
  const [confirmDiscard, setConfirmDiscard] = useState<'close' | 'archive' | null>(null);
  const dirty = () => hasTemplateDraftChanges(
    { name: template.name, subject: template.subject, html: template.html, textBody: template.textBody },
    { name, subject, html, textBody },
  );
  const requestClose = () => { if (dirty()) setConfirmDiscard('close'); else onClose(); };
  const requestArchive = () => { if (dirty()) setConfirmDiscard('archive'); else onArchive(); };
```

Change the `ModalFrame`'s `onClose={onClose}` to `onClose={requestClose}`, and the "Lưu trữ" button's `onClick={onArchive}` to `onClick={requestArchive}`.

Then add this confirmation dialog immediately before the closing `</>` of the component's return, next to the existing `{variableOverlay && ...}` line:

```tsx
    {confirmDiscard && <ModalFrame titleId="discard-template-changes-title" title="Bỏ thay đổi chưa lưu?" description="Nội dung vừa chỉnh sửa sẽ không được lưu vào bản nháp." size="small" onClose={() => setConfirmDiscard(null)} footer={<>
      <button className="secondary-button" onClick={() => setConfirmDiscard(null)}>Tiếp tục chỉnh sửa</button>
      <button className="danger-button" onClick={() => { const next = confirmDiscard; setConfirmDiscard(null); if (next === 'archive') onArchive(); else onClose(); }}>Bỏ thay đổi</button>
    </>}>
      <div className="confirmation-copy"><b>{template.name}</b><p>Bạn có thay đổi chưa lưu trong template này.</p></div>
    </ModalFrame>}
```

- [ ] **Step 6: Typecheck**

```bash
cd apps/web && pnpm typecheck
```

Expected: no errors.

- [ ] **Step 7: Verify in the running app**

Open a template, change the HTML, click the backdrop → the confirmation appears. Choose "Tiếp tục chỉnh sửa" → edits are still there. Press `Escape` while the confirmation is open → only the confirmation closes and the editor keeps the edits (this is what the dialog stack from Task 9 exists for). Reopen, change nothing, click the backdrop → it closes with no prompt.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/screens/templates
git commit -m "fix(web): confirm before discarding unsaved template edits"
```

---

### Task 11: Web — stop a stale analysis from overwriting a newer one

`TemplateActionsOverlay` debounces `analyzeTemplate` by 450 ms with no ordering guard, so a slow earlier response can land after a faster later one and redisplay resolved variables as unknown. Publishing re-analyses synchronously, so this is a display defect — but it is the display authors act on.

**Files:**
- Create: `apps/web/src/api/sequence-guard.ts`
- Create: `apps/web/src/api/sequence-guard.test.ts`
- Modify: `apps/web/src/screens/templates/TemplatesScreen.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/api/sequence-guard.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createSequenceGuard } from './sequence-guard.js';

describe('sequence guard', () => {
  it('accepts the most recently issued token', () => {
    const guard = createSequenceGuard();
    const token = guard.issue();
    expect(guard.isCurrent(token)).toBe(true);
  });

  it('rejects a token that a later request superseded', () => {
    const guard = createSequenceGuard();
    const first = guard.issue();
    const second = guard.issue();
    expect(guard.isCurrent(first)).toBe(false);
    expect(guard.isCurrent(second)).toBe(true);
  });

  it('keeps accepting the latest token for repeated checks', () => {
    const guard = createSequenceGuard();
    const token = guard.issue();
    expect([guard.isCurrent(token), guard.isCurrent(token)]).toEqual([true, true]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/web && npx vitest run src/api/sequence-guard.test.ts
```

Expected: FAIL — `Cannot find module './sequence-guard.js'`.

- [ ] **Step 3: Write the module**

Create `apps/web/src/api/sequence-guard.ts`:

```ts
/**
 * Last-write-wins for debounced requests: responses may arrive out of order, so
 * a result is only applied while its token is still the newest one issued.
 */
export function createSequenceGuard() {
  let latest = 0;
  return {
    issue: () => ++latest,
    isCurrent: (token: number) => token === latest,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd apps/web && npx vitest run src/api/sequence-guard.test.ts
```

Expected: `Tests 3 passed (3)`.

- [ ] **Step 5: Apply it to the analysis effect**

In `apps/web/src/screens/templates/TemplatesScreen.tsx`, import the guard:

```tsx
import { createSequenceGuard } from '../../api/sequence-guard.js';
```

Inside `TemplateActionsOverlay`, add beside the other refs:

```tsx
  const analysisSequence = useRef(createSequenceGuard());
```

and replace the debounced analysis effect with:

```tsx
  useEffect(() => {
    const timeout = window.setTimeout(() => {
      const token = analysisSequence.current.issue();
      void analyzeTemplate({ templateId: template.id, subject, html, textBody })
        .then((result) => { if (analysisSequence.current.isCurrent(token)) setAnalysis(result); })
        .catch((cause) => { if (analysisSequence.current.isCurrent(token)) setError(cause instanceof ApiError ? cause.message : 'Không thể phân tích nội dung template.'); });
    }, 450);
    return () => window.clearTimeout(timeout);
  }, [html, subject, template.id, textBody, variables]);
```

- [ ] **Step 6: Typecheck and run the web suite**

```bash
cd apps/web && pnpm typecheck && npx vitest run
```

Expected: typecheck clean, all tests pass.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/api/sequence-guard.ts apps/web/src/api/sequence-guard.test.ts apps/web/src/screens/templates/TemplatesScreen.tsx
git commit -m "fix(web): ignore stale template analysis responses"
```

---

### Task 12: Web — confirm before deleting a campaign draft

`docs/frontend/form-validation.md` rule 3 — written in this same change — requires a destructive action to have its own confirmation state or dialog. Templates got `ArchiveTemplateOverlay`; the draft "Xóa bản nháp" button still deletes on the first click.

**Files:**
- Modify: `apps/web/src/screens/drafts/DraftsScreen.tsx`

- [ ] **Step 1: Add a confirmation state to DraftActions**

In `apps/web/src/screens/drafts/DraftsScreen.tsx`, inside `DraftActions`, add beside the existing state:

```tsx
  const [confirmDelete, setConfirmDelete] = useState(false);
```

Change the delete entry in the `action-list` from calling `remove()` to opening the confirmation:

```tsx
<button className="danger-text" disabled={busy} onClick={() => setConfirmDelete(true)}><UiIcon name="trash" size={16} /> Xóa bản nháp</button>
```

- [ ] **Step 2: Render the confirmation dialog**

Wrap the component's return in a fragment and add, after the existing `ModalFrame`:

```tsx
    {confirmDelete && <ModalFrame titleId="delete-draft-title" title="Xóa bản nháp" description="Bản nháp và nội dung đang soạn sẽ không thể khôi phục." size="small" onClose={() => setConfirmDelete(false)} footer={<>
      <button className="secondary-button" disabled={busy} onClick={() => setConfirmDelete(false)}>Hủy</button>
      <button className="danger-button" disabled={busy} onClick={() => void remove()}>{busy ? 'Đang xóa…' : 'Xóa bản nháp'}</button>
    </>}>
      <div className="confirmation-copy"><b>{draft.name}</b><p>Hãy xác nhận bạn muốn xóa bản nháp này.</p></div>
      {error && <p className="login-error" role="alert">{error}</p>}
    </ModalFrame>}
```

- [ ] **Step 3: Typecheck**

```bash
cd apps/web && pnpm typecheck
```

Expected: no errors.

- [ ] **Step 4: Verify in the running app**

Open a draft's `…` menu → "Cập nhật bản nháp" → "Xóa bản nháp". The confirmation must appear; "Hủy" must leave the draft in the list.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/screens/drafts/DraftsScreen.tsx
git commit -m "fix(web): confirm draft deletion, per the overlay convention"
```

---

### Task 13: Full-workspace verification

- [ ] **Step 1: Run the complete gate**

```bash
pnpm check
```

Expected: typecheck, build and tests all pass. Baseline was **1263 passed / 0 skipped / 210 files**; this plan adds 6 API tests (Tasks 1–2) and 13 web tests (Tasks 3, 9, 10, 11), so expect **1282 passed / 0 skipped**. Report the real number, not this estimate.

- [ ] **Step 2: Confirm the contract gate against main**

```bash
git show origin/main:contracts/openapi.yaml > /tmp/main-openapi.yaml && node scripts/openapi-compat-check.mjs /tmp/main-openapi.yaml contracts/openapi.yaml
```

Expected: exit 0. No task in this plan edits `contracts/openapi.yaml`.

- [ ] **Step 3: Confirm the script tests pass as CI will run them**

```bash
node --test "scripts/*.test.mjs"
```

Expected: all pass.

- [ ] **Step 4: Rebuild the local stack from the fixed source**

```bash
docker compose --env-file .env up -d --build --wait
```

Expected: postgres, redis, mailpit, api, worker, scheduler and web all healthy; the migration container exits 0 with no new migration (this plan adds none).

- [ ] **Step 5: Report**

State the final test count, the services' health, and — for Task 8 — whether the reporter could actually retrieve the hook error. If any expectation above was not met, say which and stop rather than closing the run.

---

## Self-review

**Spec coverage:**

| Finding | Task |
| --- | --- |
| P1 — global create always sends `defaultValue: null` | 3 |
| P1/P2 — global variables unmanageable | 4 (ADR), 5 (screen) |
| P2 — delete-dependency query ignores `template_id` | 2 |
| P2 — shadow rule enforced one direction only | 1 |
| P2 — no tests on the new validation branches | 1, 2 |
| P3 — ModalFrame has no Escape/focus trap/focus restore | 9 |
| P3 — unsaved template edits discarded silently | 10 |
| P3 — debounced analysis has no race guard | 11 |
| P3 — draft deletion has no confirmation | 12 |
| Infra — compat gate blind to enum narrowing; its own test never runs in CI | 6 |
| Infra — snapshot suite skips under load and fails the run misleadingly | 7, 8 |

**Type consistency:** `configuredVariableDefaultValue` / `configuredVariableFormError` share one `ConfiguredVariableFormState`; `nextFocusTarget` is generic and used with `HTMLElement`; `createSequenceGuard().issue()/isCurrent()` names match between module, test and caller; `hasTemplateDraftChanges(saved, current)` takes the same `TemplateDraftFields` in both arguments; `findAnyTemplateByKey` is defined in Task 1 Step 4 and used in Step 5 only.

**Known limits, stated rather than hidden:**
- Web components are still untested — this repo has no component-testing setup, and adding one is out of scope. Tasks 5, 10 and 12 rely on typecheck plus the named manual checks.
- Task 7 reduces the flake window; it cannot prove the flake is gone. Task 8 exists because it may still occur.
- Task 6 Step 5 will show that the *historical* enum narrowing was a real break. The plan deliberately does not revert it.
