import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import { Kbd } from './Feedback';

/** `point`: where `showAt` says (a context menu at the pointer). */
export type Placement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end' | 'right-start' | 'point';

/**
 * Popover state shared by a trigger and its flyout. The flyout lives in the
 * top layer (Popover API) and is placed next to the trigger with CSS anchor
 * positioning; light dismiss (outside click, Esc) comes from the platform.
 */
export function usePopover() {
  const reactId = useId();
  const id = `pop-${reactId.replace(/[^a-zA-Z0-9]/g, '')}`;
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onToggle = (e: Event) => setOpen((e as ToggleEvent).newState === 'open');
    el.addEventListener('toggle', onToggle);
    return () => el.removeEventListener('toggle', onToggle);
  }, []);
  const close = useCallback(() => {
    try {
      if (ref.current?.matches(':popover-open')) ref.current.hidePopover();
    } catch {
      // already closed
    }
  }, []);
  const show = useCallback(() => {
    try {
      ref.current?.showPopover();
    } catch {
      // already open
    }
  }, []);
  /** Opens a `point` flyout at (x, y), kept inside the window (flipped up or left near its edges). */
  const showAt = useCallback((x: number, y: number) => {
    const el = ref.current;
    if (!el) return;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    try {
      el.showPopover();
    } catch {
      // already open: moved
    }
    // Placed before the first paint: the size is known once it is open.
    const { offsetWidth: width, offsetHeight: height } = el;
    const left = x + width > window.innerWidth - 4 ? Math.max(4, x - width) : x;
    const top = y + height > window.innerHeight - 4 ? Math.max(4, y - height) : y;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }, []);
  return {
    id,
    ref,
    open,
    close,
    show,
    showAt,
    triggerProps: { popoverTarget: id, 'aria-expanded': open, 'aria-controls': id } as const,
  };
}

export function Popover({
  state,
  placement = 'bottom-start',
  className,
  children,
  label,
  role = 'dialog',
}: {
  state: ReturnType<typeof usePopover>;
  placement?: Placement;
  className?: string;
  children: ReactNode;
  label?: string;
  role?: string;
}) {
  return (
    <div ref={state.ref} id={state.id} popover="auto" role={role} aria-label={label} className={`popover popover--${placement}${className ? ` ${className}` : ''}`}>
      {children}
    </div>
  );
}

export interface MenuItemSpec {
  id: string;
  label: string;
  /** A second, smaller line under the label. */
  description?: string;
  icon?: IconName;
  shortcut?: string;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  checked?: boolean;
  separatorBefore?: boolean;
  onSelect: () => void;
}

/** A menu flyout with full keyboard support (arrows, Home/End, typeahead, Esc). */
export function Menu({ state, items, label, placement = 'bottom-end', width }: { state: ReturnType<typeof usePopover>; items: MenuItemSpec[]; label: string; placement?: Placement; width?: number }) {
  const list = useRef<HTMLDivElement>(null);
  const hasChecks = items.some((i) => i.checked !== undefined);
  useEffect(() => {
    if (!state.open) return;
    const first = list.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled), [role="menuitemcheckbox"]:not(:disabled)');
    first?.focus();
  }, [state.open]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    let next = -1;
    if (e.key === 'ArrowDown') next = (index + 1) % buttons.length;
    else if (e.key === 'ArrowUp') next = (index - 1 + buttons.length) % buttons.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = buttons.length - 1;
    else if (e.key === 'Tab') state.close();
    else if (e.key.length === 1 && /\S/.test(e.key)) {
      const lower = e.key.toLowerCase();
      next = buttons.findIndex((b, i) => i > index && b.textContent?.trim().toLowerCase().startsWith(lower));
      if (next < 0) next = buttons.findIndex((b) => b.textContent?.trim().toLowerCase().startsWith(lower));
    }
    if (next >= 0) {
      e.preventDefault();
      buttons[next]?.focus();
    }
  };

  return (
    <Popover state={state} placement={placement} role="menu" label={label} className="menu">
      <div ref={list} className="menu__list" onKeyDown={onKeyDown} style={width ? { minWidth: width } : undefined}>
        {items.map((item) => (
          <div key={item.id} role="none">
            {item.separatorBefore && <div className="menu__sep" role="separator" />}
            <button
              type="button"
              role={item.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'}
              aria-checked={item.checked}
              className={`menu__item${item.danger ? ' is-danger' : ''}${item.description ? ' has-description' : ''}`}
              disabled={item.disabled}
              onClick={() => {
                state.close();
                item.onSelect();
              }}
            >
              {hasChecks && <span className="menu__check">{item.checked && <Icon name="check" size={16} />}</span>}
              {item.icon && <Icon name={item.icon} size={16} />}
              {item.description ? (
                <span className="menu__text">
                  <span className="menu__label">{item.label}</span>
                  <span className="menu__description">{item.description}</span>
                </span>
              ) : (
                <span className="menu__label">{item.label}</span>
              )}
              {item.hint && <span className="menu__hint">{item.hint}</span>}
              {item.shortcut && <Kbd keys={item.shortcut} />}
            </button>
          </div>
        ))}
      </div>
    </Popover>
  );
}
