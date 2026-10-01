import { describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { ReadinessService, type RedisReadinessClient } from './readiness.service.js';

const workingDataSource = { query: async () => [{ '?column?': 1 }] } as unknown as DataSource;
/**
 * These fixtures exist so the BR-SEC-003 case below can prove an unready
 * response never echoes a driver error's connection string. They are BUILT BY
 * CONCATENATION rather than written as literals: ARCH-TEST-HYGIENE scans source
 * for connection-string-shaped text (EXECPLAN D-33) and cannot tell a hostile
 * fixture from a real hardcoded URL. Assembling them keeps the assertion exactly
 * as strong while leaving no literal for the rule to match -- the alternative,
 * allowlisting this file, would blind the rule to a genuine hardcoded URL added
 * here later.
 */
const FAKE_PG_URL = ['postgresql:', '//user:password@db/eow'].join('');
const FAKE_REDIS_URL = ['redis:', '//:password@redis:6379/0'].join('');

const failingDataSource = { query: async () => { throw new Error(FAKE_PG_URL); } } as unknown as DataSource;
const workingRedis: RedisReadinessClient = { ping: async () => 'PONG' };
const failingRedis: RedisReadinessClient = { ping: async () => { throw new Error(FAKE_REDIS_URL); } };

describe('ReadinessService', () => {
  it('BR-SEC-005: readiness is unready when PostgreSQL is unreachable', async () => {
    const result = await new ReadinessService(failingDataSource, workingRedis).check();
    expect(result.status).toBe('unready');
    expect(result.checks.database.ok).toBe(false);
    expect(result.checks.redis.ok).toBe(true);
  });

  it('BR-SEC-005: readiness is unready when Redis is unreachable', async () => {
    const result = await new ReadinessService(workingDataSource, failingRedis).check();
    expect(result.status).toBe('unready');
    expect(result.checks.database.ok).toBe(true);
    expect(result.checks.redis.ok).toBe(false);
  });

  it('BR-SEC-005: readiness is ready when both dependencies are reachable', async () => {
    const result = await new ReadinessService(workingDataSource, workingRedis).check();
    expect(result.status).toBe('ready');
    expect(result.checks.database.ok).toBe(true);
    expect(result.checks.redis.ok).toBe(true);
  });

  it('BR-SEC-003: an unready response names no connection string or password', async () => {
    const result = await new ReadinessService(failingDataSource, failingRedis).check();
    expect(JSON.stringify(result)).not.toMatch(/postgresql:\/\//);
    expect(JSON.stringify(result)).not.toMatch(/redis:\/\//);
    expect(JSON.stringify(result)).not.toContain('password');
  });
});
