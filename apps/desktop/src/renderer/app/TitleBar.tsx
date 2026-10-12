import { useApp } from '../state/app';
import { useProject } from '../state/projects';
import { Logo } from '../ui/AppIcon';
import { Kbd } from '../ui/Feedback';
import { Icon } from '../ui/Icon';

const PAGE_TITLES: Record<string, string> = { devices: 'Devices', macs: 'Macs', settings: 'Settings' };

/** Our own title bar (the caption buttons are native, from titleBarOverlay). */
export function TitleBar({ minimal }: { minimal?: boolean }) {
  const route = useApp((s) => s.route);
  const openPalette = useApp((s) => s.openPalette);
  const project = useProject(route.name === 'project' ? route.path : null);
  const crumb = route.name === 'project' ? project.summary?.appName ?? route.path.split(/[\\/]/).pop() : PAGE_TITLES[route.name];
  return (
    <header className="titlebar">
      <div className="titlebar__brand">
        <Logo size={16} />
        <span className="titlebar__app">CapMac Studio</span>
        {crumb && !minimal && (
          <>
            <Icon name="chevronRight" size={12} className="titlebar__sep" />
            <span className="titlebar__crumb truncate">{crumb}</span>
          </>
        )}
      </div>
      {!minimal && (
        <button type="button" className="titlebar__search" onClick={() => openPalette()} aria-label="Search or run a command (Ctrl+K)" aria-keyshortcuts="Control+K">
          <Icon name="search" size={14} />
          <span className="titlebar__search-text">Search or run a command</span>
          <Kbd keys="Ctrl+K" />
        </button>
      )}
      <div className="titlebar__end" />
    </header>
  );
}
