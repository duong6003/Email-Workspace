import type { ReactNode } from "react";

export type UiIconName =
  | "search" | "filter" | "plus" | "upload" | "more" | "chevronDown" | "chevronLeft" | "chevronRight"
  | "help" | "expand" | "refresh" | "download" | "edit" | "copy"
  | "trash" | "settings" | "user" | "template" | "check" | "warning"
  | "mail" | "lock" | "eye" | "eyeOff" | "arrowRight";

const paths: Record<UiIconName, ReactNode> = {
  search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 4 4"/></>,
  filter: <><path d="M4 6h16M7 12h10M10 18h4"/></>,
  plus: <><path d="M12 5v14M5 12h14"/></>,
  upload: <><path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5"/><path d="M5 14v5h14v-5"/></>,
  more: <><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none"/></>,
  chevronDown: <path d="m7 9.5 5 5 5-5"/>,
  chevronLeft: <path d="m14.5 7-5 5 5 5"/>,
  chevronRight: <path d="m9.5 7 5 5-5 5"/>,
  help: <><circle cx="12" cy="12" r="9"/><path d="M9.8 9a2.3 2.3 0 1 1 3.6 1.9c-.9.6-1.4 1.1-1.4 2.1M12 17h.01"/></>,
  expand: <><path d="M8.5 4H4v4.5M15.5 4H20v4.5M8.5 20H4v-4.5M15.5 20H20v-4.5"/></>,
  refresh: <><path d="M19 7v5h-5"/><path d="M18 12a6 6 0 1 0-1.5 4"/></>,
  download: <><path d="M12 4v12m0 0 4.5-4.5M12 16l-4.5-4.5"/><path d="M5 19h14"/></>,
  edit: <><path d="m4 20 4.2-1 10-10a2.1 2.1 0 0 0-3-3l-10 10L4 20Z"/><path d="m14 7 3 3"/></>,
  copy: <><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></>,
  trash: <><path d="M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/></>,
  settings: <><circle cx="12" cy="12" r="3"/><path d="M19 13.5v-3l-2-.7-.7-1.7.9-1.9-2.1-2.1-1.9.9-1.7-.7-.7-2h-3l-.7 2-1.7.7-1.9-.9-2.1 2.1.9 1.9-.7 1.7-2 .7v3l2 .7.7 1.7-.9 1.9 2.1 2.1 1.9-.9 1.7.7.7 2h3l.7-2 1.7-.7 1.9.9 2.1-2.1-.9-1.9.7-1.7z"/></>,
  user: <><circle cx="12" cy="8" r="3"/><path d="M5.5 20c.4-4 2.5-6 6.5-6s6.1 2 6.5 6"/></>,
  template: <><rect x="4" y="3.5" width="16" height="17" rx="2"/><path d="M4 8h16M8 12h8M8 16h5"/></>,
  check: <path d="m5 12 4 4 10-10"/>,
  warning: <><path d="M12 3 2.8 20h18.4L12 3Z"/><path d="M12 9v4M12 16.5h.01"/></>,
  mail: <><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 7 8 6 8-6"/></>,
  lock: <><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v2"/></>,
  eye: <><path d="M2.8 12s3.2-5 9.2-5 9.2 5 9.2 5-3.2 5-9.2 5-9.2-5-9.2-5Z"/><circle cx="12" cy="12" r="2.2"/></>,
  eyeOff: <><path d="m4 4 16 16"/><path d="M9.6 7.4A9 9 0 0 1 12 7c6 0 9.2 5 9.2 5a14 14 0 0 1-2.2 2.7M14.5 16.7A9 9 0 0 1 12 17c-6 0-9.2-5-9.2-5a14.7 14.7 0 0 1 3-3.4"/><path d="M10.5 10.5a2.2 2.2 0 0 0 3 3"/></>,
  arrowRight: <><path d="M5 12h14M14 7l5 5-5 5"/></>,
};

export function UiIcon({ name, size = 18, className }: { name: UiIconName; size?: number; className?: string }) {
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}
