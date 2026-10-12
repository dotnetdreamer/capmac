import { useEffect } from 'react';
import { useApp } from '../state/app';
import { buildCommands, shortcutOf } from './commands';

function inEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return Boolean(el && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'));
}

/** Global keyboard shortcuts (Ctrl+K, F5, …). */
export function useShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const app = useApp.getState();
      if (!app.settings || app.route.name === 'onboarding') return;
      const combo = shortcutOf(e);
      if (combo === 'Ctrl+K' || combo === 'Ctrl+Shift+P') {
        e.preventDefault();
        if (app.paletteOpen) app.closePalette();
        else app.openPalette();
        return;
      }
      // Dialogs and the palette own the keyboard while open.
      if (app.paletteOpen || document.querySelector('dialog[open]')) return;
      // Plain keys belong to text fields.
      const modified = e.ctrlKey || e.altKey || /^F\d+$/.test(e.key);
      if (!modified && inEditable(e.target)) return;
      const command = buildCommands().find((c) => c.shortcut === combo);
      if (command) {
        e.preventDefault();
        command.run();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
