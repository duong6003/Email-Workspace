import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const distMain = resolve(here, '../../dist/main.js');

/**
 * Real process-level proof of "boot fails fast on a missing required env
 * var" (EXECPLAN §9 M1-S3 step 3) — env.test.ts unit-tests validateEnv() in
 * isolation, which proves the *function* is correct but not that the real
 * process actually calls it before doing anything else. This spawns the
 * compiled server (matching main.ts's ConfigModule.forRoot({ validate })
 * wiring in app.module.ts) with DATABASE_URL missing and asserts the
 * process itself exits non-zero, naming the missing variable, before it
 * ever attempts to bind a port or reach Postgres/Redis.
 *
 * Uses the tsc-compiled dist/main.js rather than `tsx src/main.ts`,
 * matching the D-22 workaround already established by M1-S1/M1-S2 for
 * anything that needs Nest's real decorator-metadata-driven DI to behave
 * correctly under this toolchain (tsx/esbuild silently drops
 * emitDecoratorMetadata for constructor injection; the compiled dist/
 * output used by the real Docker deployment does not have that gap).
 */
function runCompiledServer(env: NodeJS.ProcessEnv): Promise<{ code: number | null; output: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [distMain], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));

    // Spawning and booting a compiled Node process competes with the rest of
    // the workspace suite for CPU (see vitest.shared.ts) — 10s was tight enough
    // to fail intermittently under a parallel `pnpm -r test`.
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Process did not exit within the timeout. Output so far:\n${output}`));
    }, 30_000);

    child.on('exit', (code) => {
      clearTimeout(timeout);
      resolvePromise({ code, output });
    });
  });
}

describe('API process boot (real spawned process, no mocks)', () => {
  it('exits non-zero and names DATABASE_URL when it is missing from the environment', async () => {
    const { code, output } = await runCompiledServer({
      PATH: process.env.PATH,
      REDIS_URL: 'redis://localhost:56379/0',
      SESSION_SECRET: 'a'.repeat(64),
      // DATABASE_URL deliberately absent.
    });

    expect(code).not.toBe(0);
    expect(output).toMatch(/DATABASE_URL/);
  }, 45_000);

  it('exits non-zero and names SESSION_SECRET when it is too short', async () => {
    const { code, output } = await runCompiledServer({
      PATH: process.env.PATH,
      DATABASE_URL: 'postgresql://eow:secret@127.0.0.1:55432/eow',
      REDIS_URL: 'redis://localhost:56379/0',
      SESSION_SECRET: 'too-short',
    });

    expect(code).not.toBe(0);
    expect(output).toMatch(/SESSION_SECRET/);
  }, 45_000);
});
