/** Ported verbatim from design-reference/ui-handoff-v2/source/app/page.tsx L31-41 (NavIcon). */
import type { NavIconName } from './nav.js';

export function NavIcon({ name }: { name: NavIconName }) {
  const paths: Record<NavIconName, React.ReactNode> = {
    compose: (
      <>
        <path d="M4 19.5 8.2 18l9.9-9.9a2.1 2.1 0 0 0-3-3L5.2 15 4 19.5Z" />
        <path d="m13.8 6.4 3 3" />
      </>
    ),
    drafts: (
      <>
        <path d="M5 3.5h10l4 4v13H5z" />
        <path d="M15 3.5v4h4M8 12h8M8 16h6" />
      </>
    ),
    recipients: (
      <>
        <circle cx="9" cy="8" r="3" />
        <path d="M3.5 19c.3-3.7 2-5.5 5.5-5.5s5.2 1.8 5.5 5.5M16 7h4M18 5v4" />
      </>
    ),
    templates: (
      <>
        <rect x="3.5" y="4" width="17" height="16" rx="2" />
        <path d="M3.5 8h17M8 12h8M8 16h5" />
      </>
    ),
    settings: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19 13.5v-3l-2-.7-.7-1.7.9-1.9-2.1-2.1-1.9.9-1.7-.7-.7-2h-3l-.7 2-1.7.7-1.9-.9-2.1 2.1.9 1.9-.7 1.7-2 .7v3l2 .7.7 1.7-.9 1.9 2.1 2.1 1.9-.9 1.7.7.7 2h3l.7-2 1.7-.7 1.9.9 2.1-2.1-.9-1.9.7-1.7z" />
      </>
    ),
    history: (
      <>
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 7.5v5l3.5 2M4.5 5.5 2.5 8" />
      </>
    ),
  };
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {paths[name]}
    </svg>
  );
}
