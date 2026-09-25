import { useEffect, useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { createPortal } from 'react-dom';
import { IconButton } from './ui';

export function Dialog({
  title, description, children, onClose, size = 'medium', footer, actions,
  className = '', bodyClassName = '', hideHeading = false,
}: {
  title: ReactNode; description?: ReactNode; children: ReactNode; onClose: () => void;
  size?: 'small' | 'medium' | 'large' | 'drawer'; footer?: ReactNode; actions?: ReactNode;
  className?: string; bodyClassName?: string; hideHeading?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const titleId = useId();
  const descriptionId = useId();
  const backdropDown = useRef(false);

  useLayoutEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement instanceof HTMLElement
      && !['BODY', 'HTML'].includes(document.activeElement.tagName) ? document.activeElement : null;
    element.showModal();
    element.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true });
    return () => {
      element.close();
      window.setTimeout(() => {
        const openDialog = document.querySelector('dialog[open]');
        if (previous?.isConnected && (!openDialog || openDialog.contains(previous))) previous.focus({ preventScroll: true });
        else if (!openDialog) document.querySelector<HTMLElement>('main h1, main')?.focus({ preventScroll: true });
      }, 0);
    };
  }, []);

  useEffect(() => {
    const element = dialog.current!;
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const controls = [...element.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), summary, [tabindex="0"]',
      )].filter(control => control.getClientRects().length > 0 && !control.closest('[inert]'));
      const first = controls[0];
      const last = controls.at(-1);
      if (!first) { event.preventDefault(); element.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === element)) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === element)) {
        event.preventDefault(); first.focus();
      }
    };
    element.addEventListener('keydown', keydown);
    return () => element.removeEventListener('keydown', keydown);
  }, []);

  return createPortal(
    <dialog ref={dialog} className={`dialog dialog-${size} ${className}`} aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={event => { event.preventDefault(); closeRef.current(); }}
      onMouseDown={event => { backdropDown.current = event.target === dialog.current; }}
      onClick={event => { if (event.target === dialog.current && backdropDown.current) closeRef.current(); }}>
      <div className={`dialog-heading ${hideHeading ? 'dialog-heading-compact' : ''}`}>
        <div className={hideHeading ? 'sr-only' : 'dialog-title'}>
          <h2 id={titleId}>{title}</h2>{description && <div id={descriptionId} className="dialog-description">{description}</div>}
        </div>
        <div className="dialog-heading-actions">{actions}<IconButton label="닫기" icon={X} onClick={onClose} /></div>
      </div>
      <div className={`dialog-body ${bodyClassName}`}>{children}</div>
      {footer && <div className="dialog-footer">{footer}</div>}
    </dialog>,
    document.body,
  );
}
