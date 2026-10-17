/** The notification-area icon: run the last project, stop, open, quit. */
import path from 'node:path';
import { Menu, nativeImage, Tray } from 'electron';
import type { AppCommand } from '../shared/contract.js';
import { t } from '../shared/i18n/index.js';

export interface TrayState {
  lastProject: { path: string; name: string } | null;
  running: Array<{ projectPath: string; name: string; mode: 'run' | 'live' | 'ipa' | 'sync' }>;
  /** A downloaded update, ready to install. */
  updateReady?: string | null;
}

export class AppTray {
  private readonly tray: Tray;
  private state: TrayState = { lastProject: null, running: [] };

  constructor(private readonly iconsDir: string, private readonly actions: { show(): void; quit(): void; command(command: AppCommand): void; update(): void }) {
    this.tray = new Tray(this.icon(false));
    this.tray.setToolTip(t.tray.tooltip);
    this.tray.on('click', () => actions.show());
    this.render();
  }

  private icon(active: boolean) {
    return nativeImage.createFromPath(path.join(this.iconsDir, active ? 'tray-active.ico' : 'tray.ico'));
  }

  update(state: TrayState): void {
    this.state = state;
    this.render();
  }

  private render(): void {
    const { lastProject, running } = this.state;
    const items: Electron.MenuItemConstructorOptions[] = [];
    for (const session of running) {
      items.push({ label: `${session.name} · ${session.mode === 'live' ? t.tray.live : session.mode === 'ipa' ? t.tray.buildingIpa : session.mode === 'sync' ? t.tray.syncing : t.tray.running}`, enabled: false });
    }
    if (running.length) items.push({ label: running.length > 1 ? t.tray.stopAll : t.tray.stop(running[0]!.name), click: () => this.actions.command({ type: 'stop' }) }, { type: 'separator' });
    if (lastProject) {
      items.push(
        { label: t.tray.run(lastProject.name), click: () => this.actions.command({ type: 'start', mode: 'run', projectPath: lastProject.path }) },
        { label: t.tray.liveReload(lastProject.name), click: () => this.actions.command({ type: 'start', mode: 'live', projectPath: lastProject.path }) },
        { type: 'separator' },
      );
    }
    items.push({ label: t.tray.open, click: () => this.actions.show() });
    if (this.state.updateReady) items.push({ label: t.tray.update(this.state.updateReady), click: () => this.actions.update() });
    items.push({ type: 'separator' }, { label: t.tray.quit, click: () => this.actions.quit() });
    this.tray.setContextMenu(Menu.buildFromTemplate(items));
    this.tray.setImage(this.icon(running.length > 0));
    this.tray.setToolTip(running.length ? t.tray.tooltipRunning(running.map((r) => r.name).join(', ')) : t.tray.tooltip);
  }

  destroy(): void {
    this.tray.destroy();
  }
}
