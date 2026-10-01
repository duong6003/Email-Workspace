import { useNavigate } from 'react-router-dom';

export type SettingsTabKey = 'senders' | 'policy' | 'custom-fields' | 'global-variables';

const SETTINGS_TABS: ReadonlyArray<{ key: SettingsTabKey; label: string; path: string }> = [
  { key: 'senders', label: 'Cấu hình gửi', path: '/settings/senders' },
  { key: 'policy', label: 'Chính sách gửi mặc định', path: '/settings/policy' },
  { key: 'custom-fields', label: 'Dữ liệu người nhận', path: '/settings/custom-fields' },
  { key: 'global-variables', label: 'Biến dùng chung', path: '/settings/global-variables' },
];

/**
 * Shared tab strip for the consolidated "Cấu hình" nav entry (see
 * docs/superpowers/specs/2026-08-25-settings-nav-consolidation-design.md).
 * Every non-active tab is a <button onClick={navigate}> rather than a real
 * link: .settings-tabs/.workspace-tabs CSS in globals.css only styles
 * `button` children, matching how every other tab/pill control in this
 * codebase already works.
 */
export function SettingsTabs({ active, counts }: { active: SettingsTabKey; counts?: Partial<Record<SettingsTabKey, number>> }) {
  const navigate = useNavigate();
  return <div className="settings-tabs workspace-tabs">
    {SETTINGS_TABS.map((tab) => {
      const count = counts?.[tab.key];
      const label = <>{tab.label}{count !== undefined && <span>{count}</span>}</>;
      return tab.key === active
        ? <button key={tab.key} className="active">{label}</button>
        : <button key={tab.key} onClick={() => navigate(tab.path)}>{label}</button>;
    })}
  </div>;
}
