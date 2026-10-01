import { useEffect, useRef, type FormEvent, type ReactNode } from 'react';
import { FOCUSABLE_SELECTOR, nextFocusTarget } from './focus-trap.js';

export type ModalSize = 'small' | 'medium' | 'large' | 'workspace';

/**
 * Dialogs stack: the template editor opens a discard-confirmation on top of
 * itself. Every mounted frame listens on `document`, so without this only the
 * topmost one may act on Escape or Tab — otherwise the outer frame reacts to
 * the same keystroke and immediately undoes what the inner one did.
 */
const openDialogs: symbol[] = [];

export function ModalFrame({ titleId, title, description, size = 'medium', onClose, children, footer, asForm = false, onSubmit }: {
  titleId: string;
  title: string;
  description?: string;
  size?: ModalSize;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  asForm?: boolean;
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const dialog = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const id = Symbol('dialog');
    openDialogs.push(id);
    const restoreTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (openDialogs[openDialogs.length - 1] !== id) return;
      if (event.defaultPrevented) return; // a nested control (e.g. EntityActionMenu) already handled it
      if (event.key === 'Escape') { onClose(); return; }
      if (event.key !== 'Tab' || !dialog.current) return;
      const focusable = [...dialog.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)];
      const target = nextFocusTarget(focusable, document.activeElement instanceof HTMLElement ? document.activeElement : null, event.shiftKey);
      if (!target) return;
      event.preventDefault();
      target.focus();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      openDialogs.splice(openDialogs.indexOf(id), 1);
      restoreTo?.focus();
    };
  }, [onClose]);

  const content = <>
    <header><div><h2 id={titleId}>{title}</h2>{description && <p>{description}</p>}</div><button type="button" aria-label="Đóng cửa sổ" onClick={onClose}>×</button></header>
    <div className="overlay-content">{children}</div>
    {footer && <footer>{footer}</footer>}
  </>;
  return <div className="overlay-backdrop" onMouseDown={onClose}>
    {asForm
      ? <form ref={(node) => { dialog.current = node; }} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId} className={`action-overlay modal-${size}`} noValidate onSubmit={onSubmit} onMouseDown={(event) => event.stopPropagation()}>{content}</form>
      : <section ref={(node) => { dialog.current = node; }} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId} className={`action-overlay modal-${size}`} onMouseDown={(event) => event.stopPropagation()}>{content}</section>}
  </div>;
}
