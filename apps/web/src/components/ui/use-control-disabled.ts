import { useCallback, useEffect, useState } from 'react';

/** Portals leave their fieldset, so keep its native disabled state attached. */
export function useControlDisabled(disabled = false) {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [fieldsetDisabled, setFieldsetDisabled] = useState(false);
  const ref = useCallback((element: HTMLElement | null) => setNode(element), []);
  useEffect(() => {
    if (!node) return;
    const ancestors: HTMLFieldSetElement[] = [];
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      if (parent instanceof HTMLFieldSetElement) ancestors.push(parent);
    }
    const update = () => setFieldsetDisabled(ancestors.some((fieldset) => {
      const legend = Array.from(fieldset.children).find((child) => child instanceof HTMLLegendElement);
      return fieldset.disabled && !legend?.contains(node);
    }));
    update();
    const observer = new MutationObserver(update);
    ancestors.forEach((ancestor) => observer.observe(ancestor, { attributes: true, attributeFilter: ['disabled'] }));
    return () => observer.disconnect();
  }, [node]);
  return { ref, disabled: disabled || fieldsetDisabled };
}
