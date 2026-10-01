import { type Mock, afterEach, describe, expect, it, vi } from 'vitest';
import {
  COMPOSE_PROJECT_LABEL,
  FIXTURE_CREATED_LABEL,
  FIXTURE_LABEL,
  FIXTURE_NAME_PREFIX,
  STALE_FIXTURE_AGE_MS,
  type CommandResult,
  type CommandRunner,
  fixtureLabelArguments,
  releaseFixture,
  sweepStaleFixtures,
  sweepTrackedFixtures,
  trackFixture,
  trackedFixtureCount,
} from './docker-fixtures.js';

const NOW = 1_756_000_000_000;
const OK: CommandResult = { exitCode: 0, stdout: '', stderr: '' };

function ok(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: '' };
}

/** A `docker ps` line in the format sweepStaleFixtures asks for. */
function containerLine(name: string, createdAt: number, composeProject = ''): string {
  return `${name}\t${String(createdAt)}\t${composeProject}`;
}

function dockerStub(responses: (args: string[]) => CommandResult | undefined): Mock<CommandRunner> {
  return vi.fn<CommandRunner>(async (_command, args) => responses(args) ?? OK);
}

afterEach(async () => {
  // These tests drive the registry directly; never let one leak into the next.
  await sweepTrackedFixtures();
});

/**
 * DEPLOY-005 follow-up. The migration-runner fixtures leaked Docker resources
 * two ways, and neither showed up as a failing test.
 *
 * `docker rm -f` without `-v` orphaned every fixture's anonymous PGDATA volume
 * on the *success* path -- 1039 dangling volumes worth 49 GB on one developer
 * machine. Separately, vitest kills a timed-out test rather than unwinding it,
 * so the teardown written after the fixture body never runs and the container
 * survives; two such orphans were found, one of them up for 31 hours.
 *
 * (The suite's duration climbing 220s -> 439s -> 821s was blamed on this
 * garbage at the time, but pruning it did not help: that was memory pressure
 * from the full compose stack. The leak is worth fixing on its own.)
 *
 * These rules keep the fix honest: fixtures are labelled, dated and prefixed so
 * they can be found, and every sweep is scoped to them so it can never touch the
 * unrelated containers a developer machine also hosts.
 */
describe('ARCH-DOCKER-FIXTURES: fixture cleanup is scoped and unconditional', () => {
  it('stamps the fixture label and creation time on created objects', () => {
    expect(fixtureLabelArguments(NOW)).toEqual([
      '--label', `${FIXTURE_LABEL}=1`,
      '--label', `${FIXTURE_CREATED_LABEL}=${String(NOW)}`,
    ]);
  });

  it('removes a fixture the test never released', async () => {
    const release = vi.fn(async () => {});
    const key = {};
    trackFixture(key, 'PostgreSQL fixture eow_cp1_postgres_abc', release);
    expect(trackedFixtureCount()).toBe(1);

    // Stands in for vitest killing a timed-out test: the body is abandoned and
    // its own teardown never runs, so afterEach's sweep is the only cleanup left.
    expect(await sweepTrackedFixtures()).toEqual(['PostgreSQL fixture eow_cp1_postgres_abc']);
    expect(release).toHaveBeenCalledTimes(1);
    expect(trackedFixtureCount()).toBe(0);
  });

  it('reports a cleanup failure instead of swallowing it', async () => {
    trackFixture({}, 'Compose fixture eow_cp1_legacy_abc', async () => { throw new Error('down failed'); });

    expect(await sweepTrackedFixtures()).toEqual([
      'Compose fixture eow_cp1_legacy_abc (cleanup reported: down failed)',
    ]);
  });

  it('leaves a released fixture alone', async () => {
    const release = vi.fn(async () => {});
    const key = {};
    trackFixture(key, 'PostgreSQL fixture eow_cp1_postgres_abc', release);
    releaseFixture(key);

    expect(await sweepTrackedFixtures()).toEqual([]);
    expect(release).not.toHaveBeenCalled();
  });

  it('removes a stale fixture container with its anonymous volumes', async () => {
    const command = dockerStub((args) => (
      args[0] === 'ps' ? ok(containerLine('eow_cp1_postgres_abc', NOW - STALE_FIXTURE_AGE_MS - 1)) : undefined
    ));

    expect(await sweepStaleFixtures(command, NOW)).toEqual(['container eow_cp1_postgres_abc']);
    expect(command).toHaveBeenCalledWith('docker', ['rm', '-f', '-v', 'eow_cp1_postgres_abc']);
  });

  it('leaves a fixture container that is still within a test lifetime', async () => {
    const command = dockerStub((args) => (
      args[0] === 'ps' ? ok(containerLine('eow_cp1_postgres_abc', NOW - STALE_FIXTURE_AGE_MS + 1_000)) : undefined
    ));

    expect(await sweepStaleFixtures(command, NOW)).toEqual([]);
    expect(command.mock.calls.some(([, args]) => args[0] === 'rm')).toBe(false);
  });

  it('leaves a fixture container whose age cannot be established', async () => {
    const command = dockerStub((args) => (args[0] === 'ps' ? ok('eow_cp1_postgres_abc\t\t') : undefined));

    expect(await sweepStaleFixtures(command, NOW)).toEqual([]);
    expect(command.mock.calls.some(([, args]) => args[0] === 'rm')).toBe(false);
  });

  it('removes a stale Compose project by its own project label', async () => {
    const project = 'eow_cp1_legacy_abc';
    const projectFilter = `label=${COMPOSE_PROJECT_LABEL}=${project}`;
    const command = dockerStub((args) => {
      if (args[0] === 'ps') {
        return args.includes(projectFilter)
          ? ok(`${project}-postgres-1`)
          : ok(containerLine(`${project}-postgres-1`, NOW - STALE_FIXTURE_AGE_MS - 1, project));
      }
      if (args[0] === 'volume' && args.includes(projectFilter)) return ok(`${project}_postgres_data`);
      if (args[0] === 'network' && args.includes(projectFilter)) return ok(`${project}_backend`);
      return undefined;
    });

    expect(await sweepStaleFixtures(command, NOW)).toEqual([
      `container ${project}-postgres-1`,
      `compose container ${project}-postgres-1`,
      `compose volume ${project}_postgres_data`,
      `compose network ${project}_backend`,
    ]);
    expect(command).toHaveBeenCalledWith('docker', ['volume', 'rm', `${project}_postgres_data`]);
    expect(command).toHaveBeenCalledWith('docker', ['network', 'rm', `${project}_backend`]);
  });

  /**
   * Networks are found by name, not by label, so the sweep also reaches orphans
   * from runs that predate the labels -- six of them, one to nine days old, were
   * on the machine this was written for. Docker refuses to remove a network a
   * container still attaches, which is what makes the missing age gate safe.
   */
  it('removes an orphaned fixture network, labelled or not', async () => {
    const command = dockerStub((args) => (
      args[0] === 'network' && args[1] === 'ls' ? ok('eow_cp1_runner_abc') : undefined
    ));

    expect(await sweepStaleFixtures(command, NOW)).toEqual(['network eow_cp1_runner_abc']);
    expect(command).toHaveBeenCalledWith('docker', [
      'network', 'ls', '--filter', 'name=^eow_cp1_', '--format', '{{.Name}}',
    ]);
  });

  it('leaves a fixture network that a container still attaches', async () => {
    const command = dockerStub((args) => {
      if (args[0] === 'network' && args[1] === 'ls') return ok('eow_cp1_runner_abc');
      if (args[0] === 'network' && args[1] === 'rm') return { exitCode: 1, stdout: '', stderr: 'network in use' };
      return undefined;
    });

    expect(await sweepStaleFixtures(command, NOW)).toEqual([]);
  });

  it('removes a Compose volume orphaned by a killed run', async () => {
    const command = dockerStub((args) => (
      args[0] === 'volume' && args[1] === 'ls'
        ? ok([
          'eow_cp1_legacy_abc_postgres_data\teow_cp1_legacy_abc',
          'email-operations-workspace_postgres_data\temail-operations-workspace',
        ].join('\n'))
        : undefined
    ));

    expect(await sweepStaleFixtures(command, NOW)).toEqual(['compose volume eow_cp1_legacy_abc_postgres_data']);
    // The workspace's own stack carries the same compose label and must survive.
    expect(command).not.toHaveBeenCalledWith('docker', [
      'volume', 'rm', 'email-operations-workspace_postgres_data',
    ]);
  });

  it('does nothing when the Docker daemon is unreachable', async () => {
    const failing = vi.fn(async (): Promise<CommandResult> => ({ exitCode: 1, stdout: '', stderr: 'daemon down' }));
    expect(await sweepStaleFixtures(failing, NOW)).toEqual([]);
    expect(failing).toHaveBeenCalledTimes(1);

    const missing = vi.fn(async (): Promise<CommandResult> => { throw new Error('spawn docker ENOENT'); });
    expect(await sweepStaleFixtures(missing, NOW)).toEqual([]);
  });

  /**
   * The rule this suite exists to hold. A developer machine that runs these
   * tests also hosts unrelated containers -- pgadmin, mariadb, the workspace's
   * own Compose stack -- and 49 GB of reclaimable garbage is exactly the
   * pressure that makes `docker system prune` look reasonable. Two properties
   * make that unnecessary: every listing is filtered to objects this suite owns,
   * and every object removed is named, with this suite's prefix in its name.
   */
  it('never lists or prunes Docker objects outside this suite', async () => {
    const project = 'eow_cp1_legacy_abc';
    const command = dockerStub((args) => {
      if (args[0] === 'ps') {
        return args.includes(`label=${FIXTURE_LABEL}=1`)
          ? ok([
            containerLine('eow_cp1_postgres_abc', NOW - STALE_FIXTURE_AGE_MS - 1),
            containerLine(`${project}-postgres-1`, NOW - STALE_FIXTURE_AGE_MS - 1, project),
          ].join('\n'))
          : ok(`${project}-postgres-1`);
      }
      if (args[0] === 'volume' && args[1] === 'ls') {
        return args.includes(`label=${COMPOSE_PROJECT_LABEL}`)
          ? ok(`${project}_postgres_data\t${project}`)
          : ok(`${project}_postgres_data`);
      }
      if (args[0] === 'network' && args[1] === 'ls') return ok(`${project}_backend`);
      return undefined;
    });

    await sweepStaleFixtures(command, NOW);

    const invocations = command.mock.calls.map(([, args]) => args);
    expect(invocations.some((args) => args.includes('prune') || args[0] === 'system')).toBe(false);

    const scopedFilters = [
      `label=${FIXTURE_LABEL}=1`,
      `label=${COMPOSE_PROJECT_LABEL}`,
      `label=${COMPOSE_PROJECT_LABEL}=${project}`,
      `name=^${FIXTURE_NAME_PREFIX}`,
    ];
    for (const args of invocations) {
      if (!args.includes('ls') && args[0] !== 'ps') continue;
      const filter = args[args.indexOf('--filter') + 1];
      expect(scopedFilters, `unscoped listing: docker ${args.join(' ')}`).toContain(filter);
    }

    const removals = invocations.filter((args) => args.includes('rm'));
    expect(removals.length).toBeGreaterThan(0);
    for (const args of removals) {
      const target = args[args.length - 1] ?? '';
      expect(target, `removal outside this suite: docker ${args.join(' ')}`).toMatch(
        new RegExp(`^${FIXTURE_NAME_PREFIX}`),
      );
    }
  });
});
