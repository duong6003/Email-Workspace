# Template Editor Base (S0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the imported-HTML template flow into a real editor — own route, live preview, inline lint, autosave behind a mandatory `If-Match` — and add the `origin` / `project_data` / `draft_revision` seam a builder-origin template will need.

**Architecture:** Backend gains three columns on `email_template` and optimistic concurrency on `PATCH /templates/:id`, mirroring the pattern `campaigns.controller.ts` already uses. Frontend moves `TemplateActionsOverlay` out of the 397-line `TemplatesScreen.tsx` into a routed `TemplateEditorScreen`, with a lazily-loaded CodeMirror 6 code view and a live preview iframe. The composer's dead `.editor-shell` placeholder is replaced by the preview tab handoff v2 already specified.

**Tech Stack:** NestJS + TypeORM + Postgres (api), React 19 + react-router-dom 7 + Vite (web), Vitest for unit and integration tests, Playwright for e2e, CodeMirror 6 (new dependency, dynamically imported).

**Spec:** `docs/superpowers/specs/2026-08-25-template-editor-base-design.md`

---

## Investigation notes — read before starting

1. **`412`, not `409`, is this codebase's version-mismatch status.** `campaigns.service.ts:412` throws `new HttpException('Campaign has changed. Reload before saving.', 412)`, `problem.ts:52` already maps `409|412|428` to the `RESOURCE_CONFLICT` copy, and `ComposeDraftScreen.tsx:244` detects conflict with `cause.status === 412`. Follow that exactly.

2. **`draft_revision`, never `version`.** `EmailTemplateVersionEntity.version` already means "published version number" in this module (`templates.service.ts:220`). Two concepts under one word would be a permanent trap.

3. **`requireActive(manager, tenantId, id, true)` already takes a pessimistic write lock** (`templates.repository.ts:15-18` — `setLock('pessimistic_write')`). The revision check therefore only has to sit after that call inside the same `runInTenantContext` callback; no extra locking is needed.

4. **`ARCH-MIGRATION` never blesses the lock file for you.** `packages/architecture-tests/src/migration-immutability.test.ts` compares the filename set and every SHA-256 against `database/migrations.lock.json` and fails on any difference. The hash must be computed and pasted manually in the same commit.

5. **`pnpm --filter <pkg> test -- <name>` does NOT filter.** The `--` is passed through literally and vitest ignores it, so you run the whole suite (307s) instead of one file (12s). The narrow form is `pnpm --filter @eow/api test templates-http`.

6. **API integration tests need a live Postgres.** `apps/api/test/integration/*` call `testDatabaseUrl()` and open a real `DataSource`. Run `pnpm infra:up` first.

7. **Verify with `pnpm check`, not bare `pnpm test`** — two API boot tests fail purely from a missing build.

## File structure

**Create:**
- `database/migrations/071_template_origin_and_draft_revision.sql`
- `apps/web/src/api/autosave-reducer.ts` — generalized reducer
- `apps/web/src/api/autosave-reducer.test.ts`
- `apps/web/src/screens/templates/lint-positions.ts` + `.test.ts`
- `apps/web/src/screens/templates/editor-ports.ts`
- `apps/web/src/screens/templates/TemplateCodeView.tsx` — CodeMirror wrapper with textarea fallback
- `apps/web/src/screens/templates/TemplateEditorScreen.tsx`

**Modify:**
- `apps/api/src/database/entities/email-template.entity.ts`
- `apps/api/src/templates/templates.controller.ts`
- `apps/api/src/templates/templates.service.ts`
- `apps/api/test/integration/templates-http.test.ts`
- `contracts/openapi.yaml`, `database/migrations.lock.json`
- `apps/web/src/api/templates.ts`
- `apps/web/src/screens/compose/autosave-reducer.ts` → re-export
- `apps/web/src/app/page-meta.ts`, `page-meta.test.ts`, `AppShell.tsx`, `AppRoutes.tsx`
- `apps/web/src/screens/templates/TemplatesScreen.tsx` — remove lines 104–251
- `apps/web/src/screens/compose/ComposeDraftScreen.tsx`
- `apps/web/package.json`

---

### Task 1: Migration 071 — the data seam

**Files:**
- Create: `database/migrations/071_template_origin_and_draft_revision.sql`
- Modify: `database/migrations.lock.json`

- [ ] **Step 1: Write the migration**

Create `database/migrations/071_template_origin_and_draft_revision.sql`:

```sql
-- S0 template editor base: origin marks who owns the content model,
-- project_data is opaque storage for a builder's component tree, and
-- draft_revision backs optimistic concurrency on the draft.
-- draft_revision is deliberately NOT called "version": email_template_version
-- .version already means "published version number" in this module.
ALTER TABLE email_template
  ADD COLUMN origin text NOT NULL DEFAULT 'imported',
  ADD COLUMN project_data jsonb NULL,
  ADD COLUMN draft_revision integer NOT NULL DEFAULT 1;

ALTER TABLE email_template
  ADD CONSTRAINT email_template_origin_check CHECK (origin IN ('imported', 'builder'));
```

- [ ] **Step 2: Run the architecture test to watch it fail**

```bash
pnpm --filter @eow/architecture-tests test migration-immutability
```

Expected: FAIL — "Migration filename set differs from migrations.lock.json".

- [ ] **Step 3: Compute the hash**

```bash
python -c "import hashlib;print(hashlib.sha256(open('database/migrations/071_template_origin_and_draft_revision.sql','rb').read()).hexdigest())"
```

- [ ] **Step 4: Pin it in the lock file**

Add the entry to `database/migrations.lock.json` after `070_configured_variable_template_tenant_fk.sql`, pasting the exact digest printed above:

```json
  "070_configured_variable_template_tenant_fk.sql": "2cdbc27b9a917ceed14cd4bf9af975f9ac5a6f06e12c5f9c2188321c0277da5e",
  "071_template_origin_and_draft_revision.sql": "<paste the digest from step 3>"
```

Remember the comma after the `070` line.

- [ ] **Step 5: Run the architecture test again**

```bash
pnpm --filter @eow/architecture-tests test migration-immutability
```

Expected: PASS.

- [ ] **Step 6: Apply the migration locally**

```bash
pnpm infra:up
```

Migrations run through the `migrate` compose service (`compose.yaml:47-62`), which mounts `./database` and executes `migrate.sh`:

```bash
docker compose --env-file .env run --rm migrate
```

Confirm the columns landed:

```bash
docker compose exec -T postgres psql -U eow -d eow -c "\d email_template"
```

Expected: `origin`, `project_data`, `draft_revision` present; `draft_revision` is `integer not null default 1`.

- [ ] **Step 7: Commit**

```bash
git add database/migrations/071_template_origin_and_draft_revision.sql database/migrations.lock.json
git commit -m "feat(db): add template origin, project_data and draft_revision"
```

---

### Task 2: Entity fields

**Files:**
- Modify: `apps/api/src/database/entities/email-template.entity.ts`

- [ ] **Step 1: Add the three columns to the entity**

In `apps/api/src/database/entities/email-template.entity.ts`, add the exported type next to `EmailTemplateStatus`:

```ts
export type EmailTemplateOrigin = 'imported' | 'builder';
```

and add these three properties after `draftValidationJson`:

```ts
  /** Who owns the content model. 'builder' rows also carry projectData. */
  @Column({ type: 'text', default: 'imported' })
  origin!: EmailTemplateOrigin;

  /**
   * Opaque component tree for builder-origin templates. The API never reads
   * it — draftHtml stays the only content used to render and send (ADR-019).
   */
  @Column({ name: 'project_data', type: 'jsonb', nullable: true })
  projectData!: Record<string, unknown> | null;

  /** Optimistic concurrency for the draft. Not the published version number. */
  @Column({ name: 'draft_revision', type: 'int', default: 1 })
  draftRevision!: number;
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @eow/api typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/database/entities/email-template.entity.ts
git commit -m "feat(api): map template origin, projectData and draftRevision"
```

---

### Task 3: `If-Match` on `PATCH /templates/:id`

**Files:**
- Test: `apps/api/test/integration/templates-http.test.ts`
- Modify: `apps/api/src/templates/templates.controller.ts`, `apps/api/src/templates/templates.service.ts`

- [ ] **Step 1: Write the failing tests**

Add to `apps/api/test/integration/templates-http.test.ts`, inside the existing `describe`. It uses the file's own `login(email)` helper (line 73), which returns `{ cookie, csrfToken }` — every mutating call must carry both:

```ts
  it('requires a well-formed If-Match on draft updates and bumps draftRevision', async () => {
    const session = await login(operatorA);
    const auth = (call: request.Test) => call.set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken);
    const server = app.getHttpServer();

    const created = await auth(request(server).post('/api/v1/templates'))
      .send({ name: `If-Match ${randomUUID()}`, subject: 'Hi', html: '<p>Hi</p>' });
    expect(created.status).toBe(201);
    expect(created.body.draftRevision).toBe(1);
    expect(created.body.origin).toBe('imported');
    const id = created.body.id as string;

    const noHeader = await auth(request(server).patch(`/api/v1/templates/${id}`)).send({ subject: 'No header' });
    expect(noHeader.status).toBe(428);

    const badHeader = await auth(request(server).patch(`/api/v1/templates/${id}`)).set('if-match', 'not-a-number').send({ subject: 'Bad header' });
    expect(badHeader.status).toBe(400);

    const stale = await auth(request(server).patch(`/api/v1/templates/${id}`)).set('if-match', '99').send({ subject: 'Stale' });
    expect(stale.status).toBe(412);

    const ok = await auth(request(server).patch(`/api/v1/templates/${id}`)).set('if-match', '1').send({ subject: 'Fresh' });
    expect(ok.status).toBe(200);
    expect(ok.body.draftRevision).toBe(2);
    expect(ok.headers.etag).toBe('"2"');

    const replayed = await auth(request(server).patch(`/api/v1/templates/${id}`)).set('if-match', '1').send({ subject: 'Now stale' });
    expect(replayed.status).toBe(412);
  });
```

- [ ] **Step 2: Run it to watch it fail**

```bash
pnpm infra:up
pnpm --filter @eow/api test templates-http
```

Expected: FAIL — the no-header call returns `200`, because `If-Match` is not read yet.

- [ ] **Step 3: Add the header helpers to the controller**

In `apps/api/src/templates/templates.controller.ts`, extend the `@nestjs/common` import with `HttpException` and `Res`, and add `import type { Response } from 'express';` below the existing imports. Then add these two functions next to `actor()`:

```ts
function expectedRevision(ifMatch: string | undefined): number {
  if (!ifMatch?.trim()) throw new HttpException('If-Match is required.', 428);
  const match = /^"?(\d+)"?$/.exec(ifMatch.trim());
  if (!match) throw new HttpException('If-Match must be a strong template draft-revision ETag.', 400);
  return Number(match[1]);
}

function setEtag(response: Response, revision: number): void {
  response.setHeader('ETag', `"${revision}"`);
}
```

- [ ] **Step 4: Wire the three handlers**

Replace the `update` handler with:

```ts
  @Patch('templates/:id')
  @UseGuards(CsrfGuard)
  @RequirePermission(PERMISSIONS.CONTENT_MANAGE)
  @AuditLog({ action: 'template.updated', entityType: 'email_template', resolveEntityId: ({ request }) => (request.params as { id: string }).id })
  async update(@Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Body(new ZodValidationPipe(updateTemplateSchema)) body: UpdateTemplateDto, @Req() req: AuthenticatedRequest, @Res({ passthrough: true }) res: Response) {
    const template = await this.templates.update(tenantId(req), id, expectedRevision(ifMatch), body);
    setEtag(res, template.draftRevision);
    return template;
  }
```

`create` and `get` should also emit the ETag so the client always has a fresh revision without a second round trip:

```ts
  @Post('templates')
  @UseGuards(CsrfGuard)
  @RequirePermission(PERMISSIONS.CONTENT_MANAGE)
  @AuditLog({ action: 'template.created', entityType: 'email_template', resolveEntityId: ({ result }) => (result as { id?: string } | undefined)?.id ?? null })
  async create(@Body(new ZodValidationPipe(createTemplateSchema)) body: CreateTemplateDto, @Req() req: AuthenticatedRequest, @Res({ passthrough: true }) res: Response) {
    const template = await this.templates.create(tenantId(req), body);
    setEtag(res, template.draftRevision);
    return template;
  }

  @Get('templates/:id')
  @RequirePermission(PERMISSIONS.CONTENT_MANAGE)
  async get(@Param('id') id: string, @Req() req: AuthenticatedRequest, @Res({ passthrough: true }) res: Response) {
    const template = await this.templates.get(tenantId(req), id);
    setEtag(res, template.draftRevision);
    return template;
  }
```

- [ ] **Step 5: Enforce and bump in the service**

In `apps/api/src/templates/templates.service.ts`:

Add `origin` and `draftRevision` to the `TemplateResponse` type, next to `status`:

```ts
  origin: 'imported' | 'builder';
  draftRevision: number;
```

Add them to `templateResponse()`:

```ts
function templateResponse(template: EmailTemplateEntity, latestVersionId: string | null): TemplateResponse {
  return {
    id: template.id, name: template.name, status: template.status,
    origin: template.origin, draftRevision: template.draftRevision,
    subject: template.draftSubject, html: template.draftHtml, textBody: template.draftTextBody,
    validation: template.draftValidationJson, createdAt: template.createdAt, updatedAt: template.updatedAt,
    latestVersionId,
  };
}
```

Change `update` to take the expected revision and to bump. `requireActive(..., true)` already holds the row lock, so the check belongs immediately after it:

```ts
  async update(tenantId: string, id: string, expectedRevision: number, body: UpdateTemplateDto): Promise<TemplateResponse> {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const template = await this.requireActive(manager, tenantId, id, true);
      if (template.draftRevision !== expectedRevision) throw new HttpException('Template has changed. Reload before saving.', 412);
      const sanitized = body.html === undefined ? null : this.sanitize(body.html);
      if (body.name !== undefined) template.name = body.name.trim();
      if (body.subject !== undefined) template.draftSubject = body.subject;
      if (sanitized) {
        template.draftHtml = sanitized.html;
        template.draftValidationJson = this.validation(sanitized);
        if (body.textBody === undefined) template.draftTextBody = fallbackText(sanitized.html);
      }
      if (body.textBody !== undefined) template.draftTextBody = body.textBody;
      template.draftRevision = template.draftRevision + 1;
      try {
        const saved = await new TemplatesRepository(manager, tenantId).save(template);
        const latestIds = await new TemplateVersionsRepository(manager, tenantId).findLatestIdsByTemplateIds([saved.id]);
        return templateResponse(saved, latestIds.get(saved.id) ?? null);
      } catch (error) { this.throwNameConflict(error); }
    });
  }
```

Add `HttpException` to the `@nestjs/common` import in this file.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
pnpm --filter @eow/api test templates-http
```

Expected: PASS, including the final assertion that replaying `if-match: 1` now returns `412`.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/templates/templates.controller.ts apps/api/src/templates/templates.service.ts apps/api/test/integration/templates-http.test.ts
git commit -m "feat(api): require If-Match on template draft updates"
```

---

### Task 4: `publish` bumps the revision too

Without this, autosaving right after publishing reports a conflict that never happened.

**Files:**
- Test: `apps/api/test/integration/templates-http.test.ts`
- Modify: `apps/api/src/templates/templates.service.ts`

- [ ] **Step 1: Write the failing test**

```ts
  it('bumps draftRevision on publish so the next autosave is not a false conflict', async () => {
    const session = await login(operatorA);
    const auth = (call: request.Test) => call.set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken);
    const server = app.getHttpServer();

    const created = await auth(request(server).post('/api/v1/templates'))
      .send({ name: `Publish bump ${randomUUID()}`, subject: 'Hi', html: '<p>Hi</p>' });
    expect(created.status).toBe(201);
    const id = created.body.id as string;

    const published = await auth(request(server).post(`/api/v1/templates/${id}/publish`));
    expect(published.status).toBe(201);

    const reloaded = await request(server).get(`/api/v1/templates/${id}`).set('Cookie', session.cookie);
    expect(reloaded.body.draftRevision).toBe(2);

    const afterPublish = await auth(request(server).patch(`/api/v1/templates/${id}`)).set('if-match', '2').send({ subject: 'After publish' });
    expect(afterPublish.status).toBe(200);
  });
```

Match whatever status the existing publish test in this file already asserts for `POST .../publish` — do not change the endpoint to fit the test.

- [ ] **Step 2: Run it to watch it fail**

```bash
pnpm --filter @eow/api test templates-http
```

Expected: FAIL — `draftRevision` is still `1` after publish.

- [ ] **Step 3: Bump inside publish**

In `templates.service.ts`, in the `publish` method, change the two lines that mark the template published:

```ts
      template.status = 'published';
      template.draftRevision = template.draftRevision + 1;
      await new TemplatesRepository(manager, tenantId).save(template);
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm --filter @eow/api test templates-http
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/templates/templates.service.ts apps/api/test/integration/templates-http.test.ts
git commit -m "fix(api): bump template draftRevision on publish"
```

---

### Task 5: Contract

**Files:**
- Modify: `contracts/openapi.yaml`

- [ ] **Step 1: Add the header parameter and responses**

Under `/templates/{templateId}` → `patch`, add:

```yaml
      parameters:
        - name: If-Match
          in: header
          required: true
          schema:
            type: string
          description: Strong ETag carrying the template's current draftRevision.
      responses:
        '412':
          description: draftRevision no longer matches; reload before saving.
        '428':
          description: If-Match header missing.
```

Keep every existing parameter and response entry under that operation — these are additions, not a replacement.

- [ ] **Step 2: Add the two fields to the template schema**

In the template response schema, alongside `status`:

```yaml
        origin:
          type: string
          enum: [imported, builder]
        draftRevision:
          type: integer
          minimum: 1
```

Do **not** add `projectData`. The column exists for a future builder; exposing a field nothing reads or writes would contradict the spec's own YAGNI rule, and adding it later is an additive, non-breaking change.

- [ ] **Step 3: Run the compatibility check**

```bash
pnpm contracts:compat-check
```

Expected: **"No breaking OpenAPI changes detected."** `scripts/openapi-compat-check.mjs` only inspects removed paths, removed operations, removed status codes, removed required properties and removed enum values — it never reads `parameters`, so a newly required header is invisible to it. This is a blind spot in the gate, not a sign your change was safe. Read the whole report and confirm nothing else changed.

- [ ] **Step 4: Commit**

```bash
git add contracts/openapi.yaml
git commit -m "feat(contracts): If-Match, origin and draftRevision on templates"
```

---

### Task 6: Web API client

**Files:**
- Modify: `apps/web/src/api/templates.ts`

- [ ] **Step 1: Extend the type and add the patch type**

In `apps/web/src/api/templates.ts`, add to `EmailTemplate` after `status`:

```ts
  origin: 'imported' | 'builder';
  draftRevision: number;
```

and add this next to `TemplateQuery`:

```ts
export type TemplatePatch = Partial<Pick<EmailTemplate, 'name' | 'subject' | 'html' | 'textBody'>>;
```

- [ ] **Step 2: Add the missing single-template fetch**

`GET /templates/:id` exists on the API but has no client function — the list screen only ever used `listTemplates`. The routed editor loads one template by id, so add it next to `listTemplates`:

```ts
export function getTemplate(id: string): Promise<EmailTemplate> {
  return request(`/templates/${id}`);
}
```

- [ ] **Step 3: Send the header**

Replace `updateTemplate`:

```ts
/** `draftRevision` comes from the authoritative response body; reading ETag is unnecessary in-browser. */
export function updateTemplate(id: string, draftRevision: number, body: TemplatePatch): Promise<EmailTemplate> {
  return request(`/templates/${id}`, { method: 'PATCH', headers: { ...csrfHeaders(), 'if-match': String(draftRevision) }, body: JSON.stringify(body) });
}
```

- [ ] **Step 4: Typecheck to find every caller**

```bash
pnpm --filter @eow/web typecheck
```

Expected: FAIL, pointing at the `updateTemplate` calls inside `TemplatesScreen.tsx`. Leave them broken for now — Task 11 replaces that code entirely. If you need a green typecheck before then, pass `template.draftRevision` at each call site; the call sites move in Task 11 either way.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/api/templates.ts
git commit -m "feat(web): send If-Match when saving a template draft"
```

---

### Task 7: Generalize the autosave reducer

**Files:**
- Create: `apps/web/src/api/autosave-reducer.ts`, `apps/web/src/api/autosave-reducer.test.ts`
- Modify: `apps/web/src/screens/compose/autosave-reducer.ts`

The existing composer test is the safety net. It must pass untouched apart from its import path.

- [ ] **Step 1: Write the failing test for the generic reducer**

Create `apps/web/src/api/autosave-reducer.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { autosaveReducer, type AutosaveState } from './autosave-reducer.js';

type Draft = { id: string; subject: string; draftRevision: number };
type Patch = Partial<Pick<Draft, 'subject'>>;

const initial = (): AutosaveState<Draft, Patch> => ({
  draft: { id: 't1', subject: 'first', draftRevision: 1 },
  pending: null,
  inFlight: null,
  status: 'saved',
});

describe('autosaveReducer over an arbitrary draft type', () => {
  it('queues a change and moves it in flight exactly once', () => {
    const changed = autosaveReducer(initial(), { type: 'change', patch: { subject: 'second' } });
    expect(changed.draft.subject).toBe('second');
    expect(changed.pending).toEqual({ subject: 'second' });

    const started = autosaveReducer(changed, { type: 'start' });
    expect(started.status).toBe('saving');
    expect(started.inFlight).toEqual({ subject: 'second' });
    expect(started.pending).toBeNull();

    expect(autosaveReducer(started, { type: 'start' })).toBe(started);
  });

  it('keeps a newer local edit on top of the saved server draft', () => {
    const started = autosaveReducer(
      autosaveReducer(initial(), { type: 'change', patch: { subject: 'second' } }),
      { type: 'start' },
    );
    const typedAgain = autosaveReducer(started, { type: 'change', patch: { subject: 'third' } });
    const saved = autosaveReducer(typedAgain, { type: 'saved', draft: { id: 't1', subject: 'second', draftRevision: 2 } });

    expect(saved.draft.draftRevision).toBe(2);
    expect(saved.draft.subject).toBe('third');
    expect(saved.status).toBe('idle');
  });

  it('returns the in-flight patch to pending on conflict', () => {
    const started = autosaveReducer(
      autosaveReducer(initial(), { type: 'change', patch: { subject: 'second' } }),
      { type: 'start' },
    );
    const conflicted = autosaveReducer(started, { type: 'failed', conflict: true });

    expect(conflicted.status).toBe('conflict');
    expect(conflicted.pending).toEqual({ subject: 'second' });
    expect(conflicted.inFlight).toBeNull();
  });

  it('resolves a conflict either way', () => {
    const server: Draft = { id: 't1', subject: 'server wins', draftRevision: 9 };
    const conflicted = autosaveReducer(
      autosaveReducer(autosaveReducer(initial(), { type: 'change', patch: { subject: 'mine' } }), { type: 'start' }),
      { type: 'failed', conflict: true },
    );

    const takeServer = autosaveReducer(conflicted, { type: 'resolveConflict', serverDraft: server, keepLocal: false });
    expect(takeServer.draft.subject).toBe('server wins');
    expect(takeServer.pending).toBeNull();
    expect(takeServer.status).toBe('saved');

    const keepMine = autosaveReducer(conflicted, { type: 'resolveConflict', serverDraft: server, keepLocal: true });
    expect(keepMine.draft.subject).toBe('mine');
    expect(keepMine.draft.draftRevision).toBe(9);
    expect(keepMine.status).toBe('idle');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm --filter @eow/web test autosave-reducer
```

Expected: FAIL — `apps/web/src/api/autosave-reducer.ts` does not exist.

- [ ] **Step 3: Write the generic reducer**

Create `apps/web/src/api/autosave-reducer.ts`. The body is the existing composer logic with the two concrete types lifted into parameters — behaviour must not change:

```ts
export type AutosaveStatus = 'idle' | 'saving' | 'saved' | 'conflict' | 'error';
export type AutosaveState<TDraft, TPatch> = { draft: TDraft; pending: TPatch | null; inFlight: TPatch | null; status: AutosaveStatus };
export type AutosaveAction<TDraft, TPatch> =
  | { type: 'change'; patch: TPatch }
  | { type: 'start' }
  | { type: 'saved'; draft: TDraft }
  | { type: 'failed'; conflict: boolean }
  | { type: 'resolveConflict'; serverDraft: TDraft; keepLocal: boolean };

/** One request is in flight at most; later edits wait for the response's revision. */
export function autosaveReducer<TDraft, TPatch extends object>(
  state: AutosaveState<TDraft, TPatch>,
  action: AutosaveAction<TDraft, TPatch>,
): AutosaveState<TDraft, TPatch> {
  if (action.type === 'change') return { ...state, draft: { ...state.draft, ...action.patch }, pending: { ...state.pending, ...action.patch } as TPatch, status: 'idle' };
  if (action.type === 'start') return state.inFlight || !state.pending ? state : { ...state, inFlight: state.pending, pending: null, status: 'saving' };
  if (action.type === 'saved') return { ...state, draft: { ...action.draft, ...(state.pending ?? {}) }, inFlight: null, status: state.pending ? 'idle' : 'saved' };
  if (action.type === 'resolveConflict') {
    if (!action.keepLocal) return { draft: action.serverDraft, pending: null, inFlight: null, status: 'saved' };
    const localPatch = (state.pending ?? {}) as TPatch;
    return { draft: { ...action.serverDraft, ...localPatch }, pending: localPatch, inFlight: null, status: Object.keys(localPatch).length > 0 ? 'idle' : 'saved' };
  }
  return action.conflict
    ? { ...state, pending: { ...state.inFlight, ...state.pending } as TPatch, inFlight: null, status: 'conflict' }
    : { ...state, inFlight: null, status: 'error' };
}
```

- [ ] **Step 4: Re-export from the composer's path**

Replace the whole contents of `apps/web/src/screens/compose/autosave-reducer.ts` with:

```ts
import type { CampaignDraft, CampaignPatch } from '../../api/campaigns.js';
import { autosaveReducer, type AutosaveAction as GenericAction, type AutosaveState as GenericState, type AutosaveStatus } from '../../api/autosave-reducer.js';

export type { AutosaveStatus };
export type AutosaveState = GenericState<CampaignDraft, CampaignPatch>;
export type AutosaveAction = GenericAction<CampaignDraft, CampaignPatch>;
export { autosaveReducer };
```

- [ ] **Step 5: Run both suites**

```bash
pnpm --filter @eow/web test autosave-reducer
```

Expected: PASS for both files. `apps/web/src/screens/compose/autosave-reducer.test.ts` must pass **with no edits at all**. If it needs changing, the generalization altered behaviour — stop and find out why before continuing.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/api/autosave-reducer.ts apps/web/src/api/autosave-reducer.test.ts apps/web/src/screens/compose/autosave-reducer.ts
git commit -m "refactor(web): make the autosave reducer generic over draft type"
```

---

### Task 8: Lint offsets → editor ranges

`/templates/analyze` reports `start`/`end` as character offsets into the field. CodeMirror needs document ranges, and the document may have changed since the analysis was requested.

**Files:**
- Create: `apps/web/src/screens/templates/lint-positions.ts`, `lint-positions.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/screens/templates/lint-positions.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { toEditorRanges } from './lint-positions.js';

describe('toEditorRanges', () => {
  it('passes through ranges that fit the current document', () => {
    expect(toEditorRanges('<p>{{first_name}}</p>', [{ start: 3, end: 17, key: 'first_name' }]))
      .toEqual([{ from: 3, to: 17, key: 'first_name' }]);
  });

  it('drops ranges that start past the end of the document', () => {
    expect(toEditorRanges('<p>hi</p>', [{ start: 40, end: 55, key: 'stale' }])).toEqual([]);
  });

  it('clamps a range whose end runs past the document', () => {
    expect(toEditorRanges('<p>hi</p>', [{ start: 3, end: 99, key: 'clamped' }]))
      .toEqual([{ from: 3, to: 9, key: 'clamped' }]);
  });

  it('drops empty and inverted ranges', () => {
    expect(toEditorRanges('<p>hi</p>', [
      { start: 4, end: 4, key: 'empty' },
      { start: 6, end: 2, key: 'inverted' },
    ])).toEqual([]);
  });

  it('keeps ranges sorted by start position', () => {
    expect(toEditorRanges('0123456789', [
      { start: 6, end: 8, key: 'later' },
      { start: 1, end: 3, key: 'earlier' },
    ])).toEqual([
      { from: 1, to: 3, key: 'earlier' },
      { from: 6, to: 8, key: 'later' },
    ]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm --filter @eow/web test lint-positions
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/screens/templates/lint-positions.ts`:

```ts
export type AnalysisRange = { start: number; end: number; key: string };
export type EditorRange = { from: number; to: number; key: string };

/**
 * The analysis that produced these offsets ran against an earlier snapshot of
 * the document — the user keeps typing while the request is in flight. A stale
 * offset must never throw and must never mark the wrong text: ranges that no
 * longer fit are dropped, ranges that overrun the end are clamped.
 */
export function toEditorRanges(document: string, ranges: readonly AnalysisRange[]): EditorRange[] {
  return ranges
    .filter((range) => range.start >= 0 && range.start < document.length && range.end > range.start)
    .map((range) => ({ from: range.start, to: Math.min(range.end, document.length), key: range.key }))
    .filter((range) => range.to > range.from)
    .sort((left, right) => left.from - right.from);
}
```

- [ ] **Step 4: Run it to verify it passes**

```bash
pnpm --filter @eow/web test lint-positions
```

Expected: PASS, all five cases.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/screens/templates/lint-positions.ts apps/web/src/screens/templates/lint-positions.test.ts
git commit -m "feat(web): map analysis offsets onto editor ranges"
```

---

### Task 9: Route metadata

**Files:**
- Modify: `apps/web/src/app/page-meta.ts`, `apps/web/src/app/page-meta.test.ts`, `apps/web/src/app/AppShell.tsx`

- [ ] **Step 1: Write the failing tests**

Add to `apps/web/src/app/page-meta.test.ts`:

```ts
  it('titles the template editor route', () => {
    expect(resolvePageMeta('/templates/8f1c2d3e-0000-4000-8000-000000000000/edit').title).toBe('Chỉnh sửa template');
  });

  it('keeps the template list title', () => {
    expect(resolvePageMeta('/templates').title).toBe('Email template');
  });

  it('shows the autosave indicator on both composer and template editor routes', () => {
    expect(isAutosaveRoute('/campaigns/new')).toBe(true);
    expect(isAutosaveRoute('/campaigns/abc/edit')).toBe(true);
    expect(isAutosaveRoute('/templates/abc/edit')).toBe(true);
    expect(isAutosaveRoute('/templates')).toBe(false);
    expect(isAutosaveRoute('/campaigns')).toBe(false);
  });
```

Update the file's import to `import { isAutosaveRoute, resolvePageMeta } from './page-meta.js';`, keeping whatever else it already imports.

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm --filter @eow/web test page-meta
```

Expected: FAIL — `isAutosaveRoute` is not exported.

- [ ] **Step 3: Add the pattern and rename the predicate**

In `apps/web/src/app/page-meta.ts`, add the constant next to the others:

```ts
const TEMPLATE_EDITOR: PageMeta = { title: 'Chỉnh sửa template', description: 'Nội dung và biến riêng được lưu ở bản nháp; phiên bản đã xuất bản luôn bất biến.' };
```

Add the route **before** the existing `/templates` entry so ordering stays obvious even though the list pattern is anchored:

```ts
  [/^\/templates\/[^/]+\/edit$/, TEMPLATE_EDITOR],
  [/^\/templates$/, { title: 'Email template', description: 'Quản lý, chỉnh sửa và xem trước các template HTML.' }],
```

Replace `isComposeRoute` with:

```ts
/** Routes that autosave. AppShell uses this to decide whether to show the save indicator. */
export function isAutosaveRoute(pathname: string): boolean {
  return /^\/campaigns\/new$/.test(pathname)
    || /^\/campaigns\/[^/]+\/edit$/.test(pathname)
    || /^\/templates\/[^/]+\/edit$/.test(pathname);
}
```

- [ ] **Step 4: Update AppShell**

In `apps/web/src/app/AppShell.tsx`, change the import on line 6 to `isAutosaveRoute`, and line 69 to:

```ts
  const isAutosaveCompose = isAutosaveRoute(location.pathname);
```

Then rename the two or three usages of `isComposeCompose` further down in the same file to `isAutosaveCompose`. Run `pnpm --filter @eow/web typecheck` to find them all.

- [ ] **Step 5: Run tests and typecheck**

```bash
pnpm --filter @eow/web test page-meta
pnpm --filter @eow/web typecheck
```

Expected: page-meta PASS. Typecheck may still fail on `updateTemplate` from Task 6 — that is resolved in Task 11.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/app/page-meta.ts apps/web/src/app/page-meta.test.ts apps/web/src/app/AppShell.tsx
git commit -m "feat(web): title the template editor route and generalize the autosave indicator"
```

---

### Task 10: Code view — CodeMirror with a textarea fallback

**Files:**
- Modify: `apps/web/package.json`
- Create: `apps/web/src/screens/templates/TemplateCodeView.tsx`

- [ ] **Step 1: Add the dependency**

```bash
pnpm --filter @eow/web add codemirror@6 @codemirror/lang-html@6 @codemirror/view@6 @codemirror/state@6
```

- [ ] **Step 2: Write the component**

Create `apps/web/src/screens/templates/TemplateCodeView.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import { toEditorRanges, type AnalysisRange } from './lint-positions.js';

type Props = {
  value: string;
  ranges: readonly AnalysisRange[];
  disabled?: boolean;
  onChange: (value: string) => void;
  onCaretChange: (offset: number) => void;
};

/**
 * CodeMirror is loaded on demand so it stays out of the main bundle.
 * ARCH-NO-ORPHANS follows dynamic imports, so the module is still reachable.
 * If the chunk fails to load, the plain textarea below keeps the screen
 * usable — a failed dependency must never turn authoring into a blank page.
 */
export function TemplateCodeView({ value, ranges, disabled, onChange, onCaretChange }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let disposed = false;
    let view: { destroy: () => void } | null = null;

    void (async () => {
      try {
        const [{ EditorView, keymap }, { html }, { EditorState }, { defaultKeymap, history, historyKeymap }] = await Promise.all([
          import('@codemirror/view'),
          import('@codemirror/lang-html'),
          import('@codemirror/state'),
          import('@codemirror/commands'),
        ]);
        if (disposed || !host.current) return;
        const instance = new EditorView({
          parent: host.current,
          state: EditorState.create({
            doc: value,
            extensions: [
              html(),
              history(),
              keymap.of([...defaultKeymap, ...historyKeymap]),
              EditorView.editable.of(!disabled),
              EditorView.updateListener.of((update) => {
                if (update.docChanged) onChange(update.state.doc.toString());
                if (update.selectionSet) onCaretChange(update.state.selection.main.head);
              }),
            ],
          }),
        });
        view = instance;
      } catch {
        if (!disposed) setFailed(true);
      }
    })();

    return () => { disposed = true; view?.destroy(); };
    // Mount-only: later value changes are pushed through the editor's own
    // transaction API by the parent, not by re-creating the view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (failed) {
    return <textarea
      ref={textarea}
      className="template-code-fallback"
      value={value}
      rows={18}
      disabled={disabled}
      aria-label="Mã HTML của template"
      onChange={(event) => onChange(event.target.value)}
      onSelect={() => onCaretChange(textarea.current?.selectionStart ?? 0)}
    />;
  }

  return <div ref={host} className="template-code-editor" data-lint-count={toEditorRanges(value, ranges).length} />;
}
```

Lint decorations are wired in Task 11 once the screen owns the analysis state; `toEditorRanges` is called here so the count is available to the screen and to tests immediately.

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter @eow/web typecheck
```

Expected: no new errors from this file.

- [ ] **Step 4: Commit**

```bash
git add apps/web/package.json pnpm-lock.yaml apps/web/src/screens/templates/TemplateCodeView.tsx
git commit -m "feat(web): add a lazily loaded HTML code view with a textarea fallback"
```

---

### Task 11: The template editor screen

**Files:**
- Create: `apps/web/src/screens/templates/editor-ports.ts`, `apps/web/src/screens/templates/TemplateEditorScreen.tsx`
- Modify: `apps/web/src/screens/templates/TemplatesScreen.tsx` (remove lines 104–251), `apps/web/src/app/AppRoutes.tsx`

- [ ] **Step 1: Define the four ports**

Create `apps/web/src/screens/templates/editor-ports.ts`:

```ts
import type { EmailTemplate, TemplateAnalysis, TemplatePatch, TemplatePreview, TemplateVariableCatalogueItem } from '../../api/templates.js';

/**
 * The seam a second authoring system (Mailcraft) plugs into. Only the four
 * ports this screen actually uses are defined — an asset provider and a block
 * library are deliberately absent until there is a consumer for them.
 */
export type VariableProvider = { list: () => Promise<readonly TemplateVariableCatalogueItem[]> };
export type PreviewService = { render: (input: { mergeData: Record<string, string> }) => Promise<TemplatePreview> };
export type LintService = { check: (input: { subject: string; html: string; textBody: string }) => Promise<TemplateAnalysis> };
export type ContentStore = {
  load: () => Promise<EmailTemplate>;
  save: (input: TemplatePatch & { draftRevision: number }) => Promise<EmailTemplate>;
  publish: () => Promise<{ version: number }>;
};
```

There is no exported lint-issue type on the web side — the lint array is declared inline inside `TemplateAnalysis` (`apps/web/src/api/templates.ts:36`). Do not invent a `TemplateLintIssue` import; take the element type from the analysis when you need it:

```ts
export type LintIssue = TemplateAnalysis['lint'][number];
```

- [ ] **Step 2: Create the screen by moving the overlay**

Create `apps/web/src/screens/templates/TemplateEditorScreen.tsx`. Move the body of `TemplateActionsOverlay` (`TemplatesScreen.tsx` lines 104–251) into it, with these changes and no others:

1. Read `templateId` from `useParams`, load the template with `getTemplate(templateId)` instead of receiving it as a prop.
2. Replace `ModalFrame` with the screen frame the other screens use — `<section className="workspace-module-frame compose-variables-module">` with a `<header className="workspace-module-topbar">`, matching `ComposeDraftScreen.tsx`.
3. Replace `onClose` with `navigate('/templates')`.
4. Replace the manual "Lưu bản nháp" button with autosave: hold state in `useReducer(autosaveReducer<EmailTemplate, TemplatePatch>, …)`, and run the same debounced save effect `ComposeDraftScreen.tsx:234-246` uses — including `const conflict = cause instanceof ApiError && cause.status === 412;`.
5. Pass `state.draft.draftRevision` to `updateTemplate`.
6. Render the two-tab `.view-switch`: `Trình soạn thảo` (preview iframe) and `</> HTML` (`<TemplateCodeView>`).
7. Keep the right-hand variable panel exactly as it is today, including `ManageConfiguredVariableOverlay`.
8. Keep the unsaved-changes confirmation only for the archive action; closing no longer needs it, because autosave means nothing is unsaved.
9. Keep the existing debounced `analyzeTemplate` effect **including its `createSequenceGuard()`** — it is what stops a slow earlier response from overwriting a newer one.

The conflict UI reuses the markup already in `ComposeDraftScreen.tsx:369-380` — the same `.compose-conflict` block, with template fields instead of campaign fields.

- [ ] **Step 2b: Never blank the warnings when an analysis fails**

The current overlay calls `setError(...)` when `analyzeTemplate` rejects, which replaces the diagnostics area. While the user is typing, a single failed round trip must not make the warnings disappear — that reads as "I fixed it" when nothing was fixed.

Hold the last successful analysis and a staleness flag:

```tsx
const [analysis, setAnalysis] = useState<TemplateAnalysis | null>(null);
const [analysisStale, setAnalysisStale] = useState(false);
```

On success: `setAnalysis(result); setAnalysisStale(false);`
On failure: `setAnalysisStale(true);` — and do **not** touch `analysis`.

Render the marker above the diagnostics list when `analysisStale && analysis`:

```tsx
{analysisStale && analysis && <p className="field-help" role="status">Không kiểm tra được nội dung mới nhất. Cảnh báo bên dưới là từ lần kiểm gần nhất.</p>}
```

- [ ] **Step 3: Delete the overlay and link to the route**

In `TemplatesScreen.tsx`:
- Delete lines 104–251 (`TemplateActionsOverlay`).
- Remove `{ kind: 'actions'; template: EmailTemplate }` from the `Overlay` union and the `overlay?.kind === 'actions'` render branch.
- Change the "Chỉnh sửa template" menu item to `onSelect: () => navigate(\`/templates/${template.id}/edit\`)`, adding `const navigate = useNavigate();` to `TemplatesScreen` and importing it from `react-router-dom`.
- Remove imports that are now unused (`ModalFrame`, `insertTemplateVariable`, `groupTemplateCatalogue`, `hasTemplateDraftChanges`, `ManageConfiguredVariableOverlay`, `listTemplateVariables`, `deleteTemplateVariable`, and any others typecheck flags).

- [ ] **Step 4: Register the route**

In `apps/web/src/app/AppRoutes.tsx`, import the screen and add the route directly after the `/templates` route, inside the same protected layout:

```tsx
        <Route
          path="/templates/:templateId/edit"
          element={
            <RequirePermission permission={routePermissions['/templates']!}>
              <TemplateEditorScreen />
            </RequirePermission>
          }
        />
```

Reusing `routePermissions['/templates']` is deliberate: editing a template requires exactly the permission the template section already requires, and inventing a second key would let the two drift apart.

- [ ] **Step 5: Typecheck and run the web tests**

```bash
pnpm --filter @eow/web typecheck
pnpm --filter @eow/web test
```

Expected: PASS. Every `updateTemplate` type error from Task 6 is now gone.

- [ ] **Step 6: Run the architecture tests**

```bash
pnpm --filter @eow/architecture-tests test
```

Expected: PASS — in particular `ARCH-NO-ORPHANS` (the new modules are reachable from `main.tsx` through `AppRoutes`) and `ARCH-WEB-STRUCTURE`.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/screens/templates apps/web/src/app/AppRoutes.tsx
git commit -m "feat(web): move template editing to its own route with autosave"
```

---

### Task 12: Replace the composer's dead editor shell

**Files:**
- Modify: `apps/web/src/screens/compose/ComposeDraftScreen.tsx`

- [ ] **Step 1: Remove the placeholder**

In `ComposeDraftScreen.tsx:368`, delete this fragment from the JSX:

```tsx
<div className="editor-shell"><div className="editor-head"><div className="view-switch"><button className="active">Trình soạn thảo</button><button disabled>&lt;/&gt; HTML</button></div><span>{…autosave text…}</span></div><div className="email-canvas"><h2>Bản nháp chiến dịch</h2><p>Nội dung HTML và chọn template được tích hợp ở các bước campaign tiếp theo.</p></div></div>
```

The autosave status text it contained is already shown by AppShell's own indicator on this route, so nothing is lost.

- [ ] **Step 2: Add the preview tab to the context panel**

The panel currently renders a single-button `.panel-switch`. Restore the two-tab version handoff v2 specifies (`design-reference/ui-handoff-v2/source/app/page.tsx:135`):

```tsx
<div className="panel-switch">
  <button className={panel === 'variables' ? 'active' : ''} onClick={() => setPanel('variables')}>Biến dữ liệu</button>
  <button className={panel === 'preview' ? 'active' : ''} onClick={() => setPanel('preview')}>Xem trước</button>
</div>
```

Add `const [panel, setPanel] = useState<'variables' | 'preview'>('variables');` alongside the other state hooks. Wrap the existing variable list in `{panel === 'variables' && (…)}`.

- [ ] **Step 3: Render the preview**

When `panel === 'preview'` and `state.draft.templateVersionId` is set, call `previewTemplateVersion(state.draft.templateVersionId, sample)` and render the result inside `.mini-preview`, showing `result.missingKeys` when non-empty. When no template is selected yet, render an empty state pointing at the "Chọn template" action rather than a blank panel.

```tsx
{panel === 'preview' && (
  templateVersion
    ? <ComposePreviewPanel templateVersionId={templateVersion.id} subject={state.draft.subject} />
    : <p className="compose-variable-state">Chọn một template để xem trước nội dung người nhận sẽ thấy.</p>
)}
```

Define `ComposePreviewPanel` in the same file, next to `VariableRows`, following the loading/error/success shape `TemplatePreviewOverlay` already uses in `TemplatesScreen.tsx:267-323`.

- [ ] **Step 4: Typecheck and test**

```bash
pnpm --filter @eow/web typecheck
pnpm --filter @eow/web test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/screens/compose/ComposeDraftScreen.tsx
git commit -m "feat(web): replace the composer placeholder with a real preview tab"
```

---

### Task 13: Verification and evidence

**Files:**
- Modify: `apps/web/e2e/visual-capture.spec.ts`

- [ ] **Step 1: Check the e2e specs that touch templates**

There is no dedicated templates e2e spec. Two files reference templates and must be re-read after the route change:

```bash
grep -n "templates" apps/web/e2e/visual-capture.spec.ts apps/web/e2e/rbac.spec.ts
```

`visual-capture.spec.ts:561-598` captures `/templates` in loading and empty states; `rbac.spec.ts` checks permission behaviour. Fix any assertion that assumed editing happens in a modal.

- [ ] **Step 2: Add capture for the new route**

Extend the templates block in `visual-capture.spec.ts` with a capture of `/templates/:id/edit` across the three required viewports, following the exact structure of the existing captures in that file (same `M3_S1_EVIDENCE_ROOT` pattern, same route-mocking approach).

- [ ] **Step 3: Run the full verification**

```bash
pnpm check
```

Expected: PASS — typecheck, build, and every test across the workspace. Read the output; do not rely on the exit code alone.

- [ ] **Step 4: Verify in a real browser**

Start the app and sign in as `admin@example.test` / `Admin@123`. Confirm each of these by hand:

1. `/templates` → menu → "Chỉnh sửa template" lands on `/templates/<id>/edit`, and the browser back button returns to the list.
2. Typing in the HTML view shows "Đang tự động lưu…" then "Đã tự động lưu" in the shell indicator.
3. Opening the same template in a second tab, saving there, then typing in the first tab produces the conflict UI — not a silent overwrite.
4. A lint warning (remove an `alt` from an `<img>`) appears against the right line.
5. The preview tab renders with sample data and lists `missingKeys` when a variable has no sample value.
6. The composer at `/campaigns/<id>/edit` shows the `Xem trước` tab and no dead editor shell.
7. Repeat 1 and 5 at 1440×900, 768×1024 and 390×844.

- [ ] **Step 5: Commit**

```bash
git add apps/web/e2e/visual-capture.spec.ts
git commit -m "test(e2e): capture the routed template editor"
```

---

## Done when

- `pnpm check` passes.
- `pnpm contracts:compat-check` reports no unexpected change. Note it cannot see the new required `If-Match` header at all (it does not inspect `parameters`), so the web client's use of the header is verified by Task 13's manual browser pass, not by this gate.
- The seven manual checks in Task 13 Step 4 all hold.
- `origin`, `project_data` and `draft_revision` exist in the database, and `projectData` appears in no API response.
