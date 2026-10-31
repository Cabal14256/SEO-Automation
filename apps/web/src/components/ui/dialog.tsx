import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { IconButton } from './button';

let scrollLocks = 0;
let previousBodyOverflow = '';

function lockBodyScroll() {
  if (scrollLocks === 0) previousBodyOverflow = document.body.style.overflow;
  scrollLocks += 1;
  document.body.style.overflow = 'hidden';
  return () => {
    scrollLocks -= 1;
    // Nested dialogs can unmount in either order when the route changes.
    if (scrollLocks === 0) document.body.style.overflow = previousBodyOverflow;
  };
}

export function Dialog({ open, title, close, children, wide = false, closeDisabled = false, className = '' }: {
  open: boolean; title: string; close: () => void; children: ReactNode; wide?: boolean; closeDisabled?: boolean; className?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    let frame: number | undefined;
    const show = () => {
      // Child effects run first. Wait for the outer dialog so restored nested
      // windows enter the top layer after their parent, just like a user click.
      const parent = node.parentElement?.closest('dialog');
      if (parent && !parent.open) { frame = requestAnimationFrame(show); return; }
      if (!node.open) node.showModal();
    };
    if (open) show();
    if (!open && node.open) node.close();
    if (!open) return;
    const unlock = lockBodyScroll();
    return () => { if (frame !== undefined) cancelAnimationFrame(frame); unlock(); };
  }, [open]);
  return <dialog ref={dialog} className={`import-dialog${wide ? ' import-dialog-wide' : ''} ${className}`} aria-labelledby={titleId}
    onCancel={(event) => {
      // File inputs also emit a bubbling cancel event when the same file is
      // selected again. Only the dialog's own Escape event closes the window.
      if (event.target !== event.currentTarget) return;
      event.preventDefault(); if (!closeDisabled) close();
    }}
    onClose={(event) => { if (!event.currentTarget.open && !closeDisabled) close(); }}
    onClick={(event) => {
      if (closeDisabled || event.target !== event.currentTarget) return;
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
    }}>
    <div className="import-dialog-heading"><h2 id={titleId}>{title}</h2><IconButton type="button" icon={X} label={`关闭${title}`} disabled={closeDisabled} onClick={close} /></div>
    <div className="import-dialog-body">{children}</div>
  </dialog>;
}
