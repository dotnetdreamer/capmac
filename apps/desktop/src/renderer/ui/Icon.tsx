import { ICONS, type IconName } from './icon-data';

export type { IconName };

interface IconProps {
  name: IconName;
  /** 16 (default) or 20 px; other sizes scale the 20 px drawing. */
  size?: number;
  filled?: boolean;
  className?: string;
  /** Accessible name; icons are decorative (aria-hidden) without one. */
  label?: string;
}

/** Fluent System Icons, drawn with currentColor. */
export function Icon({ name, size = 16, filled = false, className, label }: IconProps) {
  const icon = ICONS[name] as { r16?: string; f16?: string; r20: string; f20: string };
  const small = size <= 16 && (filled ? icon.f16 : icon.r16);
  const d = small || (filled ? icon.f20 : icon.r20);
  const box = small ? 16 : 20;
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      width={size}
      height={size}
      viewBox={`0 0 ${box} ${box}`}
      fill="currentColor"
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      aria-label={label}
      focusable="false"
    >
      <path d={d} />
    </svg>
  );
}
