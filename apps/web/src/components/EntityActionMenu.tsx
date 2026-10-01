import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { UiIcon, type UiIconName } from '../app/ui-icons.js';

export type EntityActionItem = {
  label: string;
  icon: UiIconName;
  tone?: 'default' | 'danger';
  disabled?: boolean;
  onSelect: () => void;
};

/**
 * `trigger` and `triggerClassName` exist so a caller can hang this menu off its
 * own control -- the header's account chip -- without duplicating the parts that
 * are easy to get wrong: outside-click, Escape, close-on-scroll, and portal
 * placement that flips above the trigger near the bottom of the viewport.
 * Omit them and the trigger stays the row "more" button every table uses.
 */
export function EntityActionMenu({ label, items, onOpen, trigger: triggerContent, triggerClassName = 'row-menu', disabled = false }: {
  label: string;
  items: EntityActionItem[];
  onOpen?: () => void;
  trigger?: ReactNode;
  triggerClassName?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties>();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  const placeMenu = () => {
    if (!trigger.current || window.innerWidth <= 760) { setPosition(undefined); return; }
    const rect = trigger.current.getBoundingClientRect();
    const estimatedHeight = Math.min(items.length * 42 + 12, 620);
    const top = rect.bottom + 6 + estimatedHeight <= window.innerHeight ? rect.bottom + 6 : Math.max(8, rect.top - estimatedHeight - 6);
    setPosition({ position: 'fixed', top, left: Math.max(8, Math.min(rect.right - 190, window.innerWidth - 198)) });
  };

  useEffect(() => {
    if (!open) return;
    placeMenu();
    const close = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setOpen(false); } };
    const closeOnScroll = () => setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', escape);
    window.addEventListener('resize', placeMenu);
    window.addEventListener('scroll', closeOnScroll, true);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', escape); window.removeEventListener('resize', placeMenu); window.removeEventListener('scroll', closeOnScroll, true); };
  }, [open, items.length]);

  return <div className="entity-action-menu" ref={root}>
    <button ref={trigger} type="button" className={triggerClassName} aria-label={label} aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={() => setOpen((current) => { const next = !current; if (next) onOpen?.(); return next; })}>{triggerContent ?? <UiIcon name="more" size={17} />}</button>
    {open && createPortal(<div ref={menu} className="entity-action-menu-list" role="menu" style={position}>{items.map((item) => <button type="button" role="menuitem" key={item.label} className={item.tone === 'danger' ? 'danger' : ''} disabled={item.disabled} onClick={() => { setOpen(false); item.onSelect(); }}><UiIcon name={item.icon} size={16} /><span>{item.label}</span></button>)}</div>, document.body)}
  </div>;
}
