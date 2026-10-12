/**
 * capmac Studio's own updates (electron-updater, NSIS builds). Calm by
 * design: it checks at startup and every few hours, downloads in the
 * background, and never interrupts a session. A downloaded update installs
 * when the user restarts from the InfoBar, Settings or the tray, or when
 * capmac Studio quits. The portable exe cannot replace itself: it only says
 * that a new version exists, with a link to it.
 *
 * The feed comes from the build (resources/app-update.yml, written by
 * electron-builder from CAPMAC_UPDATE_URL); a build without one has updates
 * off. In development, CAPMAC_UPDATE_DEV_CONFIG points at a dev-app-update.yml.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { autoUpdater, type ProgressInfo, type UpdateInfo as FeedUpdate } from 'electron-updater';
import type { UpdateInfo, UpdateState } from '../shared/contract.js';
import { describeUpdateError, feedUrl, notesUrl } from './update-text.js';

declare const __RELEASE_NOTES_URL__: string;

const FIRST_CHECK_MS = 15_000;
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

export interface UpdateHooks {
  onChange(info: UpdateInfo): void;
}

export class Updates {
  private state: UpdateState = { state: 'idle' };
  private readonly portable = Boolean(process.env.PORTABLE_EXECUTABLE_FILE);
  private feed: string | null = null;
  private offered: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private checking: Promise<void> | null = null;

  constructor(private readonly hooks: UpdateHooks) {}

  get info(): UpdateInfo {
    const version = this.offered ?? app.getVersion();
    return { current: app.getVersion(), portable: this.portable, feed: this.feed, notesUrl: notesUrl(__RELEASE_NOTES_URL__, version), state: this.state };
  }

  get ready(): string | null {
    return this.state.state === 'ready' ? this.state.version : null;
  }

  private set(state: UpdateState): void {
    this.state = state;
    this.hooks.onChange(this.info);
  }

  /** Reads the feed and schedules the checks. Updates stay off without a feed. */
  start(): void {
    const devConfig = process.env.CAPMAC_UPDATE_DEV_CONFIG;
    const config = app.isPackaged ? path.join(process.resourcesPath, 'app-update.yml') : devConfig ? path.resolve(devConfig) : null;
    if (!config || !existsSync(config)) {
      this.set({ state: 'unavailable', reason: app.isPackaged ? 'This build of capmac Studio has no update feed.' : 'Updates are off in development builds.' });
      return;
    }
    this.feed = feedUrl(readFileSync(config, 'utf8'));
    if (!app.isPackaged) {
      autoUpdater.forceDevUpdateConfig = true;
      autoUpdater.updateConfigPath = config;
    }
    autoUpdater.autoDownload = !this.portable;
    autoUpdater.autoInstallOnAppQuit = !this.portable;
    autoUpdater.allowPrerelease = false;
    autoUpdater.logger = null;
    autoUpdater.on('checking-for-update', () => this.set({ state: 'checking' }));
    autoUpdater.on('update-not-available', () => this.set({ state: 'up-to-date', checkedAt: Date.now() }));
    autoUpdater.on('update-available', (update: FeedUpdate) => {
      this.offered = update.version;
      if (this.portable) this.set({ state: 'available', version: update.version, download: this.portableDownload(update) });
      else this.set({ state: 'downloading', version: update.version, percent: 0 });
    });
    autoUpdater.on('download-progress', (progress: ProgressInfo) => {
      if (this.offered) this.set({ state: 'downloading', version: this.offered, percent: Math.round(progress.percent) });
    });
    autoUpdater.on('update-downloaded', (update: FeedUpdate) => {
      this.offered = update.version;
      this.set({ state: 'ready', version: update.version });
    });
    autoUpdater.on('error', (err: unknown) => {
      // A failed background check is not news once an update is ready.
      if (this.state.state !== 'ready') this.set({ state: 'error', message: describeUpdateError(err), checkedAt: Date.now() });
    });
    this.timer = setTimeout(() => {
      void this.check();
      this.timer = setInterval(() => void this.check(), CHECK_EVERY_MS);
    }, FIRST_CHECK_MS);
    this.set({ state: 'idle' });
  }

  /** The portable exe's own download, next to the installer in the feed. */
  private portableDownload(update: FeedUpdate): string | undefined {
    if (!this.feed) return undefined;
    const name = `capmac-studio-${update.version}-${process.arch}-portable.exe`;
    return new URL(name, this.feed.endsWith('/') ? this.feed : `${this.feed}/`).toString();
  }

  /** Checks now (Settings › About, or the schedule). */
  async check(): Promise<UpdateInfo> {
    if (this.state.state === 'unavailable' || this.state.state === 'ready' || this.state.state === 'downloading') return this.info;
    this.checking ??= autoUpdater
      .checkForUpdates()
      .then(() => undefined, (err: unknown) => {
        this.set({ state: 'error', message: describeUpdateError(err), checkedAt: Date.now() });
      })
      .finally(() => {
        this.checking = null;
      });
    await this.checking;
    return this.info;
  }

  /** Quits and installs the downloaded update, then starts the new version. */
  install(): void {
    if (this.state.state !== 'ready') return;
    // Silent install (the user already chose to update), then run the new version.
    autoUpdater.quitAndInstall(true, true);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
