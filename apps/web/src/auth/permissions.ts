import type { components } from '@eow/contracts';

export type PermissionKey = components['schemas']['Me']['permissions'][number];

/**
 * BR-AUTH-003/004: permission keys mirror
 * apps/api/src/common/permissions.ts exactly (the seeded permission.key
 * rows from database/migrations/004_rbac.sql). The frontend only ever uses
 * these to decide what to *show* (nav items, route content) — every
 * operation they gate is independently enforced server-side by
 * PermissionGuard regardless of what the client renders.
 */
export const PERMISSIONS = {
  SESSION_MANAGE: 'session:manage',
  CAMPAIGN_READ: 'campaign:read',
  CAMPAIGN_MANAGE: 'campaign:manage',
  CONTENT_MANAGE: 'content:manage',
  /**
   * Viewing template content without the right to change it
   * (database/migrations/073_content_read_permission.sql; admin, operator and
   * viewer all hold it). This is what makes the template editor's read-only
   * permission_denied state reachable at all -- see
   * docs/frontend/mailcraft-integration-requirements.md §5.1. Screens gate
   * *editing* on CONTENT_MANAGE and reaching the screen on CONTENT_READ.
   */
  CONTENT_READ: 'content:read',
  SETTINGS_MANAGE: 'settings:manage',
  NOTIFICATION_READ: 'notification:read',
  /** M6-S3 (BR-HIS-007, DEC-135): viewer holds CAMPAIGN_READ but not this -- gates the export button/route independently. */
  HISTORY_EXPORT: 'history:export',
} as const;

export function hasPermission(granted: readonly string[] | undefined, required: string | string[]): boolean {
  if (!granted) return false;
  const requiredList = Array.isArray(required) ? required : [required];
  if (requiredList.length === 0) return true;
  return requiredList.some((key) => granted.includes(key));
}
