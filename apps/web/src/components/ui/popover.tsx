import * as PopoverPrimitive from '@radix-ui/react-popover';
import { createContext, forwardRef, useCallback, useContext, useEffect, useState, type ComponentPropsWithoutRef, type ComponentRef } from 'react';
import { cn } from '@/lib/utils';
import { useControlDisabled } from './use-control-disabled';

const PopoverContext = createContext<{ container: HTMLElement | null; setAnchor: (node: HTMLElement | null) => void; close: () => void } | null>(null);

export function Popover({ open: controlledOpen, defaultOpen = false, onOpenChange, ...props }: ComponentPropsWithoutRef<typeof PopoverPrimitive.Root>) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const inherited = useControlDisabled();
  const inheritedRef = inherited.ref;
  const setAnchor = useCallback((node: HTMLElement | null) => { setContainer(node?.closest('dialog') ?? null); inheritedRef(node); }, [inheritedRef]);
  const setOpen = (value: boolean) => { setUncontrolledOpen(value); onOpenChange?.(value); };
  useEffect(() => { if (inherited.disabled) { setUncontrolledOpen(false); onOpenChange?.(false); } }, [inherited.disabled]);
  return <PopoverContext.Provider value={{ container, setAnchor, close: () => setOpen(false) }}>
    <PopoverPrimitive.Root {...props} open={!inherited.disabled && (controlledOpen ?? uncontrolledOpen)} onOpenChange={setOpen} />
  </PopoverContext.Provider>;
}

export const PopoverTrigger = forwardRef<ComponentRef<typeof PopoverPrimitive.Trigger>, ComponentPropsWithoutRef<typeof PopoverPrimitive.Trigger>>(
  function PopoverTrigger(props, forwardedRef) {
    const context = useContext(PopoverContext);
    const setAnchor = context?.setAnchor;
    const ref = useCallback((node: HTMLButtonElement | null) => {
      setAnchor?.(node);
      if (typeof forwardedRef === 'function') forwardedRef(node);
      else if (forwardedRef) forwardedRef.current = node;
    }, [forwardedRef, setAnchor]);
    return <PopoverPrimitive.Trigger {...props} ref={ref} />;
  },
);

export const PopoverContent = forwardRef<ComponentRef<typeof PopoverPrimitive.Content>, ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>>(
  function PopoverContent({ className, align = 'start', sideOffset = 6, onEscapeKeyDown, ...props }, ref) {
    const context = useContext(PopoverContext);
    return <PopoverPrimitive.Portal container={context?.container ?? undefined}>
      <PopoverPrimitive.Content sticky="always" {...props} ref={ref} align={align} sideOffset={sideOffset} collisionPadding={12}
        data-slot="popover-content" className={cn('ui-popover', className)}
        onEscapeKeyDown={(event) => {
          onEscapeKeyDown?.(event);
          if (!event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); context?.close(); }
        }} />
    </PopoverPrimitive.Portal>;
  },
);

export const PopoverClose = PopoverPrimitive.Close;
