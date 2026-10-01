import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { read } from './repo.js';

/**
 * ARCH-DEPLOY-CONTRACT.
 *
 * AGENTS.md §2 requires runtime dependencies, ports, environment variables,
 * startup and health/readiness changes to preserve the one-command deployment
 * contract across Compose, the environment example, CI and deployment docs.
 * D-156 proved prose was insufficient: CI left one required blank secret
 * unfilled and its final Compose validation could never pass.
 */
const COMPOSE_VARIABLE = /(?<!\$)\$\{([A-Z0-9_]+)/g;
const REQUIRED_COMPOSE_VARIABLE = /(?<!\$)\$\{([A-Z0-9_]+):\?/g;
const ENV_KEY = /^([A-Z0-9_]+)=/gm;
const REQUIRED_DOC_ROW = /^\| `([A-Z0-9_]+)` \| Yes \|/gm;
const CI_SED_FILL = /sed -i ['"][^'"\n]*\^([A-Z0-9_]+)=\$\//g;

function matches(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)].map((match) => match[1]);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function composeServices(source: string): Map<string, string> {
  const lines = source.split(/\r?\n/);
  const services = new Map<string, string>();
  let currentName: string | undefined;
  let current: string[] = [];

  for (const line of lines.slice(1)) {
    const service = line.match(/^  ([a-z][a-z0-9_-]*):\s*$/);
    if (service) {
      if (currentName) services.set(currentName, current.join('\n'));
      currentName = service[1];
      current = [line];
      continue;
    }
    if (currentName && /^\S/.test(line)) break;
    if (currentName) current.push(line);
  }
  if (currentName) services.set(currentName, current.join('\n'));
  return services;
}

const HEALTHCHECK_ALLOWLIST: ReadonlyArray<{ service: string; reason: string }> = [
  {
    service: 'mailpit',
    reason: 'development-only mail sink; application readiness and production delivery do not depend on its UI health',
  },
  {
    service: 'migrate',
    reason: "one-shot schema verifier with restart: 'no'; downstream services gate on service_completed_successfully instead",
  },
];

describe('ARCH-DEPLOY-CONTRACT: Compose, env, CI and docs stay aligned', () => {
  const compose = read('compose.yaml');
  const envExample = read('.env.deploy.example');
  const environmentDocs = read('docs/deployment/environment-variables.md');
  const ci = read('.github/workflows/ci.yml');

  it('documents every environment variable referenced by Compose in the deploy example', () => {
    const referenced = unique(matches(compose, COMPOSE_VARIABLE));
    const declared = new Set(matches(envExample, ENV_KEY));
    const missing = referenced.filter((variable) => !declared.has(variable));
    expect(missing, `Compose variables missing from .env.deploy.example: ${missing.join(', ')}`).toEqual([]);
  });

  it('keeps required Compose variables and Required: Yes documentation identical', () => {
    const requiredByCompose = unique(matches(compose, REQUIRED_COMPOSE_VARIABLE));
    const requiredByDocs = unique(matches(environmentDocs, REQUIRED_DOC_ROW));
    expect(requiredByDocs, 'Required: Yes documentation differs from Compose ${VAR:?} requirements').toEqual(requiredByCompose);
  });

  it('fills every required blank deploy-example variable before CI validates Compose', () => {
    const blank = new Set(
      envExample
        .split(/\r?\n/)
        .map((line) => line.match(/^([A-Z0-9_]+)=$/)?.[1])
        .filter((variable): variable is string => Boolean(variable)),
    );
    const requiredBlank = unique(matches(compose, REQUIRED_COMPOSE_VARIABLE)).filter((variable) => blank.has(variable));
    const filled = new Set(matches(ci, CI_SED_FILL));
    const missing = requiredBlank.filter((variable) => !filled.has(variable));
    expect(missing, `CI does not fill required blank deployment variables: ${missing.join(', ')}`).toEqual([]);
  });

  it('gives every long-running service a healthcheck or a reasoned allowlist entry', () => {
    const services = composeServices(compose);
    const allowlisted = new Set(HEALTHCHECK_ALLOWLIST.map((entry) => entry.service));
    const violations = [...services.entries()]
      .filter(([service, body]) => !body.includes('healthcheck:') && !allowlisted.has(service))
      .map(([service]) => service);

    expect(violations, `Long-running Compose services without healthchecks: ${violations.join(', ')}`).toEqual([]);
    for (const entry of HEALTHCHECK_ALLOWLIST) {
      expect(services.has(entry.service), `${entry.service} allowlist entry no longer names a Compose service`).toBe(true);
      expect(entry.reason.length, `${entry.service} healthcheck exception has no written reason`).toBeGreaterThan(50);
    }
  });

  /**
   * A healthcheck exists so `depends_on: service_healthy` means something. One
   * that probes a path the dependents never use is worse than none: it reports
   * ready early and the gate opens on a server that still refuses them.
   *
   * PostgreSQL's official entrypoint does exactly this on first start. It runs a
   * temporary server for initdb with `listen_addresses=''` -- local socket only,
   * no network -- then stops it and starts the real one. `pg_isready` with no
   * host argument talks to that socket, so it answers "accepting connections"
   * during a phase when every TCP client is still refused.
   *
   * Measured on `postgres:17-alpine`, sampling both probes every 100 ms:
   *
   *   tick 46  socket=OK  tcp=no
   *   tick 47  socket=OK  tcp=no
   *   tick 48  socket=OK  tcp=no
   *
   * Three consecutive ticks where the healthcheck says healthy and the network
   * says no. `migrate`, `api`, `worker` and `scheduler` all reach PostgreSQL over
   * the network, so all four can be released into that window. It surfaced
   * 2026-09-04 as `migration-runner-behavior.test.ts` failing with `psql: FATAL:
   * the database system is starting up` immediately after Compose had reported
   * `postgres-1 Healthy` -- but the same window exists on a real deployment, and
   * `migration-runner-behavior.test.ts:573` had already written the rule down for
   * its own non-Compose harness without the Compose path inheriting it.
   *
   * Forcing the probe onto TCP closes it: the temporary server is not listening
   * there, so the healthcheck cannot pass until the real server is.
   */
  it('probes a database healthcheck over the network its dependents actually use', () => {
    // Parsed, not string-matched: the explanation above this rule in compose.yaml
    // names `pg_isready` too, and a line scan reads the comment rather than the
    // command -- which is precisely the "green gate that checks prose" failure
    // this suite exists to prevent.
    const document = load(compose) as { services: Record<string, { healthcheck?: { test?: string[] | string } }> };
    const test = document.services.postgres?.healthcheck?.test;
    const command = (Array.isArray(test) ? test.join(' ') : test) ?? '';

    expect(command, 'the postgres service has no pg_isready healthcheck to judge').toContain('pg_isready');
    expect(
      /\bpg_isready\b.*\s-h\s+\S/.test(command),
      'pg_isready without -h probes the local socket, which answers during initdb while TCP is still refused. Give it a host so the check fails until the network path is up.',
    ).toBe(true);
  });

  /**
   * A service with no `profiles:` starts on a production bring-up -- `docker
   * compose up`, no `--profile`. If such a service `depends_on` one that exists
   * only inside a profile, Compose rejects the entire project before starting
   * anything: `service "api" depends on undefined service "minio-init": invalid
   * compose project`.
   *
   * This is not hypothetical. ADR-043 added `minio-init` behind `profiles: [dev]`
   * and had `api` gate on it. Every gate above stayed green, because dev runs
   * with `--profile dev` and the only path that breaks is the production one
   * nothing in this suite was exercising. CI's `docker compose config` step
   * would have caught it -- but only after `pnpm check` had already passed, so
   * the failure surfaced a whole pipeline late. Measured 2026-09-03.
   */
  it('never lets an unprofiled service depend on one that exists only inside a profile', () => {
    const document = load(compose) as { services: Record<string, { profiles?: string[]; depends_on?: Record<string, unknown> | string[] }> };
    const profiled = new Set(Object.entries(document.services).filter(([, body]) => (body.profiles ?? []).length > 0).map(([name]) => name));
    const violations: string[] = [];

    for (const [name, body] of Object.entries(document.services)) {
      if (profiled.has(name)) continue;
      const dependencies = Array.isArray(body.depends_on) ? body.depends_on : Object.keys(body.depends_on ?? {});
      for (const dependency of dependencies) {
        if (profiled.has(dependency)) violations.push(`${name} -> ${dependency}`);
      }
    }

    expect(violations, `A production bring-up cannot resolve these dependencies: ${violations.join(', ')}`).toEqual([]);
  });
});
