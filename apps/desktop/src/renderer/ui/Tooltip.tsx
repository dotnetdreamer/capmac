import { Children, cloneElement, useEffect, useId, useRef, type CSSProperties, type ReactElement, type ReactNode } from 'react';

type Placement = 'top' | 'bottom' | 'left' | 'right';

/** CSS anchor name derived from a React id (":r1:" → "--a-r1"). */
export function anchorNameFor(id: string, prefix = 'a'): string {
  return `--${prefix}-${id.replace(/[^a-zA-Z0-9_-]/g, '')}`;
}

/**
 * A Fluent tooltip: appears after a short delay on hover or keyboard focus,
 * rendered in the top layer (popover) and placed with CSS anchor positioning.
 */
export function Tooltip({ content, shortcut, placement = 'bottom', children }: { content: ReactNode; shortcut?: string; placement?: Placement; children: ReactElement }) {
  const id = useId();
  const anchor = anchorNameFor(id, 'tt');
  const tip = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);

  const hide = () => {
    window.clearTimeout(timer.current);
    try {
      if (tip.current?.matches(':popover-open')) tip.current.hidePopover();
    } catch {
      // not shown
    }
  };
  const show = (delay = 500) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      try {
        tip.current?.showPopover();
      } catch {
        // detached
      }
    }, delay);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const child = Children.only(children) as ReactElement<Record<string, any>>;
  const props = child.props;
  const trigger = cloneElement(child, {
    style: { ...(props.style ?? {}), anchorName: anchor } as CSSProperties,
    onPointerEnter: (e: React.PointerEvent) => {
      props.onPointerEnter?.(e);
      if (e.pointerType === 'mouse') show();
    },
    onPointerLeave: (e: React.PointerEvent) => {
      props.onPointerLeave?.(e);
      hide();
    },
    onPointerDown: (e: React.PointerEvent) => {
      props.onPointerDown?.(e);
      hide();
    },
    onFocus: (e: React.FocusEvent<HTMLElement>) => {
      props.onFocus?.(e);
      if (e.currentTarget.matches(':focus-visible')) show(300);
    },
    onBlur: (e: React.FocusEvent) => {
      props.onBlur?.(e);
      hide();
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      props.onKeyDown?.(e);
      if (e.key === 'Escape') hide();
    },
  });

  return (
    <>
      {trigger}
      <div ref={tip} popover="manual" role="tooltip" className={`tooltip tooltip--${placement}`} style={{ positionAnchor: anchor } as CSSProperties}>
        {content}
        {shortcut && <kbd className="tooltip__kbd">{shortcut}</kbd>}
      </div>
    </>
  );
}
