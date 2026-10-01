import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

/**
 * Resolves a user's effective permission set through
 * user_role -> role_permission -> permission (BR-AUTH-003/004). Used by
 * AuthGuard to populate request.auth.permissions on every authenticated
 * request, and by GET /auth/me to expose the caller's permission list to
 * the frontend for nav/route gating.
 *
 * If a user has one or more explicit user_role rows, those are
 * authoritative. If a user has none at all (e.g. created after
 * 004_rbac.sql without going through an explicit role-assignment step —
 * there is no such API endpoint yet, so every existing user-creation path,
 * including the M1-S1 login/seed fixtures, only ever sets the legacy
 * app_user.role text column), the legacy role text is used as a one-time
 * fallback lookup against the same role_permission catalogue. This keeps
 * every existing user meaningfully permissioned without silently granting
 * or denying everything, and without requiring every user-creation call
 * site to also insert into user_role.
 */
@Injectable()
export class PermissionsService {
  async getPermissionsForUser(manager: EntityManager, userId: string): Promise<string[]> {
    const rows: Array<{ key: string }> = await manager.query(
      `WITH effective_roles AS (
         SELECT role_id FROM user_role WHERE user_id = $1
         UNION
         SELECT r.id
         FROM app_user u
         JOIN role r ON r.key = u.role
         WHERE u.id = $1 AND NOT EXISTS (SELECT 1 FROM user_role WHERE user_id = $1)
       )
       SELECT DISTINCT p.key AS key
       FROM effective_roles er
       JOIN role_permission rp ON rp.role_id = er.role_id
       JOIN permission p ON p.id = rp.permission_id
       ORDER BY p.key`,
      [userId],
    );
    return rows.map((row) => row.key);
  }
}
