-- Forward migration for M1-S2 (Roles and access). Never edits 001, 002 or 003.
--
-- BR-AUTH-003: the system has at minimum Admin, Operator and Viewer roles;
-- Admin administers configuration, Operator manages content and sending,
-- Viewer only views history/reports.
-- BR-AUTH-004: authorization is enforced server-side (this migration lands
-- the data model the PermissionGuard reads at request time; server-side
-- enforcement itself is apps/api/src/common/guards/permission.guard.ts).
--
-- `role` and `permission` are global reference catalogues (not tenant-owned
-- -- they describe the system's fixed capability model, matching "he thong
-- co toi thieu Admin, Operator va Viewer"). `user_role` is tenant-owned
-- (every row carries tenant_id per AGENTS.md domain invariants) because it
-- links a specific tenant's user to a role.
--
-- Data migration: app_user.role has been a free-text column since
-- 001_initial.sql (values observed in this codebase: 'admin', 'operator';
-- 'viewer' is introduced by this slice). Every existing app_user row is
-- backfilled into user_role. A role value that does not match a seeded role
-- key is mapped to 'viewer' (least-privilege default) rather than silently
-- dropped, so no user is left without an RBAC row. Each backfilled row also
-- gets a matching audit_log entry (action=rbac.role_assigned) so the
-- migration itself is traceable, without inventing a new API endpoint for
-- something that is, here, a one-time data migration.

CREATE TABLE role (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  name text NOT NULL,
  description text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE permission (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  description text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE role_permission (
  role_id uuid NOT NULL REFERENCES role(id) ON DELETE CASCADE,
  permission_id uuid NOT NULL REFERENCES permission(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE user_role (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  user_id uuid NOT NULL REFERENCES app_user(id),
  role_id uuid NOT NULL REFERENCES role(id),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, role_id)
);
CREATE INDEX idx_user_role_user ON user_role (tenant_id, user_id);

-- Seed the fixed role catalogue (BR-AUTH-003).
INSERT INTO role (key, name, description) VALUES
  ('admin', 'Admin', 'Quan tri cau hinh he thong (Admin administers configuration)'),
  ('operator', 'Operator', 'Quan ly noi dung va gui email (Operator manages content and sending)'),
  ('viewer', 'Viewer', 'Chi xem lich su va bao cao (Viewer only views history/reports)');

-- Seed the permission catalogue. Keys are colon-namespaced
-- (resource:capability) and are what apps/api's @RequirePermission()
-- decorator and apps/web's route/nav guards check against.
INSERT INTO permission (key, description) VALUES
  ('session:manage', 'Manage own session: refresh, logout, view own profile'),
  ('campaign:read', 'View campaign progress and send history'),
  ('campaign:manage', 'Schedule, send and cancel campaigns'),
  ('content:manage', 'Manage recipients, templates and compose email content'),
  ('settings:manage', 'Manage sender accounts and workspace configuration'),
  ('notification:read', 'View and acknowledge notifications');

-- Role -> permission grants.
INSERT INTO role_permission (role_id, permission_id)
SELECT r.id, p.id FROM role r, permission p
WHERE r.key = 'admin';

INSERT INTO role_permission (role_id, permission_id)
SELECT r.id, p.id FROM role r, permission p
WHERE r.key = 'operator'
  AND p.key IN ('session:manage', 'campaign:read', 'campaign:manage', 'content:manage', 'notification:read');

INSERT INTO role_permission (role_id, permission_id)
SELECT r.id, p.id FROM role r, permission p
WHERE r.key = 'viewer'
  AND p.key IN ('session:manage', 'campaign:read', 'notification:read');

-- Data migration: backfill every existing app_user into user_role from its
-- free-text role column. Unrecognised values fall back to 'viewer' (least
-- privilege) instead of being dropped.
INSERT INTO user_role (tenant_id, user_id, role_id, assigned_at)
SELECT u.tenant_id, u.id, COALESCE(matched.id, viewer.id), now()
FROM app_user u
LEFT JOIN role matched ON matched.key = u.role
CROSS JOIN (SELECT id FROM role WHERE key = 'viewer') AS viewer
ON CONFLICT (user_id, role_id) DO NOTHING;

INSERT INTO audit_log (tenant_id, actor_id, action, entity_type, entity_id, trace_id, metadata, occurred_at)
SELECT u.tenant_id, NULL, 'rbac.role_assigned', 'app_user', u.id, 'migration:004_rbac',
       jsonb_build_object('role', COALESCE(matched.key, 'viewer'), 'source', 'migration_backfill'), now()
FROM app_user u
LEFT JOIN role matched ON matched.key = u.role;
