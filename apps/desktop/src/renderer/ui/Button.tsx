import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import { Spinner } from './Feedback';
import { Tooltip } from './Tooltip';

type Variant = 'accent' | 'standard' | 'subtle' | 'danger' | 'ghost';
type Size = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: IconName;
  iconFilled?: boolean;
  iconRight?: IconName;
  busy?: boolean;
  children?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'standard', size = 'md', icon, iconFilled, iconRight, busy, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  const iconSize = size === 'lg' ? 20 : 16;
  return (
    <button
      ref={ref}
      type={type}
      className={`btn btn--${variant} btn--${size}${busy ? ' is-busy' : ''}${className ? ` ${className}` : ''}`}
      disabled={disabled}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy ? <Spinner size={iconSize} /> : icon ? <Icon name={icon} size={iconSize} filled={iconFilled} /> : null}
      {children !== undefined && children !== null && <span className="btn__label">{children}</span>}
      {iconRight && <Icon name={iconRight} size={size === 'sm' ? 12 : 16} className="btn__icon-right" />}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: IconName;
  /** Accessible name, also shown as the tooltip. */
  label: string;
  shortcut?: string;
  filled?: boolean;
  size?: Size;
  variant?: 'subtle' | 'standard';
  pressed?: boolean;
  tooltip?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, shortcut, filled, size = 'md', variant = 'subtle', pressed, tooltip = true, className, type = 'button', ...rest },
  ref,
) {
  const button = (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      aria-pressed={pressed}
      className={`icon-btn icon-btn--${size} icon-btn--${variant}${pressed ? ' is-pressed' : ''}${className ? ` ${className}` : ''}`}
      {...rest}
    >
      <Icon name={icon} size={size === 'lg' ? 20 : 16} filled={filled || pressed} />
    </button>
  );
  return tooltip ? <Tooltip content={label} shortcut={shortcut}>{button}</Tooltip> : button;
});
