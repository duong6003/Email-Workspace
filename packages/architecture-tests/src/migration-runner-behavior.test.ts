import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  COMPOSE_PROJECT_PREFIX,
  FIXTURE_CREATED_LABEL,
  FIXTURE_LABEL,
  type CommandResult,
  type CommandRunner,
  fixtureLabelArguments,
  releaseFixture,
  run,
  sweepTrackedFixtures,
  trackFixture,
  trackedFixtureCount,
} from './docker-fixtures.js';
import { REPO_ROOT } from './repo.js';

const RUNNER_SOURCE = resolve(REPO_ROOT, 'database/migrate.sh');
const REPOSITORY_MIGRATIONS_DIR = resolve(REPO_ROOT, 'database/migrations');
const FIXTURES_DIR = resolve(REPO_ROOT, 'packages/architecture-tests/fixtures/migration-runner');
const MIGRATION_022 = '022_campaign_snapshot.sql';
const MIGRATION_023 = '023_campaign_snapshot_hardening.sql';
const EXPECTED_COMPOSITE_FK_TOPOLOGY = {
  campaign_recipient_tenant_campaign_fkey: {
    sourceColumns: ['tenant_id', 'campaign_id'],
    sourceRelation: 'campaign_recipient',
    targetColumns: ['tenant_id', 'id'],
    targetRelation: 'campaign',
    type: 'f',
    validated: true,
  },
  campaign_recipient_tenant_campaign_snapshot_fkey: {
    sourceColumns: ['tenant_id', 'campaign_id', 'snapshot_id'],
    sourceRelation: 'campaign_recipient',
    targetColumns: ['tenant_id', 'campaign_id', 'id'],
    targetRelation: 'campaign_snapshot',
    type: 'f',
    validated: true,
  },
  campaign_recipient_tenant_recipient_fkey: {
    sourceColumns: ['tenant_id', 'recipient_id'],
    sourceRelation: 'campaign_recipient',
    targetColumns: ['tenant_id', 'id'],
    targetRelation: 'recipient',
    type: 'f',
    validated: true,
  },
  campaign_snapshot_tenant_campaign_fkey: {
    sourceColumns: ['tenant_id', 'campaign_id'],
    sourceRelation: 'campaign_snapshot',
    targetColumns: ['tenant_id', 'id'],
    targetRelation: 'campaign',
    type: 'f',
    validated: true,
  },
  campaign_snapshot_tenant_frozen_by_fkey: {
    sourceColumns: ['tenant_id', 'frozen_by'],
    sourceRelation: 'campaign_snapshot',
    targetColumns: ['tenant_id', 'id'],
    targetRelation: 'app_user',
    type: 'f',
    validated: true,
  },
  campaign_snapshot_tenant_template_version_fkey: {
    sourceColumns: ['tenant_id', 'template_version_id'],
    sourceRelation: 'campaign_snapshot',
    targetColumns: ['tenant_id', 'id'],
    targetRelation: 'email_template_version',
    type: 'f',
    validated: true,
  },
} as const;

interface PostgresHarness {
  appPassword: string;
  container: string;
  databasePassword: string;
  network: string;
}

interface ComposeHarness {
  command: string;
  commandPrefix: string[];
  environmentFile: string;
  overrideFile: string;
  project: string;
}

const COMPOSITE_FK_TOPOLOGY_SQL = `
  SELECT COALESCE(jsonb_object_agg(
    constraints.conname,
    jsonb_build_object(
      'sourceColumns', constraints.source_columns,
      'sourceRelation', constraints.source_relation,
      'targetColumns', constraints.target_columns,
      'targetRelation', constraints.target_relation,
      'type', constraints.contype,
      'validated', constraints.convalidated
    ) ORDER BY constraints.conname
  ), '{}'::jsonb)::text
  FROM (
    SELECT
      c.conname,
      c.contype,
      c.conrelid::regclass::text AS source_relation,
      c.confrelid::regclass::text AS target_relation,
      c.convalidated,
      ARRAY(
        SELECT a.attname
        FROM unnest(c.conkey) WITH ORDINALITY AS source_key(attnum, position)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = source_key.attnum
        ORDER BY source_key.position
      ) AS source_columns,
      ARRAY(
        SELECT a.attname
        FROM unnest(c.confkey) WITH ORDINALITY AS target_key(attnum, position)
        JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = target_key.attnum
        ORDER BY target_key.position
      ) AS target_columns
    FROM pg_constraint c
    WHERE c.conname = ANY (ARRAY[
      'campaign_snapshot_tenant_campaign_fkey',
      'campaign_snapshot_tenant_template_version_fkey',
      'campaign_snapshot_tenant_frozen_by_fkey',
      'campaign_recipient_tenant_campaign_fkey',
      'campaign_recipient_tenant_recipient_fkey',
      'campaign_recipient_tenant_campaign_snapshot_fkey'
    ])
  ) constraints
`;

function expectExactCompositeForeignKeys(value: string): void {
  expect(JSON.parse(value)).toEqual(EXPECTED_COMPOSITE_FK_TOPOLOGY);
}

describe('migration behavior harness cleanup', () => {
  it('cleans Docker resources when PostgreSQL readiness fails', async () => {
    const command = vi.fn(async (_command: string, args: string[]): Promise<CommandResult> => {
      if (args[0] === 'network' && args[1] === 'create') return { exitCode: 0, stdout: '', stderr: '' };
      if (args[0] === 'run') return { exitCode: 0, stdout: 'container-id', stderr: '' };
      if (args[0] === 'exec') return { exitCode: 1, stdout: '', stderr: 'not ready' };
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await expect(startPostgres(command, 1, 0)).rejects.toThrow('temporary PostgreSQL container did not become queryable');
    expect(command.mock.calls.some(([, args]) => args[0] === 'rm' && args[1] === '-f')).toBe(true);
    expect(command.mock.calls.some(([, args]) => args[0] === 'network' && args[1] === 'rm')).toBe(true);
  });

  it('preserves startup and network-cleanup failures', async () => {
    const command = vi.fn(async (_command: string, args: string[]): Promise<CommandResult> => {
      if (args[0] === 'network' && args[1] === 'create') return { exitCode: 0, stdout: '', stderr: '' };
      if (args[0] === 'run') return { exitCode: 1, stdout: '', stderr: 'container startup failed' };
      return { exitCode: 1, stdout: '', stderr: 'network removal failed' };
    });

    await expect(startPostgres(command)).rejects.toThrow(
      /temporary PostgreSQL container startup failed:[\s\S]*container startup failed[\s\S]*network removal failed/,
    );
    expect(command.mock.calls.some(([, args]) => args[0] === 'network' && args[1] === 'rm')).toBe(true);
  });

  it('preserves readiness and cleanup failures while attempting all cleanup actions', async () => {
    const command = vi.fn(async (_command: string, args: string[]): Promise<CommandResult> => {
      if (args[0] === 'network' && args[1] === 'create') return { exitCode: 0, stdout: '', stderr: '' };
      if (args[0] === 'run') return { exitCode: 0, stdout: 'container-id', stderr: '' };
      if (args[0] === 'exec') return { exitCode: 1, stdout: '', stderr: 'not ready' };
      return {
        exitCode: 1,
        stdout: '',
        stderr: args[0] === 'rm' ? 'container removal failed' : 'network removal failed',
      };
    });

    await expect(startPostgres(command, 1, 0)).rejects.toThrow(
      /temporary PostgreSQL container did not become queryable[\s\S]*container removal failed[\s\S]*network removal failed/,
    );
    expect(command.mock.calls.filter(([, args]) => (
      (args[0] === 'rm' && args[1] === '-f') || (args[0] === 'network' && args[1] === 'rm')
    ))).toHaveLength(2);
  });

  it('reports Compose down failure after removing harness files', async () => {
    const directory = join('temporary-compose', 'cleanup-test');
    const harness: ComposeHarness = {
      command: 'docker',
      commandPrefix: ['compose'],
      environmentFile: join(directory, 'compose.env'),
      overrideFile: join(directory, 'compose.override.yaml'),
      project: 'temporary-compose-project',
    };
    const command = vi.fn(async (): Promise<CommandResult> => ({
      exitCode: 1,
      stdout: '',
      stderr: 'compose down failed',
    }));
    const removeDirectory = vi.fn();

    await expect(stopCompose(harness, command, removeDirectory)).rejects.toThrow('compose down failed');
    expect(removeDirectory).toHaveBeenCalledWith(resolve(directory));
  });

  it('removes Compose harness files when down rejects', async () => {
    const directory = join('temporary-compose', 'cleanup-rejection-test');
    const harness: ComposeHarness = {
      command: 'docker',
      commandPrefix: ['compose'],
      environmentFile: join(directory, 'compose.env'),
      overrideFile: join(directory, 'compose.override.yaml'),
      project: 'temporary-compose-project',
    };
    const command = vi.fn(async (): Promise<CommandResult> => {
      throw new Error('compose down command rejected');
    });
    const removeDirectory = vi.fn(() => { throw new Error('harness removal failed'); });

    await expect(stopCompose(harness, command, removeDirectory)).rejects.toThrow(
      /compose down command rejected[\s\S]*harness removal failed/,
    );
    expect(removeDirectory).toHaveBeenCalledWith(resolve(directory));
  });

  it('attempts all PostgreSQL cleanup actions and reports nonzero results', async () => {
    const harness: PostgresHarness = {
      appPassword: 'app-password',
      container: 'temporary-postgres',
      databasePassword: 'database-password',
      network: 'temporary-network',
    };
    const command = vi.fn(async (_command: string, args: string[]): Promise<CommandResult> => ({
      exitCode: 1,
      stdout: '',
      stderr: args[0] === 'rm' ? 'container removal failed' : 'network removal failed',
    }));

    await expect(stopPostgres(harness, command)).rejects.toThrow(/container removal failed[\s\S]*network removal failed/);
    expect(command.mock.calls.map(([, args]) => args.slice(0, 2))).toEqual([
      ['rm', '-f'],
      ['network', 'rm'],
    ]);
  });

  it('attempts PostgreSQL network cleanup when container cleanup rejects', async () => {
    const harness: PostgresHarness = {
      appPassword: 'app-password',
      container: 'temporary-postgres',
      databasePassword: 'database-password',
      network: 'temporary-network',
    };
    const command = vi.fn(async (_command: string, args: string[]): Promise<CommandResult> => {
      if (args[0] === 'rm') throw new Error('container removal command rejected');
      return { exitCode: 1, stdout: '', stderr: 'network removal failed' };
    });

    await expect(stopPostgres(harness, command)).rejects.toThrow(
      /container removal command rejected[\s\S]*network removal failed/,
    );
    expect(command.mock.calls.map(([, args]) => args.slice(0, 2))).toEqual([
      ['rm', '-f'],
      ['network', 'rm'],
    ]);
  });

  it('preserves primary failure while attempting Docker and fixture cleanup independently', async () => {
    const command = vi.fn(async (_command: string, args: string[]): Promise<CommandResult> => {
      if (args[0] === 'network' && args[1] === 'create') return { exitCode: 0, stdout: '', stderr: '' };
      if (args[0] === 'run' || args[0] === 'exec') return { exitCode: 0, stdout: '', stderr: '' };
      return {
        exitCode: 1,
        stdout: '',
        stderr: args[0] === 'rm' ? 'container removal failed' : 'network removal failed',
      };
    });
    const removeDirectory = vi.fn(() => { throw new Error('fixture removal failed'); });

    await expect(withPostgresFixture(
      () => 'temporary-migrations',
      async () => { throw new Error('test body failed'); },
      command,
      removeDirectory,
    )).rejects.toThrow(
      /test body failed[\s\S]*container removal failed[\s\S]*network removal failed[\s\S]*fixture removal failed/,
    );
    expect(removeDirectory).toHaveBeenCalledWith('temporary-migrations');
    expect(command.mock.calls.filter(([, args]) => (
      (args[0] === 'rm' && args[1] === '-f') || (args[0] === 'network' && args[1] === 'rm')
    ))).toHaveLength(2);
  });

  it('preserves primary failure while attempting Compose and fixture cleanup independently', async () => {
    const harness: ComposeHarness = {
      command: 'docker',
      commandPrefix: ['compose'],
      environmentFile: join('temporary-compose', 'compose.env'),
      overrideFile: join('temporary-compose', 'compose.override.yaml'),
      project: 'temporary-compose-project',
    };
    const command = vi.fn(async (): Promise<CommandResult> => ({
      exitCode: 1,
      stdout: '',
      stderr: 'compose down failed',
    }));
    const removeDirectory = vi.fn((path: string) => {
      if (path === 'temporary-migrations') throw new Error('fixture removal failed');
    });

    await expect(withComposeFixture(
      () => 'temporary-migrations',
      () => harness,
      async () => { throw new Error('test body failed'); },
      command,
      removeDirectory,
    )).rejects.toThrow(
      /test body failed[\s\S]*compose down failed[\s\S]*fixture removal failed/,
    );
    expect(removeDirectory).toHaveBeenCalledWith('temporary-migrations');
    expect(command).toHaveBeenCalledTimes(1);
  });

  /**
   * postgres:17-alpine declares VOLUME /var/lib/postgresql/data, so every
   * fixture container owns an anonymous volume that `docker rm -f` leaves
   * behind. Twenty-two of them per run, on the success path, is what put 1039
   * dangling volumes worth 49 GB on a developer machine while every run of this
   * suite still reported itself green.
   */
  it('removes a PostgreSQL container together with its anonymous volumes', async () => {
    const harness: PostgresHarness = {
      appPassword: 'app-password',
      container: 'temporary-postgres',
      databasePassword: 'database-password',
      network: 'temporary-network',
    };
    const command = vi.fn(async (): Promise<CommandResult> => ({ exitCode: 0, stdout: '', stderr: '' }));

    await stopPostgres(harness, command);

    expect(command).toHaveBeenCalledWith('docker', ['rm', '-f', '-v', 'temporary-postgres']);
  });

  it('labels the container and network so a sweep can find them without guessing names', async () => {
    const command = vi.fn(async (_command: string, args: string[]): Promise<CommandResult> => (
      { exitCode: args[0] === 'exec' ? 1 : 0, stdout: '', stderr: 'not ready' }
    ));

    await expect(startPostgres(command, 1, 0)).rejects.toThrow('did not become queryable');

    const created = command.mock.calls
      .map(([, args]) => args)
      .filter((args) => args[0] === 'run' || (args[0] === 'network' && args[1] === 'create'));
    expect(created).toHaveLength(2);
    for (const args of created) {
      expect(args, `unlabelled fixture object: docker ${args.join(' ')}`).toContain(`${FIXTURE_LABEL}=1`);
      expect(args.some((argument) => argument.startsWith(`${FIXTURE_CREATED_LABEL}=`))).toBe(true);
    }
  });

  /**
   * Vitest kills a timed-out test rather than unwinding it, so the teardown
   * written after the fixture body never runs. The registry is what closes that
   * gap: afterEach still fires after the kill, and removes what the abandoned
   * body was still holding.
   */
  it('leaves a started container registered for the after-test sweep', async () => {
    const command = vi.fn(async (): Promise<CommandResult> => ({ exitCode: 0, stdout: '', stderr: '' }));

    const harness = await startPostgres(command, 1, 0);
    expect(trackedFixtureCount()).toBe(1);

    expect(await sweepTrackedFixtures()).toEqual([`PostgreSQL fixture ${harness.container}`]);
    expect(command).toHaveBeenCalledWith('docker', ['rm', '-f', '-v', harness.container]);
    expect(trackedFixtureCount()).toBe(0);
  });

  it('registers nothing once a fixture has torn itself down', async () => {
    const command = vi.fn(async (): Promise<CommandResult> => ({ exitCode: 0, stdout: '', stderr: '' }));

    await withPostgresFixture(() => 'temporary-migrations', async () => undefined, command, vi.fn());

    expect(trackedFixtureCount()).toBe(0);
  });
});

beforeAll(async () => {
  let docker: CommandResult;
  try {
    docker = await run('docker', ['version', '--format', '{{.Server.Version}}']);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Docker daemon is required for migration runner behavior tests: ${detail}`);
  }
  if (docker.exitCode !== 0) {
    const detail = docker.stderr.trim() || docker.stdout.trim() || `docker exited with status ${String(docker.exitCode)}`;
    throw new Error(`Docker daemon is required for migration runner behavior tests: ${detail}`);
  }
}, 30_000);

/**
 * The teardown that actually holds when a test is killed. Vitest abandons a
 * timed-out test body mid-await, so the cleanup written after the body never
 * runs -- but this hook still does. Without it, every timeout leaves a running
 * container and an orphaned data volume behind for good.
 */
afterEach(async () => {
  const swept = await sweepTrackedFixtures();
  if (swept.length > 0) {
    console.warn(`Swept ${String(swept.length)} abandoned migration fixture(s): ${swept.join('; ')}`);
  }
});

function fixtureDirectory(...names: string[]): string {
  const migrations = mkdtempSync(join(tmpdir(), 'eow-cp1-runner-'));
  for (const name of names) copyFileSync(join(FIXTURES_DIR, name), join(migrations, name));
  return migrations;
}

function repositoryMigrationDirectory(...names: string[]): string {
  const migrations = mkdtempSync(join(tmpdir(), 'eow-cp1-repository-migrations-'));
  for (const name of names) copyFileSync(join(REPOSITORY_MIGRATIONS_DIR, name), join(migrations, name));
  return migrations;
}

function addRepositoryMigration(migrations: string, name: string): void {
  copyFileSync(join(REPOSITORY_MIGRATIONS_DIR, name), join(migrations, name));
}

function repositoryMigrationNamesThrough(lastName: string): string[] {
  return readdirSync(REPOSITORY_MIGRATIONS_DIR)
    .filter((name) => /^\d{3}_.+\.sql$/.test(name) && name.localeCompare(lastName) <= 0)
    .sort();
}

function checksum(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function createComposeHarness(migrations: string): ComposeHarness {
  const suffix = randomUUID().replaceAll('-', '');
  const directory = mkdtempSync(join(tmpdir(), 'eow-cp1-compose-'));
  const environmentFile = join(directory, 'compose.env');
  const overrideFile = join(directory, 'compose.override.yaml');
  const postgresPassword = randomUUID();
  const appPassword = randomUUID();
  const redisPassword = randomUUID();
  const sessionSecret = `${randomUUID()}${randomUUID()}`;
  const senderCredentialKey = randomUUID().replaceAll('-', '').repeat(2);

  writeFileSync(environmentFile, [
    'EOW_POSTGRES_DB=eow',
    'EOW_POSTGRES_USER=eow',
    `EOW_POSTGRES_PASSWORD=${postgresPassword}`,
    `EOW_POSTGRES_APP_PASSWORD=${appPassword}`,
    `EOW_REDIS_PASSWORD=${redisPassword}`,
    `EOW_SESSION_SECRET=${sessionSecret}`,
    `EOW_SENDER_CREDENTIAL_KEY=${senderCredentialKey}`,
    'EOW_POSTGRES_BIND=127.0.0.1',
    'EOW_POSTGRES_PORT=0',
    'EOW_REDIS_BIND=127.0.0.1',
    'EOW_REDIS_PORT=0',
    'EOW_MAILPIT_BIND=127.0.0.1',
    'EOW_MAILPIT_PORT=0',
    'EOW_MAILPIT_SMTP_PORT=0',
    // Required by compose.yaml (api and worker alike) even though this
    // fixture only ever starts postgres and migrate: Compose interpolates
    // the whole file before it decides which services to run, so a missing
    // value fails the fixture, not the service that would have used it.
    'EOW_SMTP_HOST=mailpit',
    'EOW_SMTP_FROM=no-reply@example.test',
    // ADR-043 added minio, whose root password is required rather than
    // defaulted. Same reason as the two lines above: this fixture only starts
    // postgres and migrate, but Compose interpolates the entire file before it
    // picks services, so an unset value fails the fixture.
    'EOW_MINIO_ROOT_PASSWORD=fixture-minio-password',
  ].join('\n'));
  // The same labels the standalone fixture stamps, so one sweep covers both.
  // Compose's own objects carry com.docker.compose.project instead, which is
  // what the sweep follows from a labelled container to the project's volumes
  // and network -- `compose down` is not available to it, because compose.yaml
  // declares required variables whose env file dies with the run.
  const labels = [
    '    labels:',
    `      ${FIXTURE_LABEL}: '1'`,
    `      ${FIXTURE_CREATED_LABEL}: '${String(Date.now())}'`,
  ];
  writeFileSync(overrideFile, [
    'services:',
    '  postgres:',
    ...labels,
    '  migrate:',
    ...labels,
    '    volumes:',
    `      - ${migrations.replaceAll('\\', '/')}:/database/migrations:ro`,
    '',
  ].join('\n'));

  const composeV2 = process.env.EOW_COMPOSE_COMMAND !== 'docker-compose';
  return {
    command: 'env',
    commandPrefix: [
      'EOW_POSTGRES_DB=eow',
      'EOW_POSTGRES_USER=eow',
      `EOW_POSTGRES_PASSWORD=${postgresPassword}`,
      `EOW_POSTGRES_APP_PASSWORD=${appPassword}`,
      `EOW_REDIS_PASSWORD=${redisPassword}`,
      `EOW_SESSION_SECRET=${sessionSecret}`,
      `EOW_SENDER_CREDENTIAL_KEY=${senderCredentialKey}`,
      'EOW_POSTGRES_BIND=127.0.0.1',
      'EOW_POSTGRES_PORT=0',
      'EOW_REDIS_BIND=127.0.0.1',
      'EOW_REDIS_PORT=0',
      'EOW_MAILPIT_BIND=127.0.0.1',
      'EOW_MAILPIT_PORT=0',
      'EOW_MAILPIT_SMTP_PORT=0',
      'EOW_SMTP_HOST=mailpit',
      'EOW_SMTP_FROM=no-reply@example.test',
      'EOW_MINIO_ROOT_PASSWORD=fixture-minio-password',
      composeV2 ? 'docker' : 'docker-compose',
      ...(composeV2 ? ['compose'] : []),
    ],
    environmentFile,
    overrideFile,
    project: `${COMPOSE_PROJECT_PREFIX}${suffix}`,
  };
}

function composeArgs(harness: ComposeHarness, ...args: string[]): string[] {
  return [
    ...harness.commandPrefix, '--project-name', harness.project,
    '--env-file', harness.environmentFile,
    '-f', resolve(REPO_ROOT, 'compose.yaml'),
    '-f', harness.overrideFile,
    ...args,
  ];
}

function runCompose(harness: ComposeHarness, ...args: string[]): Promise<CommandResult> {
  return run(harness.command, composeArgs(harness, ...args));
}

async function stopCompose(
  harness: ComposeHarness,
  command: CommandRunner = run,
  removeDirectory: (path: string) => void = (path) => rmSync(path, { force: true, recursive: true }),
): Promise<void> {
  releaseFixture(harness);
  const failures: string[] = [];
  try {
    const stopped = await command(harness.command, composeArgs(harness, 'down', '--volumes', '--remove-orphans'));
    if (stopped.exitCode !== 0) failures.push(`Compose cleanup failed: ${stopped.stderr || stopped.stdout}`);
  } catch (error) {
    failures.push(`Compose cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    removeDirectory(resolve(harness.environmentFile, '..'));
  } catch (error) {
    failures.push(
      `Compose harness file cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (failures.length > 0) throw new Error(failures.join('\n'));
}

async function waitForDatabase(
  harness: PostgresHarness,
  command: CommandRunner = run,
  attempts = 50,
  delayMilliseconds = 200,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    // pg_isready can report ready while PostgreSQL is still refusing normal sessions.
    // Prove this harness can execute the same psql kind of connection the runner needs.
    const ready = await command('docker', [
      'exec', harness.container, 'psql', '-X', '-w', '-v', 'ON_ERROR_STOP=1', '-U', 'eow', '-d', 'eow', '-c', 'SELECT 1',
    ]);
    if (ready.exitCode === 0) return;
    if (delayMilliseconds > 0) await new Promise((resolveWait) => setTimeout(resolveWait, delayMilliseconds));
  }
  throw new Error('temporary PostgreSQL container did not become queryable');
}

async function startPostgres(
  command: CommandRunner = run,
  readinessAttempts = 50,
  readinessDelayMilliseconds = 200,
): Promise<PostgresHarness> {
  const suffix = randomUUID().replaceAll('-', '');
  const harness: PostgresHarness = {
    network: `eow_cp1_runner_${suffix}`,
    container: `eow_cp1_postgres_${suffix}`,
    databasePassword: randomUUID(),
    appPassword: randomUUID(),
  };
  // Both objects are labelled so a sweep can find them without pattern-matching
  // names, and dated so it can tell a live fixture from one a killed run left.
  const labels = fixtureLabelArguments();
  const createdNetwork = await command('docker', ['network', 'create', ...labels, harness.network]);
  if (createdNetwork.exitCode !== 0) throw new Error(`temporary Docker network creation failed:\n${createdNetwork.stderr || createdNetwork.stdout}`);

  const started = await command('docker', [
    'run', '-d', '--name', harness.container, '--network', harness.network, '--network-alias', 'postgres',
    ...labels,
    '-e', 'POSTGRES_DB=eow', '-e', 'POSTGRES_USER=eow', `-e`, `POSTGRES_PASSWORD=${harness.databasePassword}`,
    'postgres:17-alpine',
  ]);
  if (started.exitCode !== 0) {
    const startupMessage = `temporary PostgreSQL container startup failed:\n${started.stderr || started.stdout}`;
    const removedNetwork = await command('docker', ['network', 'rm', harness.network]);
    if (removedNetwork.exitCode !== 0) {
      throw new Error(
        `${startupMessage}\ntemporary Docker network cleanup failed:\n${removedNetwork.stderr || removedNetwork.stdout}`,
      );
    }
    throw new Error(startupMessage);
  }
  // From here the container exists, so its teardown must survive this function's
  // caller being killed. stopPostgres hands ownership back when it runs.
  trackFixture(harness, `PostgreSQL fixture ${harness.container}`, () => stopPostgres(harness, command));
  try {
    await waitForDatabase(harness, command, readinessAttempts, readinessDelayMilliseconds);
    return harness;
  } catch (error) {
    try {
      await stopPostgres(harness, command);
    } catch (cleanupError) {
      const primary = error instanceof Error ? error.message : String(error);
      const cleanup = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      throw new Error(`${primary}\n${cleanup}`, { cause: error });
    }
    throw error;
  }
}

async function stopPostgres(harness: PostgresHarness, command: CommandRunner = run): Promise<void> {
  releaseFixture(harness);
  const failures: string[] = [];
  try {
    // -v removes the container's anonymous volumes with it. postgres:17-alpine
    // declares VOLUME /var/lib/postgresql/data, so every fixture container that
    // was removed without -v orphaned a ~50 MB data volume -- on the success
    // path, not just on failure. That is where 1039 dangling volumes worth 49 GB
    // came from, with every run of this suite reporting itself green.
    const removedContainer = await command('docker', ['rm', '-f', '-v', harness.container]);
    if (removedContainer.exitCode !== 0) {
      failures.push(`container: ${removedContainer.stderr || removedContainer.stdout}`);
    }
  } catch (error) {
    failures.push(`container: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const removedNetwork = await command('docker', ['network', 'rm', harness.network]);
    if (removedNetwork.exitCode !== 0) {
      failures.push(`network: ${removedNetwork.stderr || removedNetwork.stdout}`);
    }
  } catch (error) {
    failures.push(`network: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (failures.length > 0) throw new Error(`temporary PostgreSQL cleanup failed:\n${failures.join('\n')}`);
}

async function withPostgresFixture<T>(
  createMigrations: () => string,
  useFixture: (harness: PostgresHarness, migrations: string) => Promise<T>,
  command: CommandRunner = run,
  removeDirectory: (path: string) => void = (path) => rmSync(path, { force: true, recursive: true }),
): Promise<T> {
  let migrations: string | undefined;
  let harness: PostgresHarness | undefined;
  let outcome: { ok: false; error: unknown } | { ok: true; value: T };

  try {
    migrations = createMigrations();
    harness = await startPostgres(command);
    outcome = { ok: true, value: await useFixture(harness, migrations) };
  } catch (error) {
    outcome = { ok: false, error };
  }

  const failures: string[] = [];
  if (harness !== undefined) {
    try {
      await stopPostgres(harness, command);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (migrations !== undefined) {
    try {
      removeDirectory(migrations);
    } catch (error) {
      failures.push(`migration fixture cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (!outcome.ok) {
    const primary = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
    throw new Error([primary, ...failures].join('\n'), { cause: outcome.error });
  }
  if (failures.length > 0) throw new Error(failures.join('\n'));
  return outcome.value;
}

async function withComposeFixture<T>(
  createMigrations: () => string,
  createHarness: (migrations: string) => ComposeHarness,
  useFixture: (harness: ComposeHarness, migrations: string) => Promise<T>,
  command: CommandRunner = run,
  removeDirectory: (path: string) => void = (path) => rmSync(path, { force: true, recursive: true }),
): Promise<T> {
  let migrations: string | undefined;
  let harness: ComposeHarness | undefined;
  let outcome: { ok: false; error: unknown } | { ok: true; value: T };

  try {
    migrations = createMigrations();
    const created = createHarness(migrations);
    harness = created;
    // Registered before the body runs: `compose up` inside it can be killed
    // halfway, and the project it half-created still has to be torn down.
    trackFixture(created, `Compose fixture ${created.project}`, () => stopCompose(created, command, removeDirectory));
    outcome = { ok: true, value: await useFixture(created, migrations) };
  } catch (error) {
    outcome = { ok: false, error };
  }

  const failures: string[] = [];
  if (harness !== undefined) {
    try {
      await stopCompose(harness, command, removeDirectory);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (migrations !== undefined) {
    try {
      removeDirectory(migrations);
    } catch (error) {
      failures.push(`migration fixture cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (!outcome.ok) {
    const primary = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
    throw new Error([primary, ...failures].join('\n'), { cause: outcome.error });
  }
  if (failures.length > 0) throw new Error(failures.join('\n'));
  return outcome.value;
}

function query(harness: PostgresHarness, sql: string): Promise<CommandResult> {
  return run('docker', ['exec', harness.container, 'psql', '-X', '-w', '-At', '-v', 'ON_ERROR_STOP=1', '-U', 'eow', '-d', 'eow', '-c', sql]);
}

async function queryValue(harness: PostgresHarness, sql: string): Promise<string> {
  const result = await query(harness, sql);
  expect(result.exitCode, `query failed:\n${result.stdout}\n${result.stderr}`).toBe(0);
  return result.stdout.trim();
}

async function composeQuery(harness: ComposeHarness, sql: string): Promise<CommandResult> {
  return runCompose(harness, 'exec', '-T', 'postgres', 'psql', '-X', '-w', '-At', '-v', 'ON_ERROR_STOP=1', '-U', 'eow', '-d', 'eow', '-c', sql);
}

async function composeQueryValue(harness: ComposeHarness, sql: string): Promise<string> {
  const result = await composeQuery(harness, sql);
  expect(result.exitCode, `Compose query failed:\n${result.stdout}\n${result.stderr}`).toBe(0);
  return result.stdout.trim();
}

async function composeOldSnapshotRows(harness: ComposeHarness): Promise<string> {
  return composeQueryValue(harness, `
    SELECT jsonb_build_object(
      'snapshots', COALESCE((
        SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id)
        FROM campaign_snapshot s
      ), '[]'::jsonb),
      'recipients', COALESCE((
        SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id)
        FROM campaign_recipient r
      ), '[]'::jsonb)
    )::text
  `);
}

async function composeHardeningState(harness: ComposeHarness): Promise<string> {
  return composeQueryValue(harness, `
    SELECT jsonb_build_object(
      'ledger_023', EXISTS (SELECT 1 FROM schema_migrations WHERE id = '023_campaign_snapshot_hardening'),
      'composite_fks', (${COMPOSITE_FK_TOPOLOGY_SQL})::jsonb,
      'singleton_fks', COALESCE((
        SELECT jsonb_agg(c.conname ORDER BY c.conname)
        FROM pg_constraint c
        WHERE c.conname = ANY (ARRAY[
          'campaign_snapshot_campaign_id_fkey',
          'campaign_snapshot_template_version_id_fkey',
          'campaign_snapshot_frozen_by_fkey',
          'campaign_recipient_campaign_id_fkey',
          'campaign_recipient_recipient_id_fkey',
          'campaign_recipient_snapshot_id_fkey'
        ])
      ), '[]'::jsonb),
      'hardening_constraints', COALESCE((
        SELECT jsonb_agg(c.conname ORDER BY c.conname)
        FROM pg_constraint c
        WHERE c.conname = ANY (ARRAY[
          'campaign_snapshot_counts_valid',
          'campaign_tenant_id_id_key',
          'email_template_version_tenant_id_id_key',
          'app_user_tenant_id_id_key',
          'recipient_tenant_id_id_key',
          'campaign_snapshot_tenant_campaign_id_id_key'
        ])
      ), '[]'::jsonb),
      'snapshot_function_hash', md5(pg_get_functiondef('campaign_snapshot_immutable()'::regprocedure)),
      'recipient_function_hash', md5(pg_get_functiondef('campaign_recipient_snapshot_immutable()'::regprocedure)),
      'campaign_function_hash', md5(pg_get_functiondef('campaign_no_edit_after_send()'::regprocedure)),
      'triggers', COALESCE((
        SELECT jsonb_object_agg(
          t.tgname,
          jsonb_build_object('definition', pg_get_triggerdef(t.oid), 'enabled', t.tgenabled)
          ORDER BY t.tgname
        )
        FROM pg_trigger t
        WHERE t.tgname = ANY (ARRAY[
          'campaign_snapshot_immutable_trigger',
          'campaign_recipient_snapshot_immutable_trigger',
          'campaign_no_edit_after_send_trigger'
        ])
          AND NOT t.tgisinternal
      ), '{}'::jsonb),
      'snapshot_default', pg_get_expr(d.adbin, d.adrelid),
      'recipient_default', pg_get_expr(rd.adbin, rd.adrelid)
    )::text
    FROM pg_attrdef d
    JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
    CROSS JOIN pg_attrdef rd
    JOIN pg_attribute ra ON ra.attrelid = rd.adrelid AND ra.attnum = rd.adnum
    WHERE d.adrelid = 'campaign_snapshot'::regclass
      AND a.attname = 'variable_schema_json'
      AND rd.adrelid = 'campaign_recipient'::regclass
      AND ra.attname = 'email_snapshot'
  `);
}

async function seedComposeOldSnapshotSchema(harness: ComposeHarness, corrupt: boolean): Promise<void> {
  const result = await composeQuery(harness, `
    INSERT INTO tenant (id, name) VALUES
      ('10000000-0000-0000-0000-000000000001', 'Tenant A'),
      ('10000000-0000-0000-0000-000000000002', 'Tenant B');
    INSERT INTO app_user (id, tenant_id, email, display_name, role) VALUES
      ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'owner-a@example.test', 'Owner A', 'admin'),
      ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', 'owner-b@example.test', 'Owner B', 'admin');
    INSERT INTO recipient (id, tenant_id, email) VALUES
      ('30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'recipient-a@example.test');
    INSERT INTO email_template (id, tenant_id, name, status) VALUES
      ('40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'Template A', 'published'),
      ('40000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', 'Template B', 'published');
    INSERT INTO email_template_version (
      id, tenant_id, template_id, version, subject, html, text_body, content_hash, published_at
    ) VALUES
      ('50000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 1, 'Subject A', '<p>A</p>', 'A', repeat('a', 64), now()),
      ('50000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000002', 1, 'Subject B', '<p>B</p>', 'B', repeat('b', 64), now());
    INSERT INTO campaign (id, tenant_id, name, status) VALUES
      ('60000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'Campaign A', 'queued');
    INSERT INTO campaign_snapshot (
      id, tenant_id, campaign_id, template_version_id, sender_json,
      audience_query_json, policy_result_json, variable_schema_json,
      total_snapshot, sendable_count, skipped_count, frozen_by
    ) VALUES (
      '70000000-0000-0000-0000-000000000001',
      '10000000-0000-0000-0000-000000000001',
      '60000000-0000-0000-0000-000000000001',
      '${corrupt ? '50000000-0000-0000-0000-000000000002' : '50000000-0000-0000-0000-000000000001'}',
      '{"from":"sender-a@example.test"}', '{"segments":[]}', '{"allowed":true}',
      '{"required":[],"optional":[]}', 1, 1, 0,
      '20000000-0000-0000-0000-000000000001'
    );
    INSERT INTO campaign_recipient (
      id, tenant_id, campaign_id, recipient_id, merge_data_json, snapshot_id,
      email_snapshot, eligibility, skipped_reason, status
    ) VALUES (
      '80000000-0000-0000-0000-000000000001',
      '10000000-0000-0000-0000-000000000001',
      '60000000-0000-0000-0000-000000000001',
      '30000000-0000-0000-0000-000000000001',
      '{"firstName":"Ada"}', '70000000-0000-0000-0000-000000000001',
      '{"subject":"Subject A","html":"<p>A</p>","textBody":"A"}', 'sendable', NULL, 'queued'
    );
  `);
  expect(result.exitCode, `Compose old-schema seed failed:\n${result.stdout}\n${result.stderr}`).toBe(0);
}

async function seedOldSnapshotSchema(harness: PostgresHarness, corrupt: boolean): Promise<void> {
  const result = await query(harness, `
    INSERT INTO tenant (id, name) VALUES
      ('10000000-0000-0000-0000-000000000001', 'Tenant A'),
      ('10000000-0000-0000-0000-000000000002', 'Tenant B');
    INSERT INTO app_user (id, tenant_id, email, display_name, role) VALUES
      ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'owner-a@example.test', 'Owner A', 'owner');
    INSERT INTO recipient (id, tenant_id, email) VALUES
      ('30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'recipient-a@example.test'),
      ('30000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', 'recipient-b@example.test');
    INSERT INTO email_template (id, tenant_id, name, status) VALUES
      ('40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'Template A', 'published'),
      ('40000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', 'Template B', 'published');
    INSERT INTO email_template_version (
      id, tenant_id, template_id, version, subject, html, text_body, content_hash, published_at
    ) VALUES
      (
        '50000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001',
        '40000000-0000-0000-0000-000000000001', 1, 'Subject A', '<p>A</p>', 'A',
        repeat('a', 64), now()
      ),
      (
        '50000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002',
        '40000000-0000-0000-0000-000000000002', 1, 'Subject B', '<p>B</p>', 'B',
        repeat('b', 64), now()
      );
    INSERT INTO campaign (id, tenant_id, name, status) VALUES
      ('60000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'Campaign A', 'draft');
    INSERT INTO campaign_snapshot (
      id, tenant_id, campaign_id, template_version_id, sender_json,
      audience_query_json, policy_result_json, variable_schema_json,
      total_snapshot, sendable_count, skipped_count, frozen_by
    ) VALUES (
      '70000000-0000-0000-0000-000000000001',
      '10000000-0000-0000-0000-000000000001',
      '60000000-0000-0000-0000-000000000001',
      '${corrupt ? '50000000-0000-0000-0000-000000000002' : '50000000-0000-0000-0000-000000000001'}',
      '{"from":"sender@example.test"}', '{}', '{}', '{}', 1, 1, 0,
      '20000000-0000-0000-0000-000000000001'
    );
    INSERT INTO campaign_recipient (
      id, tenant_id, campaign_id, recipient_id, merge_data_json, snapshot_id,
      email_snapshot, eligibility
    ) VALUES (
      '80000000-0000-0000-0000-000000000001',
      '10000000-0000-0000-0000-000000000001',
      '60000000-0000-0000-0000-000000000001',
      '30000000-0000-0000-0000-000000000001',
      '{"firstName":"Ada"}',
      '70000000-0000-0000-0000-000000000001',
      '{"subject":"Subject","html":"<p>Body</p>","textBody":"Body"}',
      'sendable'
    );
  `);
  expect(result.exitCode, `old-schema seed failed:\n${result.stdout}\n${result.stderr}`).toBe(0);
}

async function oldSnapshotRows(harness: PostgresHarness): Promise<string> {
  return queryValue(harness, `
    SELECT jsonb_build_object(
      'snapshot', (SELECT to_jsonb(s) FROM campaign_snapshot s WHERE id = '70000000-0000-0000-0000-000000000001'),
      'recipient', (SELECT to_jsonb(r) FROM campaign_recipient r WHERE id = '80000000-0000-0000-0000-000000000001')
    )::text
  `);
}

async function hardeningState(harness: PostgresHarness): Promise<string> {
  return queryValue(harness, `
    SELECT jsonb_build_object(
      'ledger_023', EXISTS (
        SELECT 1 FROM schema_migrations WHERE id = '023_campaign_snapshot_hardening'
      ),
      'composite_fks', (${COMPOSITE_FK_TOPOLOGY_SQL})::jsonb,
      'singleton_fks', COALESCE((
        SELECT jsonb_agg(c.conname ORDER BY c.conname)
        FROM pg_constraint c
        WHERE c.conname = ANY (ARRAY[
          'campaign_snapshot_campaign_id_fkey',
          'campaign_snapshot_template_version_id_fkey',
          'campaign_snapshot_frozen_by_fkey',
          'campaign_recipient_campaign_id_fkey',
          'campaign_recipient_recipient_id_fkey',
          'campaign_recipient_snapshot_id_fkey'
        ])
      ), '[]'::jsonb),
      'hardening_constraints', COALESCE((
        SELECT jsonb_agg(c.conname ORDER BY c.conname)
        FROM pg_constraint c
        WHERE c.conname = ANY (ARRAY[
          'campaign_snapshot_counts_valid',
          'campaign_tenant_id_id_key',
          'email_template_version_tenant_id_id_key',
          'app_user_tenant_id_id_key',
          'recipient_tenant_id_id_key',
          'campaign_snapshot_tenant_campaign_id_id_key'
        ])
      ), '[]'::jsonb),
      'snapshot_function_hash', md5(pg_get_functiondef('campaign_snapshot_immutable()'::regprocedure)),
      'recipient_function_hash', md5(pg_get_functiondef('campaign_recipient_snapshot_immutable()'::regprocedure)),
      'campaign_function_hash', md5(pg_get_functiondef('campaign_no_edit_after_send()'::regprocedure)),
      'triggers', COALESCE((
        SELECT jsonb_object_agg(
          t.tgname,
          jsonb_build_object('definition', pg_get_triggerdef(t.oid), 'enabled', t.tgenabled)
          ORDER BY t.tgname
        )
        FROM pg_trigger t
        WHERE t.tgname = ANY (ARRAY[
          'campaign_snapshot_immutable_trigger',
          'campaign_recipient_snapshot_immutable_trigger',
          'campaign_no_edit_after_send_trigger'
        ])
          AND NOT t.tgisinternal
      ), '{}'::jsonb),
      'snapshot_default', pg_get_expr(d.adbin, d.adrelid),
      'recipient_default', pg_get_expr(rd.adbin, rd.adrelid)
    )::text
    FROM pg_attrdef d
    JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
    CROSS JOIN pg_attrdef rd
    JOIN pg_attribute ra ON ra.attrelid = rd.adrelid AND ra.attnum = rd.adnum
    WHERE d.adrelid = 'campaign_snapshot'::regclass
      AND a.attname = 'variable_schema_json'
      AND rd.adrelid = 'campaign_recipient'::regclass
      AND ra.attname = 'email_snapshot'
  `);
}

function runFixtureMigrations(harness: PostgresHarness, migrations: string): Promise<CommandResult> {
  return run('docker', [
    'run', '--rm', '--network', harness.network,
    '-e', 'PGHOST=postgres', '-e', 'PGPORT=5432', '-e', 'PGDATABASE=eow', '-e', 'PGUSER=eow',
    '-e', `PGPASSWORD=${harness.databasePassword}`, '-e', `EOW_POSTGRES_APP_PASSWORD=${harness.appPassword}`,
    '-v', `${migrations}:/database/migrations:ro`, '-v', `${RUNNER_SOURCE}:/database/migrate.sh:ro`,
    'postgres:17-alpine', 'sh', '/database/migrate.sh',
  ]);
}

function runFixtureMigrationsWithFailedSha256sum(harness: PostgresHarness, migrations: string): Promise<CommandResult> {
  return run('docker', [
    'run', '--rm', '--network', harness.network,
    '-e', 'PGHOST=postgres', '-e', 'PGPORT=5432', '-e', 'PGDATABASE=eow', '-e', 'PGUSER=eow',
    '-e', `PGPASSWORD=${harness.databasePassword}`, '-e', `EOW_POSTGRES_APP_PASSWORD=${harness.appPassword}`,
    '-v', `${migrations}:/database/migrations:ro`, '-v', `${RUNNER_SOURCE}:/database/migrate.sh:ro`,
    'postgres:17-alpine', 'sh', '-ceu', "mkdir -p /test-bin; printf '#!/bin/sh\\nexit 17\\n' > /test-bin/sha256sum; chmod +x /test-bin/sha256sum; PATH=/test-bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin exec sh /database/migrate.sh",
  ]);
}

describe('DEPLOY-005: migration runner behavior', () => {
  it('upgrades populated 022 history through production Compose migrate', async () => {
    await withComposeFixture(
      () => repositoryMigrationDirectory(...repositoryMigrationNamesThrough(MIGRATION_022)),
      createComposeHarness,
      async (compose, migrations) => {
        const started = await runCompose(compose, 'up', '-d', 'postgres');
        expect(started.exitCode, `Compose PostgreSQL startup failed:\n${started.stdout}\n${started.stderr}`).toBe(0);

        const through022 = await runCompose(compose, 'run', '--rm', 'migrate');
        expect(through022.exitCode, `Compose 022 migration failed:\n${through022.stdout}\n${through022.stderr}`).toBe(0);

        const seeded = await composeQuery(compose, `
          INSERT INTO tenant (id, name) VALUES
            ('10000000-0000-0000-0000-000000000001', 'Tenant A'),
            ('10000000-0000-0000-0000-000000000002', 'Tenant B');
          INSERT INTO app_user (id, tenant_id, email, display_name, role) VALUES
            ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'owner-a@example.test', 'Owner A', 'admin'),
            ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', 'owner-b@example.test', 'Owner B', 'admin');
          INSERT INTO recipient (id, tenant_id, email) VALUES
            ('30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'recipient-a@example.test'),
            ('30000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'recipient-a-skipped@example.test'),
            ('30000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000002', 'recipient-b@example.test'),
            ('30000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000002', 'recipient-b-skipped@example.test');
          INSERT INTO email_template (id, tenant_id, name, status) VALUES
            ('40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'Template A', 'published'),
            ('40000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', 'Template B', 'published');
          INSERT INTO email_template_version (id, tenant_id, template_id, version, subject, html, text_body, content_hash, published_at) VALUES
            ('50000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 1, 'Subject A', '<p>A</p>', 'A', repeat('a', 64), now()),
            ('50000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000002', 1, 'Subject B', '<p>B</p>', 'B', repeat('b', 64), now());
          INSERT INTO campaign (id, tenant_id, name, status) VALUES
            ('60000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'Campaign A', 'queued'),
            ('60000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', 'Campaign B', 'queued');
          INSERT INTO campaign_snapshot (id, tenant_id, campaign_id, template_version_id, sender_json, audience_query_json, policy_result_json, variable_schema_json, total_snapshot, sendable_count, skipped_count, frozen_by, superseded_at) VALUES
            ('70000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', '{"from":"sender-a@example.test"}', '{"segments":[]}', '{"allowed":true}', '{"required":[],"optional":[]}', 2, 1, 1, '20000000-0000-0000-0000-000000000001', now()),
            ('70000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', '60000000-0000-0000-0000-000000000002', '50000000-0000-0000-0000-000000000002', '{"from":"sender-b@example.test"}', '{"segments":[]}', '{"allowed":true}', '{"required":[],"optional":[]}', 2, 1, 1, '20000000-0000-0000-0000-000000000002', NULL),
            ('70000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000002', '60000000-0000-0000-0000-000000000002', '50000000-0000-0000-0000-000000000002', '{"from":"sender-b@example.test"}', '{"segments":[]}', '{"allowed":true}', '{"required":[],"optional":[]}', 1, 1, 0, '20000000-0000-0000-0000-000000000002', now());
          INSERT INTO campaign_recipient (id, tenant_id, campaign_id, recipient_id, merge_data_json, snapshot_id, email_snapshot, eligibility, skipped_reason, status, provider_message_id) VALUES
            ('80000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '{"firstName":"Ada"}', '70000000-0000-0000-0000-000000000001', '{"subject":"Subject A","html":"<p>A</p>","textBody":"A"}', 'sendable', NULL, 'sent', 'provider-a'),
            ('80000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002', '{"firstName":"Ada"}', '70000000-0000-0000-0000-000000000001', '{"subject":"Subject A","html":"<p>A</p>","textBody":"A"}', 'skipped', 'missing_required_variable', 'queued', NULL),
            ('80000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000002', '60000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000003', '{"firstName":"Bea"}', '70000000-0000-0000-0000-000000000002', '{"subject":"Subject B","html":"<p>B</p>","textBody":"B"}', 'sendable', NULL, 'queued', NULL),
            ('80000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000002', '60000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000004', '{"firstName":"Bea"}', '70000000-0000-0000-0000-000000000002', '{"subject":"Subject B","html":"<p>B</p>","textBody":"B"}', 'skipped', 'missing_required_variable', 'queued', NULL),
            ('80000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000002', '60000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000003', '{"firstName":"Bea"}', '70000000-0000-0000-0000-000000000003', '{"subject":"Subject B","html":"<p>B</p>","textBody":"B"}', 'sendable', NULL, 'queued', NULL);
        `);
        expect(seeded.exitCode, `Compose legacy seed failed:\n${seeded.stdout}\n${seeded.stderr}`).toBe(0);

        const rowsBefore = await composeOldSnapshotRows(compose);
        const stateBefore = await composeHardeningState(compose);

        addRepositoryMigration(migrations, MIGRATION_023);
        const upgraded = await runCompose(compose, 'run', '--rm', 'migrate');
        expect(upgraded.exitCode, `Compose 023 migration failed:\n${upgraded.stdout}\n${upgraded.stderr}`).toBe(0);
        expect(await composeOldSnapshotRows(compose)).toBe(rowsBefore);
        expect(await composeQueryValue(
          compose,
          "SELECT checksum FROM schema_migrations WHERE id = '023_campaign_snapshot_hardening'",
        )).toBe(checksum(join(migrations, MIGRATION_023)));
        expectExactCompositeForeignKeys(await composeQueryValue(compose, COMPOSITE_FK_TOPOLOGY_SQL));
        expect(await composeQueryValue(compose, `
          SELECT count(*)
          FROM pg_constraint
          WHERE conname = ANY (ARRAY[
            'campaign_snapshot_campaign_id_fkey',
            'campaign_snapshot_template_version_id_fkey',
            'campaign_snapshot_frozen_by_fkey',
            'campaign_recipient_campaign_id_fkey',
            'campaign_recipient_recipient_id_fkey',
            'campaign_recipient_snapshot_id_fkey'
          ])
        `)).toBe('0');
        const stateAfterUpgrade = await composeHardeningState(compose);
        expect(stateAfterUpgrade).not.toBe(stateBefore);
        expect(stateAfterUpgrade).toContain('campaign_snapshot_counts_valid');
        expect(stateAfterUpgrade).toContain('"ledger_023": true');
        expect(stateAfterUpgrade).toContain('"singleton_fks": []');

        const rerun = await runCompose(compose, 'run', '--rm', 'migrate');
        expect(rerun.exitCode, `Compose 023 rerun failed:\n${rerun.stdout}\n${rerun.stderr}`).toBe(0);
        expect(`${rerun.stdout}\n${rerun.stderr}`).toContain('Migration 023_campaign_snapshot_hardening already applied.');
        expect(await composeQueryValue(
          compose,
          "SELECT count(*) FROM schema_migrations WHERE id = '023_campaign_snapshot_hardening'",
        )).toBe('1');
        expect(await composeOldSnapshotRows(compose)).toBe(rowsBefore);
        expect(await composeHardeningState(compose)).toBe(stateAfterUpgrade);
      },
    );
  }, 180_000);

  it('rolls back Compose 023 when only template-version tenancy is corrupt, then upgrades repaired history', async () => {
    await withComposeFixture(
      () => repositoryMigrationDirectory(...repositoryMigrationNamesThrough(MIGRATION_022)),
      createComposeHarness,
      async (compose, migrations) => {
        const started = await runCompose(compose, 'up', '-d', 'postgres');
        expect(started.exitCode, `Compose PostgreSQL startup failed:\n${started.stdout}\n${started.stderr}`).toBe(0);

        const through022 = await runCompose(compose, 'run', '--rm', 'migrate');
        expect(through022.exitCode, `Compose 022 migration failed:\n${through022.stdout}\n${through022.stderr}`).toBe(0);
        await seedComposeOldSnapshotSchema(compose, true);
        const rowsBefore = await composeOldSnapshotRows(compose);
        const stateBefore = await composeHardeningState(compose);

        addRepositoryMigration(migrations, MIGRATION_023);
        const failed = await runCompose(compose, 'run', '--rm', 'migrate');
        expect(failed.exitCode).not.toBe(0);
        expect(`${failed.stdout}\n${failed.stderr}`).toContain('campaign_snapshot_tenant_template_version_fkey');
        expect(await composeOldSnapshotRows(compose)).toBe(rowsBefore);
        expect(await composeHardeningState(compose)).toBe(stateBefore);
        expect(await composeQueryValue(
          compose,
          "SELECT count(*) FROM schema_migrations WHERE id = '023_campaign_snapshot_hardening'",
        )).toBe('0');

        const snapshotTriggerState = await composeQueryValue(compose, `
          SELECT tgenabled
          FROM pg_trigger
          WHERE tgrelid = 'campaign_snapshot'::regclass
            AND tgname = 'campaign_snapshot_immutable_trigger'
        `);
        const repaired = await composeQuery(compose, `
          BEGIN;
          ALTER TABLE campaign_snapshot DISABLE TRIGGER campaign_snapshot_immutable_trigger;
          UPDATE campaign_snapshot
          SET template_version_id = '50000000-0000-0000-0000-000000000001'
          WHERE id = '70000000-0000-0000-0000-000000000001';
          ALTER TABLE campaign_snapshot ENABLE TRIGGER campaign_snapshot_immutable_trigger;
          COMMIT;
        `);
        expect(repaired.exitCode, `Compose isolated corruption repair failed:\n${repaired.stdout}\n${repaired.stderr}`).toBe(0);
        expect(await composeQueryValue(compose, `
          SELECT tgenabled
          FROM pg_trigger
          WHERE tgrelid = 'campaign_snapshot'::regclass
            AND tgname = 'campaign_snapshot_immutable_trigger'
        `)).toBe(snapshotTriggerState);

        const upgraded = await runCompose(compose, 'run', '--rm', 'migrate');
        expect(upgraded.exitCode, `Compose repaired 023 migration failed:\n${upgraded.stdout}\n${upgraded.stderr}`).toBe(0);
        expect(await composeQueryValue(
          compose,
          "SELECT count(*) FROM schema_migrations WHERE id = '023_campaign_snapshot_hardening'",
        )).toBe('1');
        expect(await composeQueryValue(
          compose,
          "SELECT template_version_id FROM campaign_snapshot WHERE id = '70000000-0000-0000-0000-000000000001'",
        )).toBe('50000000-0000-0000-0000-000000000001');
        const stateAfterUpgrade = await composeHardeningState(compose);

        const rerun = await runCompose(compose, 'run', '--rm', 'migrate');
        expect(rerun.exitCode, `Compose repaired 023 rerun failed:\n${rerun.stdout}\n${rerun.stderr}`).toBe(0);
        expect(`${rerun.stdout}\n${rerun.stderr}`).toContain('Migration 023_campaign_snapshot_hardening already applied.');
        expect(await composeQueryValue(
          compose,
          "SELECT count(*) FROM schema_migrations WHERE id = '023_campaign_snapshot_hardening'",
        )).toBe('1');
        expect(await composeHardeningState(compose)).toBe(stateAfterUpgrade);
      },
    );
  }, 180_000);

  it('upgrades valid repository migration 022 data through 023 and reruns cleanly', async () => {
    await withPostgresFixture(
      () => repositoryMigrationDirectory(...repositoryMigrationNamesThrough(MIGRATION_022)),
      async (harness, migrations) => {
        const through022 = await runFixtureMigrations(harness, migrations);
        expect(through022.exitCode, `022 runner failed:\n${through022.stdout}\n${through022.stderr}`).toBe(0);
        await seedOldSnapshotSchema(harness, false);
        const rowsBefore = await oldSnapshotRows(harness);

        addRepositoryMigration(migrations, MIGRATION_023);
        const upgraded = await runFixtureMigrations(harness, migrations);
        expect(upgraded.exitCode, `023 runner failed:\n${upgraded.stdout}\n${upgraded.stderr}`).toBe(0);
        expect(await oldSnapshotRows(harness)).toBe(rowsBefore);
        expect(await queryValue(
          harness,
          "SELECT checksum FROM schema_migrations WHERE id = '023_campaign_snapshot_hardening'",
        )).toBe(checksum(join(migrations, MIGRATION_023)));
        expectExactCompositeForeignKeys(await queryValue(harness, COMPOSITE_FK_TOPOLOGY_SQL));
        expect(await queryValue(harness, `
          SELECT count(*)
          FROM pg_constraint
          WHERE conname = ANY (ARRAY[
            'campaign_snapshot_campaign_id_fkey',
            'campaign_snapshot_template_version_id_fkey',
            'campaign_snapshot_frozen_by_fkey',
            'campaign_recipient_campaign_id_fkey',
            'campaign_recipient_recipient_id_fkey',
            'campaign_recipient_snapshot_id_fkey'
          ])
        `)).toBe('0');

        const stateAfterUpgrade = await hardeningState(harness);
        const rerun = await runFixtureMigrations(harness, migrations);
        expect(rerun.exitCode, `023 rerun failed:\n${rerun.stdout}\n${rerun.stderr}`).toBe(0);
        expect(`${rerun.stdout}\n${rerun.stderr}`).toContain('Migration 023_campaign_snapshot_hardening already applied.');
        expect(await oldSnapshotRows(harness)).toBe(rowsBefore);
        expect(await hardeningState(harness)).toBe(stateAfterUpgrade);
      },
    );
  }, 180_000);

  it('rolls back repository migration 023 on old-schema cross-tenant corruption and retry remains clean', async () => {
    await withPostgresFixture(
      () => repositoryMigrationDirectory(...repositoryMigrationNamesThrough(MIGRATION_022)),
      async (harness, migrations) => {
        const through022 = await runFixtureMigrations(harness, migrations);
        expect(through022.exitCode, `022 runner failed:\n${through022.stdout}\n${through022.stderr}`).toBe(0);
        await seedOldSnapshotSchema(harness, true);
        const rowsBefore = await oldSnapshotRows(harness);
        const stateBefore = await hardeningState(harness);

        addRepositoryMigration(migrations, MIGRATION_023);
        const failed = await runFixtureMigrations(harness, migrations);
        expect(failed.exitCode).not.toBe(0);
        expect(`${failed.stdout}\n${failed.stderr}`).toContain('campaign_snapshot_tenant_template_version_fkey');
        expect(await oldSnapshotRows(harness)).toBe(rowsBefore);
        expect(await hardeningState(harness)).toBe(stateBefore);
        expect(await queryValue(harness, "SELECT count(*) FROM schema_migrations WHERE id = '023_campaign_snapshot_hardening'")).toBe('0');

        const retried = await runFixtureMigrations(harness, migrations);
        expect(retried.exitCode).not.toBe(0);
        expect(`${retried.stdout}\n${retried.stderr}`).toContain('campaign_snapshot_tenant_template_version_fkey');
        expect(await oldSnapshotRows(harness)).toBe(rowsBefore);
        expect(await hardeningState(harness)).toBe(stateBefore);
        expect(await queryValue(harness, "SELECT count(*) FROM schema_migrations WHERE id = '023_campaign_snapshot_hardening'")).toBe('0');
      },
    );
  }, 180_000);
  it('rolls back failed DDL and its ledger row, then succeeds on retry', async () => {
    await withPostgresFixture(
      () => fixtureDirectory('992_cp1_runner_rollback_probe.sql'),
      async (harness, migrations) => {
        const failed = await runFixtureMigrations(harness, migrations);
        expect(failed.exitCode).not.toBe(0);
        expect((await query(harness, "SELECT to_regclass('public.cp1_runner_rollback_probe') IS NULL")).stdout.trim()).toBe('t');
        expect((await query(harness, "SELECT to_regclass('public.schema_migrations') IS NULL")).stdout.trim()).toBe('t');

        writeFileSync(join(migrations, '992_cp1_runner_rollback_probe.sql'), 'CREATE TABLE cp1_runner_rollback_probe (id integer PRIMARY KEY);\n');
        const retried = await runFixtureMigrations(harness, migrations);
        expect(retried.exitCode).toBe(0);
        expect((await query(harness, "SELECT to_regclass('public.cp1_runner_rollback_probe') IS NOT NULL")).stdout.trim()).toBe('t');
        const ledger = await query(harness, `SELECT checksum = '${checksum(join(migrations, '992_cp1_runner_rollback_probe.sql'))}' FROM schema_migrations WHERE id = '992_cp1_runner_rollback_probe'`);
        expect(ledger.stdout.trim()).toBe('t');
      },
    );
  }, 90_000);

  it('serializes concurrent first runs before ledger insert', async () => {
    await withPostgresFixture(
      () => fixtureDirectory('993_cp1_runner_concurrency_probe.sql'),
      async (harness, migrations) => {
        const [first, second] = await Promise.all([
          runFixtureMigrations(harness, migrations),
          runFixtureMigrations(harness, migrations),
        ]);

        expect(first.exitCode, `first runner failed:\n${first.stdout}\n${first.stderr}`).toBe(0);
        expect(second.exitCode, `second runner failed:\n${second.stdout}\n${second.stderr}`).toBe(0);
        expect((await query(harness, "SELECT count(*) FROM schema_migrations WHERE id = '993_cp1_runner_concurrency_probe'" )).stdout.trim()).toBe('1');
        expect((await query(harness, 'SELECT count(*) FROM cp1_runner_concurrency_probe')).stdout.trim()).toBe('1');
      },
    );
  }, 90_000);

  it('rejects top-level transaction control before it executes a migration', async () => {
    await withPostgresFixture(
      () => fixtureDirectory('994_cp1_runner_transaction_escape_probe.sql'),
      async (harness, migrations) => {
        const failed = await runFixtureMigrations(harness, migrations);

        expect(failed.exitCode).not.toBe(0);
        expect(`${failed.stdout}\n${failed.stderr}`).toContain('Unsafe migration source');
        expect((await query(harness, "SELECT to_regclass('public.cp1_runner_transaction_escape_probe') IS NULL")).stdout.trim()).toBe('t');
        expect((await query(harness, "SELECT to_regclass('public.schema_migrations') IS NULL")).stdout.trim()).toBe('t');
      },
    );
  }, 90_000);

  it('rejects transaction control after COPY TO query text mentioning FROM STDIN before migration DDL or ledger creation', async () => {
    await withPostgresFixture(
      () => fixtureDirectory('999_cp1_runner_copy_to_escape_probe.sql'),
      async (harness, migrations) => {
        const failed = await runFixtureMigrations(harness, migrations);

        expect(failed.exitCode).not.toBe(0);
        expect((await query(harness, "SELECT to_regclass('public.cp1_runner_copy_to_escape_probe') IS NULL")).stdout.trim()).toBe('t');
        expect((await query(harness, "SELECT to_regclass('public.schema_migrations') IS NULL")).stdout.trim()).toBe('t');
        expect(`${failed.stdout}\n${failed.stderr}`).toContain('Unsafe migration source');
      },
    );
  }, 90_000);

  it('rejects transaction control after COPY TO query text mentioning a FROM STDIN function before migration DDL or ledger creation', async () => {
    await withPostgresFixture(
      () => fixtureDirectory('999_cp1_runner_copy_to_function_escape_probe.sql'),
      async (harness, migrations) => {
        const failed = await runFixtureMigrations(harness, migrations);

        expect(failed.exitCode).not.toBe(0);
        expect((await query(harness, "SELECT to_regclass('public.cp1_runner_copy_to_function_escape_probe') IS NULL")).stdout.trim()).toBe('t');
        expect((await query(harness, "SELECT to_regclass('public.schema_migrations') IS NULL")).stdout.trim()).toBe('t');
        expect(`${failed.stdout}\n${failed.stderr}`).toContain('Unsafe migration source');
      },
    );
  }, 90_000);

  it('fails checksum mismatch and does not apply later migration', async () => {
    await withPostgresFixture(
      () => fixtureDirectory('990_cp1_runner_mismatch_probe.sql'),
      async (harness, migrations) => {
        const original = await runFixtureMigrations(harness, migrations);
        expect(original.exitCode, `initial runner failed:\n${original.stdout}\n${original.stderr}`).toBe(0);

        copyFileSync(join(FIXTURES_DIR, '991_cp1_runner_later_probe.sql'), join(migrations, '991_cp1_runner_later_probe.sql'));
        writeFileSync(join(migrations, '990_cp1_runner_mismatch_probe.sql'), 'CREATE TABLE cp1_runner_mismatch_probe (id integer PRIMARY KEY, changed boolean NOT NULL DEFAULT false);\n');
        const changed = await runFixtureMigrations(harness, migrations);
        expect(changed.exitCode).not.toBe(0);
        expect(`${changed.stdout}\n${changed.stderr}`).toContain('Published migration 990_cp1_runner_mismatch_probe changed; add a forward migration instead.');
        expect((await query(harness, "SELECT to_regclass('public.cp1_runner_later_probe') IS NULL")).stdout.trim()).toBe('t');
      },
    );
  }, 90_000);

  it('rejects ABORT before migration DDL or ledger creation', async () => {
    await withPostgresFixture(
      () => fixtureDirectory('995_cp1_runner_abort_probe.sql'),
      async (harness, migrations) => {
        const failed = await runFixtureMigrations(harness, migrations);

        expect(failed.exitCode).not.toBe(0);
        expect(`${failed.stdout}\n${failed.stderr}`).toContain('Unsafe migration source');
        expect((await query(harness, "SELECT to_regclass('public.cp1_runner_abort_probe') IS NULL")).stdout.trim()).toBe('t');
        expect((await query(harness, "SELECT to_regclass('public.schema_migrations') IS NULL")).stdout.trim()).toBe('t');
      },
    );
  }, 90_000);

  it('rejects a psql command after a dollar-tagged identifier before DDL or ledger creation', async () => {
    await withPostgresFixture(
      () => fixtureDirectory('996_cp1_runner_dollar_identifier_quit_probe.sql'),
      async (harness, migrations) => {
        const failed = await runFixtureMigrations(harness, migrations);

        expect(failed.exitCode).not.toBe(0);
        expect(`${failed.stdout}\n${failed.stderr}`).toContain('Unsafe migration source');
        expect((await query(harness, "SELECT to_regclass('public.cp1_runner_dollar$sentinel$') IS NULL")).stdout.trim()).toBe('t');
        expect((await query(harness, "SELECT to_regclass('public.schema_migrations') IS NULL")).stdout.trim()).toBe('t');
      },
    );
  }, 90_000);

  it('rejects a same-line psql command before DDL or ledger creation', async () => {
    await withPostgresFixture(
      () => fixtureDirectory('998_cp1_runner_same_line_quit_probe.sql'),
      async (harness, migrations) => {
        const failed = await runFixtureMigrations(harness, migrations);

        expect(failed.exitCode).not.toBe(0);
        expect(`${failed.stdout}\n${failed.stderr}`).toContain('Unsafe migration source');
        expect((await query(harness, "SELECT to_regclass('public.cp1_runner_same_line_quit_probe') IS NULL")).stdout.trim()).toBe('t');
        expect((await query(harness, "SELECT to_regclass('public.schema_migrations') IS NULL")).stdout.trim()).toBe('t');
      },
    );
  }, 90_000);

  it.each([
    ['inline query-ending command', '999_cp1_runner_inline_gexec_probe.sql', 'cp1_runner_inline_gexec_probe'],
    ['E-string escaped-quote bypass', '999_cp1_runner_e_escape_bypass_probe.sql', 'cp1_runner_e_escape_bypass_probe'],
  ])('rejects %s before DDL or ledger creation', async (_name, fixture, relation) => {
    await withPostgresFixture(
      () => fixtureDirectory(fixture),
      async (harness, migrations) => {
        const failed = await runFixtureMigrations(harness, migrations);

        expect(failed.exitCode).not.toBe(0);
        expect(`${failed.stdout}\n${failed.stderr}`).toContain('Unsafe migration source');
        expect((await query(harness, `SELECT to_regclass('public.${relation}') IS NULL`)).stdout.trim()).toBe('t');
        expect((await query(harness, "SELECT to_regclass('public.schema_migrations') IS NULL")).stdout.trim()).toBe('t');
      },
    );
  }, 90_000);

  it('rejects an unterminated COPY payload before DDL or ledger creation', async () => {
    await withPostgresFixture(
      () => fixtureDirectory('999_cp1_runner_copy_unterminated_probe.sql'),
      async (harness, migrations) => {
        const failed = await runFixtureMigrations(harness, migrations);

        expect(failed.exitCode).not.toBe(0);
        expect(`${failed.stdout}\n${failed.stderr}`).toContain('Unsafe migration source');
        expect((await query(harness, "SELECT to_regclass('public.cp1_runner_copy_unterminated_probe') IS NULL")).stdout.trim()).toBe('t');
        expect((await query(harness, "SELECT to_regclass('public.schema_migrations') IS NULL")).stdout.trim()).toBe('t');
      },
    );
  }, 90_000);

  it.each([
    ['LF', '999_cp1_runner_copy_post_terminator_probe.sql'],
    ['CRLF', '999_cp1_runner_copy_post_terminator_crlf_probe.sql'],
  ])('rejects a second exact COPY terminator after %s input before DDL or ledger creation', async (_lineEnding, fixture) => {
    await withPostgresFixture(
      () => fixtureDirectory(fixture),
      async (harness, migrations) => {
        const failed = await runFixtureMigrations(harness, migrations);

        expect(failed.exitCode).not.toBe(0);
        expect(`${failed.stdout}\n${failed.stderr}`).toContain('Unsafe migration source');
        expect((await query(harness, "SELECT to_regclass('public.cp1_runner_copy_post_terminator_probe') IS NULL")).stdout.trim()).toBe('t');
        expect((await query(harness, "SELECT to_regclass('public.schema_migrations') IS NULL")).stdout.trim()).toBe('t');
      },
    );
  }, 90_000);

  it('preserves genuine tagged dollar-quoted bodies', async () => {
    await withPostgresFixture(
      () => fixtureDirectory('997_cp1_runner_tagged_body_probe.sql'),
      async (harness, migrations) => {
        const result = await runFixtureMigrations(harness, migrations);

        expect(result.exitCode, `runner failed:\n${result.stdout}\n${result.stderr}`).toBe(0);
        expect((await query(harness, "SELECT to_regclass('public.cp1_runner_tagged_body_probe') IS NOT NULL")).stdout.trim()).toBe('t');
        expect((await query(harness, "SELECT count(*) FROM schema_migrations WHERE id = '997_cp1_runner_tagged_body_probe'" )).stdout.trim()).toBe('1');
      },
    );
  }, 90_000);

  it('permits COPY data terminators', async () => {
    await withPostgresFixture(
      () => fixtureDirectory('999_cp1_runner_copy_terminator_probe.sql'),
      async (harness, migrations) => {
        const result = await runFixtureMigrations(harness, migrations);

        expect(result.exitCode, `runner failed:\n${result.stdout}\n${result.stderr}`).toBe(0);
        expect((await query(harness, 'SELECT count(*) FROM cp1_runner_copy_terminator_probe')).stdout.trim()).toBe('1');
        expect((await query(harness, "SELECT count(*) FROM schema_migrations WHERE id = '999_cp1_runner_copy_terminator_probe'" )).stdout.trim()).toBe('1');
      },
    );
  }, 90_000);

  it('permits legacy CSV COPY data terminators', async () => {
    await withPostgresFixture(
      () => fixtureDirectory('999_cp1_runner_copy_csv_probe.sql'),
      async (harness, migrations) => {
        const result = await runFixtureMigrations(harness, migrations);

        expect(result.exitCode, `runner failed:\n${result.stdout}\n${result.stderr}`).toBe(0);
        expect((await query(harness, 'SELECT count(*) FROM cp1_runner_copy_csv_probe')).stdout.trim()).toBe('1');
        expect((await query(harness, "SELECT count(*) FROM schema_migrations WHERE id = '999_cp1_runner_copy_csv_probe'" )).stdout.trim()).toBe('1');
      },
    );
  }, 90_000);

  it('permits compact COPY options', async () => {
    await withPostgresFixture(
      () => fixtureDirectory('999_cp1_runner_copy_compact_options_probe.sql'),
      async (harness, migrations) => {
        const result = await runFixtureMigrations(harness, migrations);

        expect(result.exitCode, `runner failed:\n${result.stdout}\n${result.stderr}`).toBe(0);
        expect((await query(harness, 'SELECT count(*) FROM cp1_runner_copy_compact_options_probe')).stdout.trim()).toBe('1');
        expect((await query(harness, "SELECT count(*) FROM schema_migrations WHERE id = '999_cp1_runner_copy_compact_options_probe'" )).stdout.trim()).toBe('1');
      },
    );
  }, 90_000);

  it.each([
    ['LF', '999_cp1_runner_copy_payload_probe.sql', 'cp1_runner_copy_payload_probe'],
    ['CRLF', '999_cp1_runner_copy_payload_crlf_probe.sql', 'cp1_runner_copy_payload_crlf_probe'],
  ])('preserves %s COPY payload until an exact terminator', async (_lineEnding, fixture, relation) => {
    await withPostgresFixture(
      () => fixtureDirectory(fixture),
      async (harness, migrations) => {
        const result = await runFixtureMigrations(harness, migrations);

        expect(result.exitCode, `runner failed:\n${result.stdout}\n${result.stderr}`).toBe(0);
        const payload = await query(harness, `SELECT json_agg(value ORDER BY ctid)::text FROM ${relation}`);
        expect(payload.stdout.trim()).toBe('["COMMIT", "\\\\q", " \\\\." ]'.replace('" ]', '"]'));
        expect((await query(harness, `SELECT count(*) FROM schema_migrations WHERE id = '${fixture.slice(0, -4)}'`)).stdout.trim()).toBe('1');
      },
    );
  }, 90_000);

  it('preserves E-prefixed escape strings containing psql-looking text', async () => {
    await withPostgresFixture(
      () => fixtureDirectory('999_cp1_runner_escape_string_probe.sql'),
      async (harness, migrations) => {
        const result = await runFixtureMigrations(harness, migrations);

        expect(result.exitCode, `runner failed:\n${result.stdout}\n${result.stderr}`).toBe(0);
        expect((await query(harness, "SELECT to_regclass('public.cp1_runner_escape_string_probe') IS NOT NULL")).stdout.trim()).toBe('t');
        expect((await query(harness, "SELECT count(*) FROM schema_migrations WHERE id = '999_cp1_runner_escape_string_probe'" )).stdout.trim()).toBe('1');
      },
    );
  }, 90_000);

  it('preserves non-ASCII dollar-quoted bodies', async () => {
    await withPostgresFixture(
      () => fixtureDirectory('999_cp1_runner_unicode_tag_probe.sql'),
      async (harness, migrations) => {
        const result = await runFixtureMigrations(harness, migrations);

        expect(result.exitCode, `runner failed:\n${result.stdout}\n${result.stderr}`).toBe(0);
        expect((await query(harness, "SELECT to_regclass('public.cp1_runner_unicode_tag_probe') IS NOT NULL")).stdout.trim()).toBe('t');
        expect((await query(harness, "SELECT count(*) FROM schema_migrations WHERE id = '999_cp1_runner_unicode_tag_probe'" )).stdout.trim()).toBe('1');
      },
    );
  }, 90_000);

  it('fails selected checksum command before migration DDL or ledger creation', async () => {
    await withPostgresFixture(
      () => fixtureDirectory('990_cp1_runner_mismatch_probe.sql'),
      async (harness, migrations) => {
        const failed = await runFixtureMigrationsWithFailedSha256sum(harness, migrations);

        expect(failed.exitCode).not.toBe(0);
        expect(`${failed.stdout}\n${failed.stderr}`).toContain('Migration checksum command failed: sha256sum');
        expect((await query(harness, "SELECT to_regclass('public.cp1_runner_mismatch_probe') IS NULL")).stdout.trim()).toBe('t');
        expect((await query(harness, "SELECT to_regclass('public.schema_migrations') IS NULL")).stdout.trim()).toBe('t');
      },
    );
  }, 90_000);
});
