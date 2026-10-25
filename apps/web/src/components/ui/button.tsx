import { cva, type VariantProps } from 'class-variance-authority';
import { createLink } from '@tanstack/react-router';
import { LoaderCircle, type LucideIcon } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';
import { Tooltip } from './tooltip';

const buttonVariants = cva('select-none', {
  variants: {
    variant: {
      primary: 'primary-button',
      secondary: 'secondary-button',
      text: 'text-button',
      icon: 'icon-button',
      collapse: 'collapse-button',
    },
  },
  defaultVariants: { variant: 'secondary' },
});

type ButtonProps = ComponentProps<'button'> & VariantProps<typeof buttonVariants> & {
  icon?: LucideIcon;
  loading?: boolean;
  loadingLabel?: string;
};

export function Button({ className, variant, icon: Icon, loading = false, loadingLabel, disabled, children, ...props }: ButtonProps) {
  const Glyph = loading ? LoaderCircle : Icon;
  return <button data-slot="button" className={cn(buttonVariants({ variant }), className)} {...props}
    disabled={disabled || loading} aria-busy={loading || undefined}>
    {(Icon || loading || loadingLabel) && <span className="button-icon" aria-hidden="true">{Glyph && <Glyph size={18} className={loading ? 'motion-spin' : undefined} />}</span>}
    {loadingLabel ? <span className="button-labels" data-loading={loading}>
      <span className="button-idle-label" aria-hidden={loading || undefined}>{children}</span>
      <span className="button-loading-label" aria-hidden={!loading || undefined}>{loadingLabel}</span>
    </span> : children}
  </button>;
}

type IconControlProps = { icon: LucideIcon; label: string; description?: string };

export function IconButton({ label, description, ...props }: Omit<ButtonProps, 'children' | 'variant' | 'aria-label' | 'loadingLabel'> & IconControlProps) {
  return <Tooltip label={label} description={description}>{(tip) => <Button {...tip} {...props} variant="icon" aria-label={label}
    aria-describedby={[tip['aria-describedby'], props['aria-describedby']].filter(Boolean).join(' ') || undefined}
    onPointerEnter={(event) => { tip.onPointerEnter?.(event); props.onPointerEnter?.(event); }}
    onPointerLeave={(event) => { tip.onPointerLeave?.(event); props.onPointerLeave?.(event); }}
    onFocus={(event) => { tip.onFocus?.(event); props.onFocus?.(event); }}
    onBlur={(event) => { tip.onBlur?.(event); props.onBlur?.(event); }}
    onClick={(event) => { tip.onClick?.(event); props.onClick?.(event); }}
  />}</Tooltip>;
}

function IconAnchor({ icon: Icon, label, description, className, ...props }: Omit<ComponentProps<'a'>, 'children' | 'aria-label'> & IconControlProps) {
  return <Tooltip label={label} description={description}>{(tip) => <a {...tip} {...props} className={cn('icon-button', className)} aria-label={label}
    aria-describedby={[tip['aria-describedby'], props['aria-describedby']].filter(Boolean).join(' ') || undefined}
    onPointerEnter={(event) => { tip.onPointerEnter?.(event); props.onPointerEnter?.(event); }}
    onPointerLeave={(event) => { tip.onPointerLeave?.(event); props.onPointerLeave?.(event); }}
    onFocus={(event) => { tip.onFocus?.(event); props.onFocus?.(event); }}
    onBlur={(event) => { tip.onBlur?.(event); props.onBlur?.(event); }}
    onClick={(event) => { tip.onClick?.(event); props.onClick?.(event); }}
  ><Icon size={18} aria-hidden="true" /></a>}</Tooltip>;
}

export const IconLink = createLink(IconAnchor);
