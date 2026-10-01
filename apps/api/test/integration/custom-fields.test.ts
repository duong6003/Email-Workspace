import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HttpException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { createDataSource } from '../../src/database/data-source.js';
import { TenantEntity } from '../../src/database/entities/tenant.entity.js';
import { RecipientEntity } from '../../src/database/entities/recipient.entity.js';
import { CustomFieldDefinitionEntity } from '../../src/database/entities/custom-field-definition.entity.js';
import { CustomFieldsService } from '../../src/custom-fields/custom-fields.service.js';
import { RecipientsService, type ActorContext } from '../../src/recipients/recipients.service.js';
import { AuditLogEntity } from '../../src/database/entities/audit-log.entity.js';
import { testDatabaseUrl } from './test-database-url.js';

const testActor: ActorContext = { actorId: null, traceId: 'test-trace' };

describe('Custom fields (BR-CF-001/002/003/009)', () => {
  let dataSource: DataSource;
  let tenantA: TenantEntity;
  let tenantB: TenantEntity;

  beforeAll(async () => {
    dataSource = createDataSource(testDatabaseUrl());
    await dataSource.initialize();
    const tenants = dataSource.getRepository(TenantEntity);
    tenantA = await tenants.save({ name: `cf-test-tenant-a-${randomUUID()}` });
    tenantB = await tenants.save({ name: `cf-test-tenant-b-${randomUUID()}` });
  });

  afterAll(async () => {
    await dataSource.getRepository(RecipientEntity).delete({ tenantId: tenantA.id });
    await dataSource.getRepository(RecipientEntity).delete({ tenantId: tenantB.id });
    // audit_log is immutable by design (BR-SEC-002, 005_audit_log_immutability.sql's
    // trigger rejects UPDATE/DELETE) -- rows written by this test's tenants are
    // deliberately left in place, not cleaned up.
    await dataSource.getRepository(CustomFieldDefinitionEntity).delete({ tenantId: tenantA.id });
    await dataSource.getRepository(CustomFieldDefinitionEntity).delete({ tenantId: tenantB.id });
    // tenant rows are deliberately NOT deleted: this test suite's own
    // BR-CF-009 audit_log rows (immutable, FK'd to tenant) now make the
    // tenant row itself un-deletable too -- a real, previously-latent
    // consequence of 005_audit_log_immutability.sql's trigger that only
    // surfaces once a test both writes audit rows AND tries to clean up
    // its own tenant fixture in the same run (recipients.test.ts never
    // wrote audit rows, so it never hit this). Two harmless orphaned test
    // tenant rows per run in the local dev database is an acceptable
    // trade-off, consistent with this run's disclosed-not-hidden evidence
    // discipline (see EXECPLAN Surprises).
    await dataSource.destroy();
  });

  function customFieldsFor() {
    return new CustomFieldsService(dataSource);
  }

  function recipientsFor() {
    return new RecipientsService(dataSource, customFieldsFor());
  }

  async function expectHttpStatus(promise: Promise<unknown>, status: number): Promise<HttpException> {
    try {
      await promise;
    } catch (error) {
      expect((error as HttpException).getStatus()).toBe(status);
      return error as HttpException;
    }
    throw new Error(`Expected a rejection with status ${status}, but the promise resolved.`);
  }

  it('BR-CF-001: creates a typed custom field and lists it back for the tenant', async () => {
    const service = customFieldsFor();
    const created = await service.create(tenantA.id, { key: `plan_${randomUUID().slice(0, 8)}`, label: 'Plan', type: 'text', required: false, sensitive: false });
    expect(created.fieldKey).toMatch(/^plan_/);

    const list = await service.list(tenantA.id);
    expect(list.some((field) => field.id === created.id)).toBe(true);
  });

  it('BR-CF-001: rejects a duplicate key within the same tenant with 409', async () => {
    const service = customFieldsFor();
    const key = `dup_key_${randomUUID().slice(0, 8)}`;
    await service.create(tenantA.id, { key, label: 'First', type: 'text', required: false, sensitive: false });
    await expectHttpStatus(service.create(tenantA.id, { key, label: 'Second', type: 'text', required: false, sensitive: false }), 409);
  });

  it('BR-CF-001: the same key is allowed across different tenants', async () => {
    const key = `cross_tenant_${randomUUID().slice(0, 8)}`;
    const service = customFieldsFor();
    const inA = await service.create(tenantA.id, { key, label: 'A', type: 'text', required: false, sensitive: false });
    const inB = await service.create(tenantB.id, { key, label: 'B', type: 'text', required: false, sensitive: false });
    expect(inA.id).not.toBe(inB.id);
  });

  it('BR-GEN-002: a tenant cannot read or list another tenant\'s custom fields', async () => {
    const service = customFieldsFor();
    const victim = await service.create(tenantB.id, { key: `victim_${randomUUID().slice(0, 8)}`, label: 'Victim', type: 'text', required: false, sensitive: false });

    await expectHttpStatus(service.getOrThrow(tenantA.id, victim.id), 404);
    const listFromA = await service.list(tenantA.id);
    expect(listFromA.some((field) => field.id === victim.id)).toBe(false);
  });

  it('BR-CF-003: rejects a reserved system key with 422 and the reserved-key list in the response body', async () => {
    const service = customFieldsFor();
    const error = await expectHttpStatus(service.create(tenantA.id, { key: 'email', label: 'Email', type: 'text', required: false, sensitive: false }), 422);
    expect((error.getResponse() as { reservedKeys: string[] }).reservedKeys).toEqual(['email', 'first_name', 'last_name', 'unsubscribe_url']);
  });

  it('BR-CF-003: the database CHECK constraint independently rejects a reserved key (defence in depth)', async () => {
    await expect(
      dataSource.getRepository(CustomFieldDefinitionEntity).save({
        tenantId: tenantA.id,
        fieldKey: 'first_name',
        label: 'First name',
        dataType: 'text',
        required: false,
      } as Partial<CustomFieldDefinitionEntity>),
    ).rejects.toThrow();
  });

  it('BR-CF-001: key format is rejected at the database level too (defence in depth)', async () => {
    await expect(
      dataSource.getRepository(CustomFieldDefinitionEntity).save({
        tenantId: tenantA.id,
        fieldKey: 'Not Valid',
        label: 'Bad key',
        dataType: 'text',
        required: false,
      } as Partial<CustomFieldDefinitionEntity>),
    ).rejects.toThrow();
  });

  it('BR-CF-001: "đổi label không đổi key" -- update changes label but never the key', async () => {
    const service = customFieldsFor();
    const created = await service.create(tenantA.id, { key: `stable_${randomUUID().slice(0, 8)}`, label: 'Old label', type: 'text', required: false, sensitive: false });
    const updated = await service.update(tenantA.id, created.id, { label: 'New label' });
    expect(updated.label).toBe('New label');
    expect(updated.fieldKey).toBe(created.fieldKey);
  });

  it('BR-CF-002: recipient create rejects a custom_data value of the wrong declared type', async () => {
    const customFields = customFieldsFor();
    const field = await customFields.create(tenantA.id, { key: `age_${randomUUID().slice(0, 8)}`, label: 'Age', type: 'number', required: false, sensitive: false });

    await expectHttpStatus(
      recipientsFor().create(tenantA.id, { email: `typed-${randomUUID()}@acme.vn`, subscriptionStatus: 'active', customData: { [field.fieldKey]: 'not-a-number' } } as never, testActor),
      400,
    );
  });

  it('BR-CF-002: recipient create rejects an unknown custom_data key', async () => {
    await expectHttpStatus(
      recipientsFor().create(tenantA.id, { email: `unknown-${randomUUID()}@acme.vn`, subscriptionStatus: 'active', customData: { not_a_real_field: 'x' } } as never, testActor),
      400,
    );
  });

  it('BR-CF-002: recipient create stores a correctly typed custom_data value and round-trips it', async () => {
    const customFields = customFieldsFor();
    const field = await customFields.create(tenantA.id, { key: `score_${randomUUID().slice(0, 8)}`, label: 'Score', type: 'number', required: false, sensitive: false });

    const created = await recipientsFor().create(
      tenantA.id,
      { email: `score-${randomUUID()}@acme.vn`, subscriptionStatus: 'active', customData: { [field.fieldKey]: '42' } } as never,
      testActor,
    );
    expect(created.customData[field.fieldKey]).toBe(42);
  });

  it('BR-CF-003: recipient create rejects a customData key equal to a reserved system field name', async () => {
    await expectHttpStatus(
      recipientsFor().create(tenantA.id, { email: `reserved-${randomUUID()}@acme.vn`, subscriptionStatus: 'active', customData: { email: 'shadow@acme.vn' } } as never, testActor),
      400,
    );
  });

  it('BR-CF-009: a recipient custom_data change writes an audited field-level before/after row', async () => {
    const customFields = customFieldsFor();
    const field = await customFields.create(tenantA.id, { key: `city_${randomUUID().slice(0, 8)}`, label: 'City', type: 'text', required: false, sensitive: false });
    const recipients = recipientsFor();

    const created = await recipients.create(tenantA.id, { email: `city-${randomUUID()}@acme.vn`, subscriptionStatus: 'active', customData: { [field.fieldKey]: 'Hanoi' } } as never, testActor);
    await recipients.update(tenantA.id, created.id, { customData: { [field.fieldKey]: 'Saigon' } } as never, [], testActor);

    const rows = await dataSource.getRepository(AuditLogEntity).find({ where: { entityType: 'recipient', entityId: created.id, action: 'recipient.custom_data.updated' } });
    const row = rows.find((r) => (r.metadata as { fieldKey: string }).fieldKey === field.fieldKey && (r.metadata as { after: string }).after === 'Saigon');
    expect(row).toBeDefined();
    expect((row!.metadata as { before: string }).before).toBe('Hanoi');
  });

  it('BR-CF-009: a sensitive field\'s value is masked ("***") in the audit row', async () => {
    const customFields = customFieldsFor();
    const field = await customFields.create(tenantA.id, { key: `ssn_${randomUUID().slice(0, 8)}`, label: 'SSN', type: 'text', required: false, sensitive: true });
    const recipients = recipientsFor();

    const created = await recipients.create(
      tenantA.id,
      { email: `sensitive-${randomUUID()}@acme.vn`, subscriptionStatus: 'active', customData: { [field.fieldKey]: '123-45-6789' } } as never,
      testActor,
    );

    const rows = await dataSource.getRepository(AuditLogEntity).find({ where: { entityType: 'recipient', entityId: created.id, action: 'recipient.custom_data.updated' } });
    const row = rows.find((r) => (r.metadata as { fieldKey: string }).fieldKey === field.fieldKey);
    expect(row).toBeDefined();
    expect((row!.metadata as { after: string }).after).toBe('***');
  });

  it('BR-CF-002: a required field with a default_value is applied automatically when a create omits it', async () => {
    const customFields = customFieldsFor();
    const field = await customFields.create(tenantA.id, {
      key: `plan_default_${randomUUID().slice(0, 8)}`,
      label: 'Plan',
      type: 'text',
      required: true,
      defaultValue: 'free',
      sensitive: false,
    });

    const created = await recipientsFor().create(tenantA.id, { email: `default-${randomUUID()}@acme.vn`, subscriptionStatus: 'active' } as never, testActor);
    expect(created.customData[field.fieldKey]).toBe('free');
  });

  it('BR-CF-002: an enum field only accepts one of its declared options', async () => {
    const customFields = customFieldsFor();
    const field = await customFields.create(tenantA.id, {
      key: `tier_${randomUUID().slice(0, 8)}`,
      label: 'Tier',
      type: 'enum',
      required: false,
      enumOptions: ['bronze', 'silver', 'gold'],
      sensitive: false,
    });

    await expectHttpStatus(
      recipientsFor().create(tenantA.id, { email: `enum-bad-${randomUUID()}@acme.vn`, subscriptionStatus: 'active', customData: { [field.fieldKey]: 'platinum' } } as never, testActor),
      400,
    );

    const created = await recipientsFor().create(
      tenantA.id,
      { email: `enum-ok-${randomUUID()}@acme.vn`, subscriptionStatus: 'active', customData: { [field.fieldKey]: 'gold' } } as never,
      testActor,
    );
    expect(created.customData[field.fieldKey]).toBe('gold');
  });

  it('deletes a custom field definition (tenant-scoped, never cross-tenant)', async () => {
    const service = customFieldsFor();
    const created = await service.create(tenantA.id, { key: `deleteme_${randomUUID().slice(0, 8)}`, label: 'Delete me', type: 'text', required: false, sensitive: false });
    await service.remove(tenantA.id, created.id);
    await expectHttpStatus(service.getOrThrow(tenantA.id, created.id), 404);
  });
});
