import { useEffect, useRef, type RefObject } from 'react';
import type { ListTable } from '@visactor/vtable';

/** Pointer capture keeps a middle-button drag bounded to this table, including outside release. */
export function useGridMiddlePan(container: RefObject<HTMLDivElement | null>, table: RefObject<ListTable | null>, options: { enabled?: boolean; active?: boolean; isComposing: () => boolean; beforePan: () => void }) {
  const latest = useRef(options); latest.current = options;
  const cancel = useRef<() => void>(() => {});
  useEffect(() => {
    const node = container.current;
    if (!node || !options.enabled || options.active === false) return;
    let drag: { id: number; x: number; left: number; table: ListTable; moved: boolean } | undefined;
    let frame = 0, nextLeft = 0;
    const stop = () => {
      const pointer = drag?.id; drag = undefined;
      cancelAnimationFrame(frame); frame = 0;
      node.classList.remove('scm-grid-panning');
      if (pointer !== undefined && node.hasPointerCapture(pointer)) node.releasePointerCapture(pointer);
    };
    cancel.current = stop;
    const eligible = (event: MouseEvent) => event.button === 1 && latest.current.active !== false && table.current && !(event.target instanceof Element && event.target.closest('input,textarea,select,button,a,dialog,[contenteditable="true"]'));
    const down = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse' || !eligible(event)) return;
      event.preventDefault(); event.stopPropagation();
      stop();
      // Suppress browser auto-scroll even while IME owns the input; do not start our drag.
      if (latest.current.isComposing()) return;
      latest.current.beforePan();
      drag = { id: event.pointerId, x: event.clientX, left: table.current!.scrollLeft, table: table.current!, moved: false };
      node.setPointerCapture(event.pointerId);
    };
    const move = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.id) return;
      if (!(event.buttons & 4) || drag.table !== table.current || latest.current.active === false) { stop(); return; }
      event.preventDefault(); event.stopPropagation();
      const distance = event.clientX - drag.x;
      if (!drag.moved && Math.abs(distance) < 4) return;
      drag.moved = true; node.classList.add('scm-grid-panning'); nextLeft = Math.max(0, drag.left - distance);
      if (!frame) frame = requestAnimationFrame(() => {
        frame = 0;
        if (drag && drag.table === table.current) drag.table.scrollLeft = nextLeft;
      });
    };
    const up = (event: PointerEvent) => {
      if (event.pointerId !== drag?.id) return;
      event.preventDefault(); event.stopPropagation();
      if (drag.moved && drag.table === table.current) drag.table.scrollLeft = nextLeft;
      stop();
    };
    const suppress = (event: MouseEvent) => { if (eligible(event)) { event.preventDefault(); event.stopPropagation(); } };
    node.addEventListener('pointerdown', down, true);
    node.addEventListener('pointermove', move, true);
    node.addEventListener('pointerup', up, true);
    node.addEventListener('pointercancel', stop, true);
    node.addEventListener('lostpointercapture', stop, true);
    node.addEventListener('mousedown', suppress, true);
    node.addEventListener('auxclick', suppress, true);
    window.addEventListener('blur', stop);
    return () => {
      stop(); cancel.current = () => {};
      node.removeEventListener('pointerdown', down, true);
      node.removeEventListener('pointermove', move, true);
      node.removeEventListener('pointerup', up, true);
      node.removeEventListener('pointercancel', stop, true);
      node.removeEventListener('lostpointercapture', stop, true);
      node.removeEventListener('mousedown', suppress, true);
      node.removeEventListener('auxclick', suppress, true);
      window.removeEventListener('blur', stop);
    };
  }, [container, table, options.enabled, options.active]);
  return () => cancel.current();
}
