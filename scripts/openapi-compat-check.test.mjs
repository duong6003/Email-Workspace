// M1-GATE (BR-SEC-008): proves the CI gate wired in .github/workflows/ci.yml
// actually blocks a breaking OpenAPI change, not just that it *would* in
// theory. Run with: node --test scripts/openapi-compat-check.test.mjs
//
// This test only exercises the "backward compatibility" half of BR-SEC-008's
// acceptance text ("Breaking change tạo version mới; OpenAPI và error schema
// được publish cùng release"). It deliberately does NOT claim to prove the
// "creates a new version" half -- no versioning mechanism exists in this
// codebase yet (no /v2 route prefix, no version negotiation). See
// EXECPLAN.md Decision Log for the M1-GATE decision this evidence supports.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, 'openapi-compat-check.mjs');

const BASE_SPEC = `
openapi: 3.0.3
info:
  title: fixture
  version: '1'
paths:
  /widgets:
    get:
      operationId: listWidgets
      responses:
        '200':
          description: ok
        '401':
          description: unauthorized
components:
  schemas:
    Problem:
      type: object
      required: [title, status]
      properties:
        title:
          type: string
        status:
          type: integer
`;

const BREAKING_SPEC = `
openapi: 3.0.3
info:
  title: fixture
  version: '1'
paths:
  /widgets:
    get:
      operationId: listWidgets
      responses:
        '200':
          description: ok
components:
  schemas:
    Problem:
      type: object
      required: [title]
      properties:
        title:
          type: string
        status:
          type: integer
`;

const ADDITIVE_SPEC = `
openapi: 3.0.3
info:
  title: fixture
  version: '1'
paths:
  /widgets:
    get:
      operationId: listWidgets
      responses:
        '200':
          description: ok
        '401':
          description: unauthorized
        '403':
          description: forbidden
  /widgets/{id}:
    get:
      operationId: getWidget
      responses:
        '200':
          description: ok
components:
  schemas:
    Problem:
      type: object
      required: [title, status]
      properties:
        title:
          type: string
        status:
          type: integer
        traceId:
          type: string
`;

test('openapi-compat-check blocks a deliberate breaking change (401 response removed, Problem.status no longer required)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'openapi-compat-'));
  try {
    const oldPath = join(dir, 'old.yaml');
    const newPath = join(dir, 'new.yaml');
    writeFileSync(oldPath, BASE_SPEC);
    writeFileSync(newPath, BREAKING_SPEC);

    await assert.rejects(
      execFileAsync('node', [SCRIPT, oldPath, newPath]),
      (err) => {
        assert.equal(err.code, 1, 'the CI gate must exit non-zero on a breaking change');
        assert.match(err.stderr, /response removed: GET \/widgets -> 401/);
        assert.match(err.stderr, /required property removed: Problem\.status/);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('openapi-compat-check passes a genuinely additive change', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'openapi-compat-'));
  try {
    const oldPath = join(dir, 'old.yaml');
    const newPath = join(dir, 'new.yaml');
    writeFileSync(oldPath, BASE_SPEC);
    writeFileSync(newPath, ADDITIVE_SPEC);

    const { stdout } = await execFileAsync('node', [SCRIPT, oldPath, newPath]);
    assert.match(stdout, /No breaking OpenAPI changes detected\./);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('openapi-compat-check treats a missing previous spec (e.g. the very first PR) as compatible', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'openapi-compat-'));
  try {
    const newPath = join(dir, 'new.yaml');
    writeFileSync(newPath, BASE_SPEC);
    const missingOldPath = join(dir, 'does-not-exist.yaml');

    const { stdout } = await execFileAsync('node', [SCRIPT, missingOldPath, newPath]);
    assert.match(stdout, /nothing to compare, treating as compatible/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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

// --- no-argument mode -------------------------------------------------------
//
// `pnpm contracts:compat-check` passes no arguments: the check has to find its
// own baseline (HEAD:contracts/openapi.yaml) and compare it against the working
// tree. These tests build a throwaway git repo per case so they assert on a real
// `git show`, not on a stub -- the previous failure mode was that the script
// exited 2 on the usage line and the gate never actually ran.

const GIT_FIXTURE = ['-c', 'user.email=fixture@example.test', '-c', 'user.name=fixture', '-c', 'commit.gpgsign=false'];

async function makeSpecRepo({ committed, workingTree }) {
  const dir = mkdtempSync(join(tmpdir(), 'openapi-compat-repo-'));
  mkdirSync(join(dir, 'contracts'));
  await execFileAsync('git', ['init', '--quiet'], { cwd: dir });
  if (committed !== undefined) {
    writeFileSync(join(dir, 'contracts', 'openapi.yaml'), committed);
  }
  writeFileSync(join(dir, 'README.md'), 'fixture\n');
  await execFileAsync('git', [...GIT_FIXTURE, 'add', '-A'], { cwd: dir });
  await execFileAsync('git', [...GIT_FIXTURE, 'commit', '--quiet', '-m', 'fixture baseline'], { cwd: dir });
  if (workingTree !== undefined) {
    writeFileSync(join(dir, 'contracts', 'openapi.yaml'), workingTree);
  }
  return dir;
}

test('openapi-compat-check with no arguments blocks a breaking working-tree edit against HEAD', async () => {
  const dir = await makeSpecRepo({ committed: BASE_SPEC, workingTree: BREAKING_SPEC });
  try {
    await assert.rejects(
      execFileAsync('node', [SCRIPT], { cwd: dir }),
      (err) => {
        assert.equal(err.code, 1, 'the no-argument invocation must exit non-zero on a breaking change');
        assert.match(err.stderr, /response removed: GET \/widgets -> 401/);
        assert.match(err.stderr, /required property removed: Problem\.status/);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('openapi-compat-check with no arguments passes an additive working-tree edit', async () => {
  const dir = await makeSpecRepo({ committed: BASE_SPEC, workingTree: ADDITIVE_SPEC });
  try {
    const { stdout } = await execFileAsync('node', [SCRIPT], { cwd: dir });
    assert.match(stdout, /No breaking OpenAPI changes detected\./);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('openapi-compat-check with no arguments resolves the repo root when run from a subdirectory', async () => {
  const dir = await makeSpecRepo({ committed: BASE_SPEC, workingTree: BREAKING_SPEC });
  try {
    const subdir = join(dir, 'contracts');
    await assert.rejects(
      execFileAsync('node', [SCRIPT], { cwd: subdir }),
      (err) => {
        assert.equal(err.code, 1, 'cwd must not decide which spec is compared');
        assert.match(err.stderr, /response removed: GET \/widgets -> 401/);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('openapi-compat-check with no arguments treats a spec that is not committed yet as compatible', async () => {
  const dir = await makeSpecRepo({ workingTree: BASE_SPEC });
  try {
    const { stdout } = await execFileAsync('node', [SCRIPT], { cwd: dir });
    assert.match(stdout, /nothing to compare, treating as compatible/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('openapi-compat-check still rejects a half-given argument pair', async () => {
  await assert.rejects(
    execFileAsync('node', [SCRIPT, 'only-one.yaml']),
    (err) => {
      assert.equal(err.code, 2);
      assert.match(err.stderr, /usage: openapi-compat-check\.mjs \[<old\.yaml> <new\.yaml>\]/);
      return true;
    },
  );
});
