import { ForbiddenException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionGuard } from './permission.guard.js';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator.js';
import { REQUIRED_PERMISSION_KEY } from '../decorators/require-permission.decorator.js';

/**
 * Pure unit tests for the guard's decision logic (public bypass,
 * deny-by-default when no @RequirePermission is declared, allow/deny by
 * membership in request.auth.permissions). Audit-log side effects are
 * covered by the real-Postgres RBAC integration test
 * (apps/api/test/integration/rbac-matrix.test.ts), not here.
 */
function makeContext(opts: { auth?: { userId: string; tenantId: string; role: string; permissions: string[] }; method?: string; path?: string }): ExecutionContext {
  const request = {
    auth: opts.auth,
    method: opts.method ?? 'GET',
    path: opts.path ?? '/campaigns/1/progress',
    route: { path: opts.path ?? '/campaigns/1/progress' },
    headers: {},
  };
  return {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({}) }),
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
  } as unknown as ExecutionContext;
}

function makeReflector(metadata: { isPublic?: boolean; requiredPermission?: string[] }): Reflector {
  return {
    getAllAndOverride: (key: string) => {
      if (key === IS_PUBLIC_KEY) return metadata.isPublic;
      if (key === REQUIRED_PERMISSION_KEY) return metadata.requiredPermission;
      return undefined;
    },
  } as unknown as Reflector;
}

function makeDataSource() {
  const save = vi.fn().mockResolvedValue(undefined);
  const manager = {
    getRepository: vi.fn().mockReturnValue({ save }),
    save,
    query: vi.fn().mockResolvedValue(undefined),
  };
  return {
    manager,
    transaction: vi.fn(async (work: (transactionManager: unknown) => Promise<unknown>) => work(manager)),
    _save: save,
  };
}

describe('PermissionGuard', () => {
  let dataSource: ReturnType<typeof makeDataSource>;

  beforeEach(() => {
    dataSource = makeDataSource();
  });

  it('allows a @Public() route with no auth context at all', async () => {
    const guard = new PermissionGuard(makeReflector({ isPublic: true }), dataSource as never);
    const context = makeContext({});

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('denies (deny-by-default) when the route declares no @RequirePermission at all', async () => {
    const guard = new PermissionGuard(makeReflector({ isPublic: false, requiredPermission: undefined }), dataSource as never);
    const context = makeContext({ auth: { userId: 'u1', tenantId: 't1', role: 'admin', permissions: ['campaign:manage'] } });

    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
  });

  it('denies when the authenticated user lacks the required permission', async () => {
    const guard = new PermissionGuard(makeReflector({ isPublic: false, requiredPermission: ['campaign:manage'] }), dataSource as never);
    const context = makeContext({ auth: { userId: 'viewer-1', tenantId: 't1', role: 'viewer', permissions: ['campaign:read', 'notification:read', 'session:manage'] } });

    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
  });

  it('writes an rbac.denied audit row (actor + endpoint) when denying', async () => {
    const guard = new PermissionGuard(makeReflector({ isPublic: false, requiredPermission: ['campaign:manage'] }), dataSource as never);
    const context = makeContext({ auth: { userId: 'viewer-1', tenantId: 't1', role: 'viewer', permissions: ['campaign:read'] }, method: 'POST', path: '/campaigns/1/send' });

    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);

    expect(dataSource._save).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 't1',
        actorId: 'viewer-1',
        action: 'rbac.denied',
      }),
    );
    const savedRow = dataSource._save.mock.calls[0][0];
    expect(savedRow.metadata.endpoint).toBe('POST /campaigns/1/send');
  });

  it('allows when the authenticated user holds the required permission', async () => {
    const guard = new PermissionGuard(makeReflector({ isPublic: false, requiredPermission: ['campaign:manage'] }), dataSource as never);
    const context = makeContext({ auth: { userId: 'op-1', tenantId: 't1', role: 'operator', permissions: ['campaign:manage', 'campaign:read'] } });

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('allows when the user holds at least one of several acceptable permissions', async () => {
    const guard = new PermissionGuard(makeReflector({ isPublic: false, requiredPermission: ['campaign:manage', 'settings:manage'] }), dataSource as never);
    const context = makeContext({ auth: { userId: 'admin-1', tenantId: 't1', role: 'admin', permissions: ['settings:manage'] } });

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });
});
