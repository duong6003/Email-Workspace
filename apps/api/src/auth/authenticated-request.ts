import type { Request } from 'express';

export type AuthContext = {
  userId: string;
  tenantId: string;
  role: string;
  sessionId: string;
  permissions: string[];
};

export type AuthenticatedRequest = Request & { auth?: AuthContext };
