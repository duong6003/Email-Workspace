import { SchematicTestRunner } from '@angular-devkit/schematics/testing';
import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';

describe('tenant-module schematic', () => {
  it('generates the canonical post-F tenant module shape', async () => {
    const runner = new SchematicTestRunner('@eow/api-schematics', resolve('collection.json'));
    const tree = await runner.runSchematic('tenant-module', {
      name: 'delivery-policy', entity: 'DeliveryPolicyEntity', entityPath: 'delivery-policy', path: 'apps/api/src',
    });
    expect(tree.files).toEqual(expect.arrayContaining([
      '/apps/api/src/delivery-policy/delivery-policy.module.ts',
      '/apps/api/src/delivery-policy/delivery-policy.controller.ts',
      '/apps/api/src/delivery-policy/delivery-policy.service.ts',
      '/apps/api/src/delivery-policy/delivery-policy.repository.ts',
      '/apps/api/src/delivery-policy/dto/delivery-policy.dto.ts',
      '/apps/api/src/delivery-policy/delivery-policy.test.ts',
      '/apps/api/test/integration/delivery-policy.test.ts',
    ]));
    expect(tree.readContent('/apps/api/src/delivery-policy/delivery-policy.repository.ts')).toContain('extends TenantScopedRepository');
    expect(tree.readContent('/apps/api/src/delivery-policy/delivery-policy.service.ts')).toContain('runInTenantContext');
  });
});
