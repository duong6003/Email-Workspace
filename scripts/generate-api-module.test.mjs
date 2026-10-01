import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('generates the canonical post-restructure tenant module shape', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'eow-module-generator-'));
  try {
    const script = resolve('scripts/generate-api-module.mjs');
    const result = spawnSync(process.execPath, [script, 'delivery-policy', 'DeliveryPolicyEntity', 'delivery-policy'], { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const root = join(cwd, 'apps/api/src/delivery-policy');
    for (const file of ['delivery-policy.module.ts', 'delivery-policy.controller.ts', 'delivery-policy.service.ts', 'delivery-policy.repository.ts', 'dto/delivery-policy.dto.ts', 'delivery-policy.test.ts']) {
      assert.ok(readFileSync(join(root, file), 'utf8').length > 0, file);
    }
    assert.match(readFileSync(join(root, 'delivery-policy.repository.ts'), 'utf8'), /extends TenantScopedRepository/);
    assert.match(readFileSync(join(root, 'delivery-policy.service.ts'), 'utf8'), /runInTenantContext/);
    assert.match(readFileSync(join(cwd, 'apps/api/test/integration/delivery-policy.test.ts'), 'utf8'), /tenant boundary/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
