import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { HttpExceptionFilter } from '../../src/common/http-exception.filter.js';
import { testPasswordHash } from './test-password.js';
import { AppUserEntity } from '../../src/database/entities/app-user.entity.js';
import { AuditLogEntity } from '../../src/database/entities/audit-log.entity.js';
import { CustomFieldDefinitionEntity } from '../../src/database/entities/custom-field-definition.entity.js';
import { EmailTemplateVersionEntity } from '../../src/database/entities/email-template-version.entity.js';
import { OutboxEventEntity } from '../../src/database/entities/outbox-event.entity.js';
import { TemplateTestSendEntity } from '../../src/database/entities/template-test-send.entity.js';
import { TenantEntity } from '../../src/database/entities/tenant.entity.js';
import { UserSessionEntity } from '../../src/database/entities/user-session.entity.js';
import { deleteTemplateVersionFixtures } from './template-version-fixtures.js';
import { testDatabaseUrl } from './test-database-url.js';
import { testRedisUrl } from './test-redis-url.js';

describe('Templates HTTP (M3-S1: BR-TPL-002/006/009/010)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let tenantA: TenantEntity;
  let tenantB: TenantEntity;
  const password = 'correct-horse-battery-staple';
  const operatorA = `template-operator-a-${randomUUID()}@test.dev`;
  const operatorB = `template-operator-b-${randomUUID()}@test.dev`;
  const viewer = `template-viewer-${randomUUID()}@test.dev`;

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl();
    process.env.REDIS_URL = testRedisUrl();
    process.env.SESSION_SECRET = 'a'.repeat(64);
    process.env.WEB_ORIGIN = 'http://localhost:5173';
    const { AppModule } = await import('../../src/app.module.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
    dataSource = moduleRef.get(getDataSourceToken());
    tenantA = await dataSource.getRepository(TenantEntity).save({ name: `template-http-a-${randomUUID()}` });
    tenantB = await dataSource.getRepository(TenantEntity).save({ name: `template-http-b-${randomUUID()}` });
    const users = dataSource.getRepository(AppUserEntity);
    await users.save([
      { tenantId: tenantA.id, email: operatorA, displayName: 'Template Operator A', role: 'operator', passwordHash: await testPasswordHash(password), status: 'active' },
      { tenantId: tenantB.id, email: operatorB, displayName: 'Template Operator B', role: 'operator', passwordHash: await testPasswordHash(password), status: 'active' },
      { tenantId: tenantA.id, email: viewer, displayName: 'Template Viewer', role: 'viewer', passwordHash: await testPasswordHash(password), status: 'active' },
    ]);
  });

  afterAll(async () => {
    if (!dataSource) { await app?.close(); return; }
    await dataSource.getRepository(OutboxEventEntity).delete({ tenantId: tenantA.id });
    await dataSource.getRepository(OutboxEventEntity).delete({ tenantId: tenantB.id });
    await dataSource.getRepository(TemplateTestSendEntity).delete({ tenantId: tenantA.id });
    await dataSource.getRepository(TemplateTestSendEntity).delete({ tenantId: tenantB.id });
    await deleteTemplateVersionFixtures(dataSource, [tenantA.id, tenantB.id]);
    await dataSource.query('DELETE FROM email_template WHERE tenant_id = ANY($1)', [[tenantA.id, tenantB.id]]);
    await dataSource.getRepository(UserSessionEntity).delete({ tenantId: tenantA.id });
    await dataSource.getRepository(UserSessionEntity).delete({ tenantId: tenantB.id });
    await dataSource.getRepository(AppUserEntity).delete({ tenantId: tenantA.id });
    await dataSource.getRepository(AppUserEntity).delete({ tenantId: tenantB.id });
    // Audit rows are intentionally immutable and retain their tenant fixtures,
    // exactly like the audit-log immutability suite.
    await app.close();
  });

  async function login(email: string): Promise<{ cookie: string; csrfToken: string }> {
    const response = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password });
    const cookies = response.headers['set-cookie'] as unknown as string[];
    return { cookie: cookies.map((entry) => entry.split(';')[0]).join('; '), csrfToken: cookies.find((entry) => entry.startsWith('eow_csrf='))!.split(';')[0].split('=')[1] };
  }

  it('sanitizes imported HTML, enforces CSRF/RBAC and rejects normalized duplicates', async () => {
    const session = await login(operatorA);
    const noCsrf = await request(app.getHttpServer()).post('/api/v1/templates').set('Cookie', session.cookie).send({ name: 'Welcome' });
    expect(noCsrf.status).toBe(403);

    const created = await request(app.getHttpServer()).post('/api/v1/templates').set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken)
      .send({ name: '  Welcome  ', subject: 'Welcome', html: '<style>p{color:red}</style><p onclick="alert(1)">Hi</p><script>alert(1)</script><img src="data:image/png;base64,AAAA">' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'Welcome', subject: 'Welcome' });
    expect(created.body.html).toMatch(/color:\s*red/i);
    expect(created.body.html).not.toMatch(/script|onclick|data:image/i);
    // S7 Task 44: `changes` used to be one fixed sentence, so this assertion
    // only ever proved the field was populated. It now has to arrive naming each
    // thing that went, over the wire, in the language the reader uses -- three
    // different kinds of loss from one import, none of them silent.
    expect(created.body.validation.changes).toEqual(expect.arrayContaining([
      expect.stringContaining('1 thẻ <script>'),
      expect.stringContaining('ảnh không dùng https'),
      expect.stringContaining('onclick'),
    ]));

    const duplicate = await request(app.getHttpServer()).post('/api/v1/templates').set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken)
      .send({ name: 'welcome', subject: 'Duplicate', html: '<p>Duplicate</p>' });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body).toMatchObject({ code: 'TEMPLATE_NAME_CONFLICT' });

    // 073_content_read_permission.sql split reading template content
    // (content:read, held by every role) from changing it (content:manage).
    // The viewer therefore reads the library -- that is what makes the
    // editor's read-only permission_denied state possible at all
    // (mailcraft-integration-requirements.md §5.1) -- and is still refused
    // every write, which is the half that matters for BR-AUTH-004.
    const viewerSession = await login(viewer);
    const allowedRead = await request(app.getHttpServer()).get('/api/v1/templates').set('Cookie', viewerSession.cookie);
    expect(allowedRead.status).toBe(200);

    const deniedWrite = await request(app.getHttpServer()).post('/api/v1/templates').set('Cookie', viewerSession.cookie).set('x-csrf-token', viewerSession.csrfToken)
      .send({ name: 'Viewer should not create this', subject: 'Nope', html: '<p>Nope</p>' });
    expect(deniedWrite.status).toBe(403);
    expect(deniedWrite.headers['content-type']).toContain('application/problem+json');
  });

  it('keeps html and textBody out of the library listing but not out of the detail', async () => {
    const session = await login(operatorA);
    const created = await request(app.getHttpServer())
      .post('/api/v1/templates')
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken)
      .send({ name: `Projection ${randomUUID()}`, subject: 'Tiêu đề', html: '<p>Xin chào</p>' })
      .expect(201);

    const list = await request(app.getHttpServer())
      .get('/api/v1/templates').set('Cookie', session.cookie).expect(200);
    const listed = list.body.items.find((item: { id: string }) => item.id === created.body.id);

    expect(listed).toBeDefined();
    expect(listed).not.toHaveProperty('html');
    expect(listed).not.toHaveProperty('textBody');
    // Everything the library actually renders must survive the projection.
    expect(listed.name).toBe(created.body.name);
    expect(listed.subject).toBe('Tiêu đề');
    expect(listed.status).toBe('draft');
    expect(listed.updatedAt).toBeDefined();

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/templates/${created.body.id}`).set('Cookie', session.cookie).expect(200);
    expect(detail.body.html).toContain('Xin chào');
    expect(detail.body).toHaveProperty('textBody');
  });

  it('round-trips projectData on a builder template', async () => {
    const session = await login(operatorA);
    const auth = (call: request.Test) => call.set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken);
    const server = app.getHttpServer();

    const created = await auth(request(server).post('/api/v1/templates'))
      .send({ name: `Onboarding ${randomUUID()}`, origin: 'builder' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.origin).toBe('builder');
    expect(created.body.projectData).toBeNull();

    const tree = { pages: [{ frames: [{ component: { type: 'wrapper' } }] }] };
    const saved = await auth(request(server).patch(`/api/v1/templates/${created.body.id}`))
      .set('if-match', String(created.body.draftRevision))
      .send({ projectData: tree, html: '<p>x</p>' });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.projectData).toEqual(tree);

    const read = await request(server).get(`/api/v1/templates/${created.body.id}`).set('Cookie', session.cookie);
    expect(read.body.projectData).toEqual(tree);
  });

  it('keeps projectData out of the library listing', async () => {
    // Same rule as html/textBody (ADR-035): lists carry metadata, detail routes
    // carry content. A component tree is content and would restore the size
    // coupling ADR-035 exists to remove.
    const session = await login(operatorA);
    const auth = (call: request.Test) => call.set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken);
    const server = app.getHttpServer();

    const created = await auth(request(server).post('/api/v1/templates'))
      .send({ name: `Builder listing ${randomUUID()}`, origin: 'builder' });
    expect(created.status).toBe(201);

    const list = await request(server).get('/api/v1/templates?limit=100').set('Cookie', session.cookie);
    const listed = list.body.items.find((item: { id: string }) => item.id === created.body.id);
    expect(listed).toBeDefined();
    expect(listed).not.toHaveProperty('projectData');
  });

  it('publishes immutable version snapshots with audit/outbox evidence and isolates tenants', async () => {
    const sessionA = await login(operatorA);
    const sessionB = await login(operatorB);
    const created = await request(app.getHttpServer()).post('/api/v1/templates').set('Cookie', sessionA.cookie).set('x-csrf-token', sessionA.csrfToken)
      .send({ name: `Invoice ${randomUUID()}`, subject: 'Invoice v1', html: '<p>First body</p>' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ latestVersionId: null });
    const templateId = created.body.id as string;

    const published = await request(app.getHttpServer()).post(`/api/v1/templates/${templateId}/publish`).set('Cookie', sessionA.cookie).set('x-csrf-token', sessionA.csrfToken);
    expect(published.status).toBe(201);
    expect(published.body).toMatchObject({ templateId, version: 1, contentHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const versionId = published.body.id as string;

    // The UI drives preview/test-send off latestVersionId -- prove list() and get() both
    // resolve it, and that it tracks the *newest* version after a republish (DISTINCT ON
    // ... ORDER BY version DESC, not just "a" version).
    const afterV1Get = await request(app.getHttpServer()).get(`/api/v1/templates/${templateId}`).set('Cookie', sessionA.cookie);
    expect(afterV1Get.body).toMatchObject({ latestVersionId: versionId });
    const afterV1List = await request(app.getHttpServer()).get('/api/v1/templates').set('Cookie', sessionA.cookie);
    expect(afterV1List.body.items.find((item: { id: string }) => item.id === templateId)).toMatchObject({ latestVersionId: versionId });

    const forbiddenVersionMutation = await request(app.getHttpServer()).patch(`/api/v1/template-versions/${versionId}`).set('Cookie', sessionA.cookie).set('x-csrf-token', sessionA.csrfToken).send({ subject: 'attack' });
    expect(forbiddenVersionMutation.status).toBe(405);
    const forbiddenVersionDelete = await request(app.getHttpServer()).delete(`/api/v1/template-versions/${versionId}`).set('Cookie', sessionA.cookie).set('x-csrf-token', sessionA.csrfToken);
    expect(forbiddenVersionDelete.status).toBe(405);

    const updated = await request(app.getHttpServer()).patch(`/api/v1/templates/${templateId}`).set('Cookie', sessionA.cookie).set('x-csrf-token', sessionA.csrfToken).set('if-match', '2').send({ subject: 'Invoice v2', html: '<p>Second body</p>' });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    const v2 = await request(app.getHttpServer()).post(`/api/v1/templates/${templateId}/publish`).set('Cookie', sessionA.cookie).set('x-csrf-token', sessionA.csrfToken);
    expect(v2.status).toBe(201);
    expect(v2.body.version).toBe(2);
    const afterV2Get = await request(app.getHttpServer()).get(`/api/v1/templates/${templateId}`).set('Cookie', sessionA.cookie);
    expect(afterV2Get.body).toMatchObject({ latestVersionId: v2.body.id });
    expect(afterV2Get.body.latestVersionId).not.toBe(versionId);
    const old = await request(app.getHttpServer()).get(`/api/v1/template-versions/${versionId}`).set('Cookie', sessionA.cookie);
    expect(old.body).toMatchObject({ version: 1, subject: 'Invoice v1', html: '<p>First body</p>' });

    const crossTenant = await request(app.getHttpServer()).get(`/api/v1/templates/${templateId}`).set('Cookie', sessionB.cookie);
    expect(crossTenant.status).toBe(404);
    const audit = await dataSource.getRepository(AuditLogEntity).findOne({ where: { tenantId: tenantA.id, action: 'template.published', entityId: templateId }, order: { occurredAt: 'DESC' } });
    expect(audit?.metadata).toMatchObject({ templateVersionId: v2.body.id, version: 2 });
    const outbox = await dataSource.getRepository(OutboxEventEntity).findOne({ where: { tenantId: tenantA.id, eventType: 'template.published', aggregateId: templateId, aggregateVersion: '2' } });
    expect(outbox?.payload).toMatchObject({ templateId, templateVersionId: v2.body.id, version: 2 });
  });

  it('publishes a canonical tenant variable schema and rejects unsafe or unknown expressions', async () => {
    const session = await login(operatorA);
    const incomplete = await request(app.getHttpServer()).post('/api/v1/templates').set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken).send({ name: `Incomplete ${randomUUID()}` });
    const incompletePublish = await request(app.getHttpServer()).post(`/api/v1/templates/${incomplete.body.id}/publish`).set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken);
    expect(incompletePublish.status).toBe(422);
    expect(incompletePublish.body).toMatchObject({
      code: 'TEMPLATE_DRAFT_INCOMPLETE', nextAction: 'COMPLETE_TEMPLATE_DRAFT',
      fieldErrors: expect.arrayContaining([expect.objectContaining({ field: 'subject', code: 'REQUIRED' })]),
    });

    await dataSource.getRepository(CustomFieldDefinitionEntity).save({
      tenantId: tenantA.id, fieldKey: 'employee_grade', label: 'Employee grade', dataType: 'enum', required: true, defaultValue: null, enumOptions: ['A', 'B'], sensitive: false,
    });
    await dataSource.getRepository(CustomFieldDefinitionEntity).save({
      tenantId: tenantA.id, fieldKey: 'office_name', label: 'Office name', dataType: 'text', required: true, defaultValue: 'Bangkok', enumOptions: null, sensitive: false,
    });

    const variable = await request(app.getHttpServer()).post('/api/v1/templates').set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken)
      .send({ name: `Variable ${randomUUID()}`, subject: 'Hi {{email}}', html: '<p>{{employee_grade}} at {{office_name}}</p>', textBody: 'Stop: {{unsubscribe_url}}' });
    const variablePublish = await request(app.getHttpServer()).post(`/api/v1/templates/${variable.body.id}/publish`).set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken);
    expect(variablePublish.status, JSON.stringify(variablePublish.body)).toBe(201);
    expect(variablePublish.body.variableSchema).toEqual({
      required: ['email', 'employee_grade'],
      optional: ['office_name', 'unsubscribe_url'],
      defaults: { office_name: 'Bangkok' },
    });
    const stored = await dataSource.getRepository(EmailTemplateVersionEntity).findOneByOrFail({ id: variablePublish.body.id });
    expect(stored.requiredVariables).toEqual(['email', 'employee_grade']);
    expect(stored.variableSchemaJson).toEqual(variablePublish.body.variableSchema);

    const versionsBefore = await dataSource.getRepository(EmailTemplateVersionEntity).count({ where: { tenantId: tenantA.id } });
    const unknown = await request(app.getHttpServer()).post('/api/v1/templates').set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken)
      .send({ name: `Unknown ${randomUUID()}`, subject: 'Hi {{not_in_this_tenant}}', html: '<p>Body</p>' });
    const unknownPublish = await request(app.getHttpServer()).post(`/api/v1/templates/${unknown.body.id}/publish`).set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken);
    expect(unknownPublish.status).toBe(422);
    expect(unknownPublish.body).toMatchObject({
      code: 'UNKNOWN_VARIABLE', variableKey: 'not_in_this_tenant', nextAction: 'OPEN_CUSTOM_FIELDS',
      fieldErrors: expect.arrayContaining([expect.objectContaining({ code: 'UNKNOWN_VARIABLE', value: 'not_in_this_tenant' })]),
    });
    const unsafe = await request(app.getHttpServer()).post('/api/v1/templates').set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken)
      .send({ name: `Unsafe ${randomUUID()}`, subject: '{{uppercase email}}', html: '<p>Body</p>' });
    const unsafePublish = await request(app.getHttpServer()).post(`/api/v1/templates/${unsafe.body.id}/publish`).set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken);
    expect(unsafePublish.status).toBe(422);
    expect(unsafePublish.body).toMatchObject({ code: 'UNSAFE_TEMPLATE_EXPRESSION' });
    expect(await dataSource.getRepository(EmailTemplateVersionEntity).count({ where: { tenantId: tenantA.id } })).toBe(versionsBefore);
  });

  it('publishes the UI-shaped payload when one variable is reused in subject and HTML', async () => {
    const session = await login(operatorA);
    const draft = await request(app.getHttpServer()).post('/api/v1/templates').set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken)
      .send({ name: `UI reuse ${randomUUID()}`, subject: 'Hi {{first_name}}', html: '<p>Dear {{first_name}}</p>' });

    const published = await request(app.getHttpServer()).post(`/api/v1/templates/${draft.body.id}/publish`).set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken);

    expect(published.status, JSON.stringify(published.body)).toBe(201);
    expect(published.body.variableSchema).toEqual({ required: [], optional: ['first_name'] });
  });

  it('publishes a variable in HTML when textBody is omitted', async () => {
    const session = await login(operatorA);
    const draft = await request(app.getHttpServer()).post('/api/v1/templates').set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken)
      .send({ name: `UI fallback ${randomUUID()}`, subject: 'Hello', html: '<p>Hi {{first_name}}</p>' });

    const published = await request(app.getHttpServer()).post(`/api/v1/templates/${draft.body.id}/publish`).set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken);

    expect(published.status, JSON.stringify(published.body)).toBe(201);
    expect(published.body.variableSchema).toEqual({ required: [], optional: ['first_name'] });
    expect(published.body.textBody).toContain('{{first_name}}');
  });

  it('renders a lenient preview from immutable version data without creating campaign, send, or outbox rows', async () => {
    const session = await login(operatorA);
    const template = await request(app.getHttpServer()).post('/api/v1/templates').set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken)
      .send({ name: `Preview ${randomUUID()}`, subject: 'Hi {{email}}', html: '<p>Hello {{email}} &amp; <a href="https://example.test">xem</a></p>' });
    const published = await request(app.getHttpServer()).post(`/api/v1/templates/${template.body.id}/publish`).set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken);
    const [before] = await dataSource.query(`SELECT (SELECT count(*)::int FROM campaign WHERE tenant_id = $1) AS campaigns, (SELECT count(*)::int FROM campaign_recipient WHERE tenant_id = $1) AS recipients, (SELECT count(*)::int FROM outbox_event WHERE tenant_id = $1) AS outbox`, [tenantA.id]);

    const preview = await request(app.getHttpServer()).post(`/api/v1/template-versions/${published.body.id}/preview`).set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken).send({ mergeData: {} });

    expect(preview.status, JSON.stringify(preview.body)).toBe(201);
    expect(preview.body).toMatchObject({ subject: 'Hi ', html: '<p>Hello  &amp; <a href="https://example.test">xem</a></p>', textBody: 'Hello  & xem (https://example.test)', missingKeys: ['email'] });
    const [after] = await dataSource.query(`SELECT (SELECT count(*)::int FROM campaign WHERE tenant_id = $1) AS campaigns, (SELECT count(*)::int FROM campaign_recipient WHERE tenant_id = $1) AS recipients, (SELECT count(*)::int FROM outbox_event WHERE tenant_id = $1) AS outbox`, [tenantA.id]);
    expect(after).toEqual(before);
  });

  it('requires an idempotency key before accepting a test send', async () => {
    const session = await login(operatorA);
    const template = await request(app.getHttpServer()).post('/api/v1/templates').set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken)
      .send({ name: `Test send ${randomUUID()}`, subject: 'Hello', html: '<p>Hello</p>' });
    const published = await request(app.getHttpServer()).post(`/api/v1/templates/${template.body.id}/publish`).set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken);

    const response = await request(app.getHttpServer()).post(`/api/v1/template-versions/${published.body.id}/test-send`).set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken).send({ mergeData: {} });

    expect(response.status).toBe(400);
  });

  it('delivers a tagged multipart test email only to the authenticated actor and replays an idempotent request', async () => {
    process.env.SMTP_HOST = '127.0.0.1';
    process.env.SMTP_PORT = '1025';
    const session = await login(operatorA);
    const template = await request(app.getHttpServer()).post('/api/v1/templates').set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken)
      .send({ name: `Mailpit test ${randomUUID()}`, subject: 'Xin chào {{email}}', html: '<p>Xin chào {{email}}</p>' });
    const published = await request(app.getHttpServer()).post(`/api/v1/templates/${template.body.id}/publish`).set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken);
    const key = `test-send-${randomUUID()}`;

    const first = await request(app.getHttpServer()).post(`/api/v1/template-versions/${published.body.id}/test-send`).set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken).set('Idempotency-Key', key).send({ mergeData: {} });
    const replay = await request(app.getHttpServer()).post(`/api/v1/template-versions/${published.body.id}/test-send`).set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken).set('Idempotency-Key', key).send({ mergeData: {} });

    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body).toMatchObject({ recipient: operatorA, idempotencyReplayed: false });
    expect(replay.status, JSON.stringify(replay.body)).toBe(201);
    expect(replay.body).toMatchObject({ id: first.body.id, recipient: operatorA, idempotencyReplayed: true });
    expect(await dataSource.getRepository(TemplateTestSendEntity).count({ where: { tenantId: tenantA.id, id: first.body.id } })).toBe(1);
    expect(await dataSource.getRepository(AuditLogEntity).findOne({ where: { tenantId: tenantA.id, action: 'template.test_sent', entityId: first.body.id } })).toMatchObject({ actorId: expect.any(String), metadata: expect.objectContaining({ recipient: operatorA, test: true }) });
  });

  it('persists a failed attempt and does not retry it under the same idempotency key', async () => {
    process.env.SMTP_HOST = '127.0.0.1';
    process.env.SMTP_PORT = '1';
    const session = await login(operatorA);
    const template = await request(app.getHttpServer()).post('/api/v1/templates').set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken)
      .send({ name: `Failed test ${randomUUID()}`, subject: 'Hello', html: '<p>Hello</p>' });
    const published = await request(app.getHttpServer()).post(`/api/v1/templates/${template.body.id}/publish`).set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken);
    const key = `failed-test-send-${randomUUID()}`;

    const failed = await request(app.getHttpServer()).post(`/api/v1/template-versions/${published.body.id}/test-send`).set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken).set('Idempotency-Key', key).send({ mergeData: {} });
    const retry = await request(app.getHttpServer()).post(`/api/v1/template-versions/${published.body.id}/test-send`).set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken).set('Idempotency-Key', key).send({ mergeData: {} });

    expect(failed.status).toBe(503);
    expect(retry.status).toBe(409);
    expect(await dataSource.getRepository(TemplateTestSendEntity).findOne({ where: { tenantId: tenantA.id, status: 'failed' }, order: { createdAt: 'DESC' } })).toMatchObject({ recipientEmail: operatorA });
    process.env.SMTP_HOST = '127.0.0.1';
    process.env.SMTP_PORT = '1025';
  });

  it('reports UNKNOWN_VARIABLE for an unknown HTML key when textBody is omitted', async () => {
    const session = await login(operatorA);
    const draft = await request(app.getHttpServer()).post('/api/v1/templates').set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken)
      .send({ name: `UI unknown ${randomUUID()}`, subject: 'Hello', html: '<p>{{not_in_this_tenant}}</p>' });

    const rejected = await request(app.getHttpServer()).post(`/api/v1/templates/${draft.body.id}/publish`).set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken);

    expect(rejected.status).toBe(422);
    expect(rejected.body).toMatchObject({ code: 'UNKNOWN_VARIABLE', variableKey: 'not_in_this_tenant' });
  });

  it('reports TEXT_BODY_EMPTY from analyze only when the author sent an empty text body', async () => {
    const session = await login(operatorA);
    const analyze = (body: Record<string, unknown>) => request(app.getHttpServer()).post('/api/v1/templates/analyze')
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken).send(body);
    const codes = (response: { body: { lint: Array<{ code: string }> } }) => response.body.lint.map((issue) => issue.code);

    // The author cleared the text body: the warning is about what they wrote,
    // not about the fallback the analysis hands back for preview.
    const cleared = await analyze({ subject: 'Test', html: '<p>Xin chào</p>', textBody: '' });
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(201);
    expect(cleared.body.lint).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'TEXT_BODY_EMPTY', severity: 'warning', count: 1, field: 'textBody' }),
    ]));

    const whitespaceOnly = await analyze({ subject: 'Test', html: '<p>Xin chào</p>', textBody: '   ' });
    expect(codes(whitespaceOnly)).toContain('TEXT_BODY_EMPTY');

    const written = await analyze({ subject: 'Test', html: '<p>Xin chào</p>', textBody: 'Xin chào' });
    expect(codes(written)).not.toContain('TEXT_BODY_EMPTY');

    // Callers that analyse HTML alone (the create modal has no text-body input)
    // are not authoring a text body, so there is nothing to warn them about.
    const omitted = await analyze({ subject: 'Test', html: '<p>Xin chào</p>' });
    expect(codes(omitted)).not.toContain('TEXT_BODY_EMPTY');
  });

  it('archives templates without removing their immutable history', async () => {
    const session = await login(operatorA);

    const published = await request(app.getHttpServer()).post('/api/v1/templates').set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken).send({ name: `Archive ${randomUUID()}`, subject: 'Archive', html: '<p>Archive body</p>' });
    const version = await request(app.getHttpServer()).post(`/api/v1/templates/${published.body.id}/publish`).set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken);
    const archived = await request(app.getHttpServer()).delete(`/api/v1/templates/${published.body.id}`).set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken);
    expect(archived.status).toBe(204);
    const history = await request(app.getHttpServer()).get(`/api/v1/template-versions/${version.body.id}`).set('Cookie', session.cookie);
    expect(history.status).toBe(200);
    const changeArchived = await request(app.getHttpServer()).patch(`/api/v1/templates/${published.body.id}`).set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken).set('if-match', '1').send({ subject: 'blocked' });
    expect(changeArchived.status, JSON.stringify(changeArchived.body)).toBe(409);
  });

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

  it('lists published versions newest first, without their html, and records who published', async () => {
    const session = await login(operatorA);
    const auth = (call: request.Test) => call.set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken);
    const server = app.getHttpServer();

    const created = await auth(request(server).post('/api/v1/templates'))
      .send({ name: `Version list ${randomUUID()}`, subject: 'First subject', html: '<p>First body</p>' });
    const id = created.body.id as string;

    expect((await auth(request(server).post(`/api/v1/templates/${id}/publish`))).status).toBe(201);
    const draftRevision = (await request(server).get(`/api/v1/templates/${id}`).set('Cookie', session.cookie)).body.draftRevision as number;
    await auth(request(server).patch(`/api/v1/templates/${id}`)).set('if-match', String(draftRevision)).send({ subject: 'Second subject', html: '<p>Second body</p>' });
    expect((await auth(request(server).post(`/api/v1/templates/${id}/publish`))).status).toBe(201);

    const listed = await request(server).get(`/api/v1/templates/${id}/versions`).set('Cookie', session.cookie);
    expect(listed.status).toBe(200);
    expect(listed.body.items.map((item: { version: number }) => item.version)).toEqual([2, 1]);
    expect(listed.body.items[0].subject).toBe('Second subject');
    expect(listed.body.items[0].publishedBy).toEqual(expect.any(String));
    // The payload is a picker, not a content dump: a 5 MB template times N
    // versions would be unusable.
    expect(listed.body.items[0].html).toBeUndefined();
    expect(listed.body.items[0].textBody).toBeUndefined();
  });

  it('restores a published version into the draft under If-Match without touching the version', async () => {
    const session = await login(operatorA);
    const auth = (call: request.Test) => call.set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken);
    const server = app.getHttpServer();

    const created = await auth(request(server).post('/api/v1/templates'))
      .send({ name: `Restore ${randomUUID()}`, subject: 'Original', html: '<p>Original body</p>' });
    const id = created.body.id as string;
    expect((await auth(request(server).post(`/api/v1/templates/${id}/publish`))).status).toBe(201);

    const versions = await request(server).get(`/api/v1/templates/${id}/versions`).set('Cookie', session.cookie);
    const versionId = versions.body.items[0].id as string;

    const afterPublish = (await request(server).get(`/api/v1/templates/${id}`).set('Cookie', session.cookie)).body.draftRevision as number;
    await auth(request(server).patch(`/api/v1/templates/${id}`)).set('if-match', String(afterPublish)).send({ subject: 'Wandered off', html: '<p>Wandered off</p>' });

    const noHeader = await auth(request(server).post(`/api/v1/templates/${id}/versions/${versionId}/restore`));
    expect(noHeader.status).toBe(428);
    const stale = await auth(request(server).post(`/api/v1/templates/${id}/versions/${versionId}/restore`)).set('if-match', '1');
    expect(stale.status).toBe(412);

    const current = (await request(server).get(`/api/v1/templates/${id}`).set('Cookie', session.cookie)).body.draftRevision as number;
    const restored = await auth(request(server).post(`/api/v1/templates/${id}/versions/${versionId}/restore`)).set('if-match', String(current));
    expect(restored.status).toBe(200);
    expect(restored.body.subject).toBe('Original');
    expect(restored.body.html).toContain('Original body');
    expect(restored.body.draftRevision).toBe(current + 1);

    // The published version is untouched by a restore.
    const stillOne = await request(server).get(`/api/v1/templates/${id}/versions`).set('Cookie', session.cookie);
    expect(stillOne.body.items).toHaveLength(1);
    expect(stillOne.body.items[0].version).toBe(1);
  });

  it('refuses to restore a version belonging to another template', async () => {
    const session = await login(operatorA);
    const auth = (call: request.Test) => call.set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken);
    const server = app.getHttpServer();

    const mine = await auth(request(server).post('/api/v1/templates')).send({ name: `Mine ${randomUUID()}`, subject: 'Mine', html: '<p>Mine</p>' });
    const other = await auth(request(server).post('/api/v1/templates')).send({ name: `Other ${randomUUID()}`, subject: 'Other', html: '<p>Other</p>' });
    await auth(request(server).post(`/api/v1/templates/${other.body.id}/publish`));
    const otherVersionId = (await request(server).get(`/api/v1/templates/${other.body.id}/versions`).set('Cookie', session.cookie)).body.items[0].id as string;

    const crossed = await auth(request(server).post(`/api/v1/templates/${mine.body.id}/versions/${otherVersionId}/restore`)).set('if-match', '1');
    expect(crossed.status).toBe(404);
  });

  // BR-GEN-002: cross-tenant isolation for the version-history routes. Operator
  // B must not be able to read tenant A's version list, nor pull A's published
  // content into a template of their own. Both answer 404 rather than 403 --
  // the resource must not even be acknowledged to exist.
  it("hides another tenant's versions and refuses to restore across tenants", async () => {
    const sessionA = await login(operatorA);
    const sessionB = await login(operatorB);
    const authA = (call: request.Test) => call.set('Cookie', sessionA.cookie).set('x-csrf-token', sessionA.csrfToken);
    const authB = (call: request.Test) => call.set('Cookie', sessionB.cookie).set('x-csrf-token', sessionB.csrfToken);
    const server = app.getHttpServer();

    const ownedByA = await authA(request(server).post('/api/v1/templates'))
      .send({ name: `Tenant A history ${randomUUID()}`, subject: 'A subject', html: '<p>A body</p>' });
    expect(ownedByA.status).toBe(201);
    const templateA = ownedByA.body.id as string;
    expect((await authA(request(server).post(`/api/v1/templates/${templateA}/publish`))).status).toBe(201);
    const versionsA = await request(server).get(`/api/v1/templates/${templateA}/versions`).set('Cookie', sessionA.cookie);
    const versionAId = versionsA.body.items[0].id as string;

    const peeked = await request(server).get(`/api/v1/templates/${templateA}/versions`).set('Cookie', sessionB.cookie);
    expect(peeked.status).toBe(404);

    const ownedByB = await authB(request(server).post('/api/v1/templates'))
      .send({ name: `Tenant B target ${randomUUID()}`, subject: 'B subject', html: '<p>B body</p>' });
    const templateB = ownedByB.body.id as string;

    const stolen = await authB(request(server).post(`/api/v1/templates/${templateB}/versions/${versionAId}/restore`)).set('if-match', '1');
    expect(stolen.status).toBe(404);

    const untouched = await request(server).get(`/api/v1/templates/${templateB}`).set('Cookie', sessionB.cookie);
    expect(untouched.body.subject).toBe('B subject');
    expect(untouched.body.draftRevision).toBe(1);
  });
});
