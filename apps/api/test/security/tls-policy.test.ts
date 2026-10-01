import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { originRequiresSecureCookies } from '../../src/auth/cookies.js';
import { hashPassword } from '../../src/auth/password.service.js';
import { AppUserEntity } from '../../src/database/entities/app-user.entity.js';
import { TenantEntity } from '../../src/database/entities/tenant.entity.js';
import { UserSessionEntity } from '../../src/database/entities/user-session.entity.js';
import { testDatabaseUrl } from '../integration/test-database-url.js';
import { testRedisUrl } from '../integration/test-redis-url.js';

describe('M7-S2 TLS policy (BR-SEC-001)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let tenant: TenantEntity;
  const email = `tls-policy-${randomUUID()}@test.dev`;
  const password = 'correct-horse-battery-staple';

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl();
    process.env.REDIS_URL = testRedisUrl();
    process.env.SESSION_SECRET = 'm7-s2-tls-policy-session-secret'.repeat(2);
    process.env.WEB_ORIGIN = 'https://app.example.test';
    const { AppModule } = await import('../../src/app.module.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    await app.init();
    dataSource = moduleRef.get(getDataSourceToken());
    tenant = await dataSource.getRepository(TenantEntity).save({ name: `tls-policy-${randomUUID()}` });
    await dataSource.getRepository(AppUserEntity).save({
      tenantId: tenant.id, email, displayName: 'TLS Policy Admin', role: 'admin',
      passwordHash: await hashPassword(password), status: 'active',
    });
  }, 30_000);

  afterAll(async () => {
    if (!dataSource) return app?.close();
    await dataSource.getRepository(UserSessionEntity).delete({ tenantId: tenant.id });
    await dataSource.getRepository(AppUserEntity).delete({ tenantId: tenant.id });
    await app.close();
  });

  it('cookies become Secure exactly when the configured origin is https', () => {
    expect(originRequiresSecureCookies('https://app.example.test')).toBe(true);
    expect(originRequiresSecureCookies('http://localhost:8080')).toBe(false);
    expect(originRequiresSecureCookies(undefined)).toBe(false);
  });

  it('the session cookie is Secure, HttpOnly and SameSite=Lax on an HTTPS-origin login', async () => {
    const response = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password }).expect(204);
    const cookies = response.headers['set-cookie'] as unknown as string[];
    const session = cookies.find((entry) => entry.startsWith('eow_session='));
    expect(session).toMatch(/Secure/i);
    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/SameSite=Lax/i);
  });

  it('the written policy declares TLS 1.2 minimum, TLS 1.3 preferred, and edge termination', () => {
    const policy = readFileSync(resolve(process.cwd(), '../../docs/operations/security-baseline.md'), 'utf8');
    expect(policy).toContain('TLS 1.2');
    expect(policy).toContain('TLS 1.3');
    expect(policy).toContain('managed edge');
    expect(policy).toContain('X-Forwarded-Proto');
  });
});
