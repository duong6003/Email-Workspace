import { AsyncLocalStorage } from 'node:async_hooks';

export type RequestContext = {
  traceId: string;
  tenantId: string | null;
  actorId?: string | null;
  module?: string;
  campaignId?: string | null;
};

const requestContext = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(context: RequestContext, work: () => T): T {
  return requestContext.run(context, work);
}

export function getRequestContext(): RequestContext | undefined {
  return requestContext.getStore();
}

export function updateRequestContext(values: Partial<RequestContext>): void {
  const context = requestContext.getStore();
  if (context) Object.assign(context, values);
}
