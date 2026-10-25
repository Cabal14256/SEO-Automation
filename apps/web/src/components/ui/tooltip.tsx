import { useEffect, useId, useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

type TriggerProps = Pick<HTMLAttributes<HTMLElement>, 'onPointerEnter' | 'onPointerLeave' | 'onFocus' | 'onBlur' | 'onClick' | 'aria-describedby'>;

/** A top-layer tooltip also works inside native dialogs and scrolling tables. */
export function Tooltip({ label, description, children }: {
  label: string; description?: string; children: (props: TriggerProps) => ReactNode;
}) {
  const id = useId();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hovered = useRef(false);
  const focused = useRef(false);
  const cancelHide = () => { clearTimeout(hideTimer.current); };
  const hide = () => { cancelHide(); setAnchor(null); };
  const leave = () => {
    cancelHide();
    if (!focused.current) hideTimer.current = setTimeout(() => setAnchor(null), 100);
  };

  useEffect(() => () => clearTimeout(hideTimer.current), []);
  useLayoutEffect(() => {
    const node = bubble.current;
    if (!anchor || !node) return;
    // Popovers escape overflow clipping and sit above the dialog's top layer.
    node.showPopover?.();
    const position = () => {
      if (!anchor.isConnected || !anchor.getClientRects().length) { setAnchor(null); return; }
      const rect = anchor.getBoundingClientRect();
      const bounds = node.getBoundingClientRect();
      const viewportWidth = document.documentElement.clientWidth;
      const viewportHeight = document.documentElement.clientHeight;
      const left = Math.max(8, Math.min(rect.left + (rect.width - bounds.width) / 2, viewportWidth - bounds.width - 8));
      const top = rect.top >= bounds.height + 12 ? rect.top - bounds.height - 8 : Math.min(rect.bottom + 8, viewportHeight - bounds.height - 8);
      node.style.left = `${left}px`;
      node.style.top = `${Math.max(8, top)}px`;
    };
    position();
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setAnchor(null);
    };
    // Focusing an offscreen table action scrolls it into view. Keep its keyboard
    // hint and reposition it instead of dismissing it during that scroll.
    const onScroll = () => { if (focused.current) position(); else setAnchor(null); };
    const closeDialog = () => setAnchor(null);
    document.addEventListener('keydown', dismiss, true);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', position);
    // A dialog can be closed programmatically without blurring a disabled trigger.
    const dialog = anchor.closest('dialog');
    dialog?.addEventListener('close', closeDialog);
    return () => {
      document.removeEventListener('keydown', dismiss, true);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', position);
      dialog?.removeEventListener('close', closeDialog);
      if (node.hidePopover && node.matches(':popover-open')) node.hidePopover();
    };
  }, [anchor, label, description]);

  return <>
    {children({
      'aria-describedby': description ? `${id}-description` : undefined,
      onPointerEnter: (event) => {
        if (event.pointerType === 'touch') return;
        hovered.current = true; cancelHide(); setAnchor(event.currentTarget);
      },
      onPointerLeave: () => { hovered.current = false; leave(); },
      onFocus: (event) => {
        if (!event.currentTarget.matches(':focus-visible')) return;
        focused.current = true; cancelHide(); setAnchor(event.currentTarget);
      },
      onBlur: () => { focused.current = false; if (!hovered.current) hide(); },
      onClick: hide,
    })}
    {description && <span id={`${id}-description`} className="sr-only icon-description">{description}</span>}
    {anchor && createPortal(<div ref={bubble} role="tooltip" popover="manual" className="icon-tooltip"
      onPointerEnter={cancelHide} onPointerLeave={leave}>
      {label}{description && <span className="icon-tooltip-detail">{description}</span>}
    </div>, anchor.closest('dialog') ?? document.body)}
  </>;
}
