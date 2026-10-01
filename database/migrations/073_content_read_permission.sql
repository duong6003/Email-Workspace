-- Template authoring gains a read/write split: `content:read` (view template
-- content) alongside the existing `content:manage` (change it).
--
-- Why: docs/frontend/mailcraft-integration-requirements.md §5.1, sourced from
-- design-reference/ui-source-contract.yaml → required_states, requires the
-- template editor to render `permission_denied` as a *read-only editor with an
-- explanation* -- "khong phai man hinh trang hay loi 403 tho". That state was
-- unbuildable before this migration: every template route, reads included,
-- required `content:manage`, so a role without it could not fetch the content
-- there would be to show read-only. §5.1's own wording is the model this
-- encodes -- "quyen content:manage quyet dinh ai duoc SUA noi dung" -- which
-- makes content:manage an edit right, not a visibility right.
--
-- This widens the Viewer beyond BR-AUTH-003's literal "chi xem lich su va bao
-- cao" to also browse (never change) template content. That reinterpretation is
-- deliberate and is the decision §5.1 forces; the integration doc's own header
-- flags the §1 constraints as "co the mo". Viewer stays read-only everywhere:
-- every mutating template route keeps requiring content:manage alone.
INSERT INTO permission (key, description) VALUES
  ('content:read', 'View email template content, versions and variables without the right to change them')
ON CONFLICT (key) DO NOTHING;

-- All three roles explicitly. Admin's blanket grant in 004_rbac.sql was a
-- seed-time cross join over the permission table as it stood then, so it does
-- not retroactively cover a key introduced later -- the same trap
-- 029_history_recovery.sql documented for history:export.
INSERT INTO role_permission (role_id, permission_id)
SELECT r.id, p.id FROM role r, permission p
WHERE r.key IN ('admin', 'operator', 'viewer') AND p.key = 'content:read'
ON CONFLICT DO NOTHING;
