import { describe, expect, it } from 'vitest';
import { getRequestContext, runWithRequestContext, updateRequestContext } from './request-context.js';

describe('request context', () => {
  it('BR-SEND-013: isolates concurrent trace and tenant contexts', async () => {
    const seen = await Promise.all([
      runWithRequestContext({ traceId: 'trace-a', tenantId: 'tenant-a' }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return getRequestContext();
      }),
      runWithRequestContext({ traceId: 'trace-b', tenantId: 'tenant-b' }, async () => getRequestContext()),
    ]);

    expect(seen).toEqual([
      expect.objectContaining({ traceId: 'trace-a', tenantId: 'tenant-a' }),
      expect.objectContaining({ traceId: 'trace-b', tenantId: 'tenant-b' }),
    ]);
  });

  it('mutates the current context when authentication resolves', () => {
    runWithRequestContext({ traceId: 'trace-1', tenantId: null }, () => {
      updateRequestContext({ tenantId: 'tenant-1', actorId: 'actor-1' });
      expect(getRequestContext()).toEqual(expect.objectContaining({
        traceId: 'trace-1', tenantId: 'tenant-1', actorId: 'actor-1',
      }));
    });
  });
});
