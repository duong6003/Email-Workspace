import { firstValueFrom, of, throwError } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditInterceptor } from './audit.interceptor.js';
import { AUDIT_LOG_KEY, type AuditLogMetadata } from '../decorators/audit-log.decorator.js';

/**
 * Pure unit tests for the interceptor's decision logic and error handling,
 * mirroring permission.guard.test.ts's mocked-Reflector/DataSource style.
 * The real-Postgres proof that a decorated route's audit row lands with the
 * same traceId a 401/403 Problem response carries lives in
 * apps/api/test/integration/auth-http.test.ts (M1-S3 addition).
 */
function makeContext(opts: { auth?: { userId: string; tenantId: string; role: string; permissions: string[] }; traceId?: string; params?: Record<string, string> }): ExecutionContext {
  const request = {
    auth: opts.auth,
    params: opts.params ?? {},
    headers: opts.traceId ? { 'x-trace-id': opts.traceId } : {},
  };
  return {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({}) }),
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
  } as unknown as ExecutionContext;
}

function makeReflector(metadata: AuditLogMetadata | undefined): Reflector {
  return {
    getAllAndOverride: (key: string) => (key === AUDIT_LOG_KEY ? metadata : undefined),
  } as unknown as Reflector;
}

function makeDataSource() {
  const save = vi.fn().mockResolvedValue(undefined);
  const manager = { getRepository: vi.fn().mockReturnValue({ save }), query: vi.fn().mockResolvedValue(undefined) };
  return {
    manager,
    transaction: vi.fn(async (work: (transactionManager: unknown) => Promise<unknown>) => work(manager)),
    _save: save,
  };
}

function handlerReturning(value: unknown): CallHandler {
  return { handle: () => of(value) };
}

function handlerThrowing(error: unknown): CallHandler {
  return { handle: () => throwError(() => error) };
}

describe('AuditInterceptor', () => {
  let dataSource: ReturnType<typeof makeDataSource>;

  beforeEach(() => {
    dataSource = makeDataSource();
  });

  it('passes an undecorated route straight through without writing an audit row', async () => {
    const interceptor = new AuditInterceptor(makeReflector(undefined), dataSource as never);
    const context = makeContext({ auth: { userId: 'u1', tenantId: 't1', role: 'admin', permissions: [] } });

    const result = await firstValueFrom(interceptor.intercept(context, handlerReturning({ ok: true })));

    expect(result).toEqual({ ok: true });
    expect(dataSource._save).not.toHaveBeenCalled();
  });

  it('writes an audit_log row on success, keyed by the actor/tenant and the request trace id', async () => {
    const metadata: AuditLogMetadata = { action: 'auth.logout', entityType: 'user_session', resolveEntityId: ({ request }) => (request.auth as { sessionId?: string })?.sessionId ?? null };
    const interceptor = new AuditInterceptor(makeReflector(metadata), dataSource as never);
    const context = makeContext({ auth: { userId: 'u1', tenantId: 't1', role: 'admin', permissions: [] }, traceId: 'trace-abc' });
    // sessionId is read off request.auth by resolveEntityId in this fake -- attach it directly.
    (context.switchToHttp().getRequest() as { auth: { sessionId?: string } }).auth.sessionId = 'sess-1';

    await firstValueFrom(interceptor.intercept(context, handlerReturning(undefined)));

    expect(dataSource._save).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 't1',
        actorId: 'u1',
        action: 'auth.logout',
        entityType: 'user_session',
        entityId: 'sess-1',
        traceId: 'trace-abc',
      }),
    );
  });

  it('does not write when the route is decorated but the request has no authenticated actor (public route)', async () => {
    const metadata: AuditLogMetadata = { action: 'auth.forgot_password', entityType: 'app_user' };
    const interceptor = new AuditInterceptor(makeReflector(metadata), dataSource as never);
    const context = makeContext({});

    await firstValueFrom(interceptor.intercept(context, handlerReturning(undefined)));

    expect(dataSource._save).not.toHaveBeenCalled();
  });

  it('writes a `<action>.failed` audit row when the handler throws, then rethrows the original error unchanged', async () => {
    const metadata: AuditLogMetadata = { action: 'auth.session_refreshed', entityType: 'user_session' };
    const interceptor = new AuditInterceptor(makeReflector(metadata), dataSource as never);
    const context = makeContext({ auth: { userId: 'u1', tenantId: 't1', role: 'admin', permissions: [] }, traceId: 'trace-fail' });
    const originalError = new Error('boom');

    await expect(firstValueFrom(interceptor.intercept(context, handlerThrowing(originalError)))).rejects.toBe(originalError);

    expect(dataSource._save).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 't1',
        actorId: 'u1',
        action: 'auth.session_refreshed.failed',
        entityType: 'user_session',
        traceId: 'trace-fail',
      }),
    );
  });

  it('resolves entityId to null when resolveEntityId is omitted', async () => {
    const metadata: AuditLogMetadata = { action: 'auth.session_refreshed', entityType: 'user_session' };
    const interceptor = new AuditInterceptor(makeReflector(metadata), dataSource as never);
    const context = makeContext({ auth: { userId: 'u1', tenantId: 't1', role: 'admin', permissions: [] } });

    await firstValueFrom(interceptor.intercept(context, handlerReturning(undefined)));

    expect(dataSource._save).toHaveBeenCalledWith(expect.objectContaining({ entityId: null }));
  });
});
