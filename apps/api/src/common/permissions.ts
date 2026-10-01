/**
 * Permission catalogue keys, mirroring the `permission.key` rows seeded by
 * database/migrations/004_rbac.sql. Grounded directly in BR-AUTH-003's
 * acceptance text: Admin manages configuration (SETTINGS_MANAGE), Operator
 * manages content and sending (CONTENT_MANAGE + CAMPAIGN_MANAGE), Viewer
 * only views history/reports (CAMPAIGN_READ + NOTIFICATION_READ).
 * SESSION_MANAGE covers managing one's own session (refresh/logout/profile)
 * and is granted to every role.
 */
export const PERMISSIONS = {
  SESSION_MANAGE: 'session:manage',
  CAMPAIGN_READ: 'campaign:read',
  CAMPAIGN_MANAGE: 'campaign:manage',
  /**
   * The right to *change* template content. Reading it is CONTENT_READ below:
   * mailcraft-integration-requirements.md §5.1 requires the editor to render a
   * read-only permission_denied state for a caller who lacks this key, which is
   * only possible if such a caller can still load the content.
   */
  CONTENT_MANAGE: 'content:manage',
  /**
   * View template content, versions and variables without the right to change
   * them. Seeded and granted to admin/operator/viewer by
   * database/migrations/073_content_read_permission.sql. Every non-mutating
   * template route accepts CONTENT_READ *or* CONTENT_MANAGE; every mutating one
   * still requires CONTENT_MANAGE alone.
   */
  CONTENT_READ: 'content:read',
  SETTINGS_MANAGE: 'settings:manage',
  NOTIFICATION_READ: 'notification:read',
  /**
   * M2-S1: recipients now have real CRUD, so they get their own read/manage
   * pair (matching campaign:read/campaign:manage's granularity) instead of
   * staying bucketed under the coarser content:manage used at M1-S2 before
   * any recipient screen/API existed. Seeded/granted by
   * database/migrations/006_recipient_extensions.sql (admin + operator).
   */
  RECIPIENT_READ: 'recipient:read',
  RECIPIENT_MANAGE: 'recipient:manage',
  /**
   * M6-S3 (BR-HIS-007, DEC-135): the viewer already holds CAMPAIGN_READ,
   * which is what BR-HIS-007 says must NOT be sufficient to export
   * recipient-level PII in bulk -- no existing key carries that distinction.
   * Seeded/granted to admin + operator explicitly by
   * database/migrations/029_history_recovery.sql (admin's blanket seed-time
   * grant in 004_rbac.sql does not retroactively cover a key added later).
   */
  HISTORY_EXPORT: 'history:export',
  /** M7-S2 / BR-SEC-007: admin-only DLQ inspection and replay. */
  DLQ_MANAGE: 'dlq:manage',
} as const;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];
