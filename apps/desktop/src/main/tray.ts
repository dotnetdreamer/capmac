/** The notification-area icon: run the last project, stop, open, quit. */
import path from 'node:path';
import { Menu, nativeImage, Tray } from 'electron';
import type { AppCommand } from '../shared/contract.js';

export interface TrayState {
  lastProject: { path: string; name: string } | null;
  running: Array<{ projectPath: string; name: string; mode: 'run' | 'live' | 'ipa' }>;
}

export class AppTray {
  private readonly tray: Tray;
  private state: TrayState = { lastProject: null, running: [] };

  constructor(private readonly iconsDir: string, private readonly actions: { show(): void; quit(): void; command(command: AppCommand): void }) {
    this.tray = new Tray(this.icon(false));
    this.tray.setToolTip('capmac Studio');
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
      items.push({ label: `${session.name} · ${session.mode === 'live' ? 'Live' : session.mode === 'ipa' ? 'Building IPA' : 'Running'}`, enabled: false });
    }
    if (running.length) items.push({ label: running.length > 1 ? 'Stop all' : `Stop ${running[0]!.name}`, click: () => this.actions.command({ type: 'stop' }) }, { type: 'separator' });
    if (lastProject) {
      items.push(
        { label: `Run ${lastProject.name}`, click: () => this.actions.command({ type: 'start', mode: 'run', projectPath: lastProject.path }) },
        { label: `Live ${lastProject.name}`, click: () => this.actions.command({ type: 'start', mode: 'live', projectPath: lastProject.path }) },
        { type: 'separator' },
      );
    }
    items.push({ label: 'Open capmac Studio', click: () => this.actions.show() }, { type: 'separator' }, { label: 'Quit', click: () => this.actions.quit() });
    this.tray.setContextMenu(Menu.buildFromTemplate(items));
    this.tray.setImage(this.icon(running.length > 0));
    this.tray.setToolTip(running.length ? `capmac Studio · ${running.map((r) => r.name).join(', ')}` : 'capmac Studio');
  }

  destroy(): void {
    this.tray.destroy();
  }
}
