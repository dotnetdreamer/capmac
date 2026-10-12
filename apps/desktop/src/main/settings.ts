/** capmac Studio's own settings (theme, recent projects, …) in %APPDATA%\capmac Studio. */
import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { DEFAULT_SETTINGS, settingsSchema, type RecentProject, type Settings, type SettingsPatch } from '../shared/contract.js';

type Listener = (settings: Settings) => void;

export class SettingsStore {
  private value: Settings;
  private readonly listeners = new Set<Listener>();
  private writing: Promise<void> = Promise.resolve();
  private readonly file = path.join(app.getPath('userData'), 'settings.json');

  constructor() {
    this.value = this.read();
  }

  private read(): Settings {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8'));
      // Unknown or invalid fields fall back to defaults instead of breaking startup.
      const merged = { ...DEFAULT_SETTINGS, ...raw };
      const parsed = settingsSchema.safeParse(merged);
      if (parsed.success) return parsed.data;
      const fixed: Record<string, unknown> = { ...DEFAULT_SETTINGS };
      for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>) {
        const field = settingsSchema.shape[key].safeParse(raw?.[key]);
        if (field.success) fixed[key] = field.data;
      }
      return fixed as Settings;
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  get(): Settings {
    return this.value;
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  update(patch: SettingsPatch): Settings {
    this.value = { ...this.value, ...patch };
    for (const listener of this.listeners) listener(this.value);
    this.save();
    return this.value;
  }

  private save(): void {
    const snapshot = JSON.stringify(this.value, null, 2);
    this.writing = this.writing.then(async () => {
      try {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        await fs.writeFile(tmp, snapshot);
        await fs.rename(tmp, this.file);
      } catch {
        // settings are a convenience; never crash over them
      }
    });
  }

  /** Moves a project to the top of the recent list. */
  touchProject(entry: { path: string; name: string; appId: string }): void {
    const others = this.value.recentProjects.filter((p) => p.path.toLowerCase() !== entry.path.toLowerCase());
    const previous = this.value.recentProjects.find((p) => p.path.toLowerCase() === entry.path.toLowerCase());
    const next: RecentProject = { ...previous, path: entry.path, name: entry.name, appId: entry.appId, lastOpened: Date.now() };
    this.update({ recentProjects: [next, ...others].slice(0, 30), lastProject: entry.path });
  }

  recordRun(projectPath: string, run: NonNullable<RecentProject['lastRun']>): void {
    const projects = this.value.recentProjects.map((p) => (p.path.toLowerCase() === projectPath.toLowerCase() ? { ...p, lastRun: run } : p));
    this.update({ recentProjects: projects });
  }

  forgetProject(projectPath: string): void {
    this.update({
      recentProjects: this.value.recentProjects.filter((p) => p.path.toLowerCase() !== projectPath.toLowerCase()),
      lastProject: this.value.lastProject?.toLowerCase() === projectPath.toLowerCase() ? null : this.value.lastProject,
    });
  }
}
