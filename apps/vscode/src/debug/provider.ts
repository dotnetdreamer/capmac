/**
 * CapMac in Run and Debug: every app in the workspace is in the debug
 * dropdown without a launch.json ("Live: Hello CapMac on iPhone 17 Pro"),
 * F5 with nothing configured runs the current app, and launch.json entries
 * of type "capmac" are checked before they start.
 */
import * as vscode from 'vscode';
import { s, studio } from '../i18n.js';
import { keyOf, type Model } from '../state/model.js';
import { isNative } from '../state/runs.js';
import type { Sessions } from '../session.js';
import { findApp, type CapmacLaunch } from './adapter.js';

export class ConfigProvider implements vscode.DebugConfigurationProvider {
  constructor(private readonly model: Model, private readonly sessions: Sessions) {}

  /** For a new launch.json. */
  provideDebugConfigurations(): vscode.DebugConfiguration[] {
    return [
      { type: 'capmac', request: 'launch', name: 'CapMac: Live', mode: 'live' },
      { type: 'capmac', request: 'launch', name: 'CapMac: Run', mode: 'run' },
    ];
  }

  async resolveDebugConfiguration(folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration): Promise<vscode.DebugConfiguration | undefined> {
    // F5 with no launch.json, CapMac picked: the current app.
    if (!config.type && !config.request && !config.name) {
      const app = this.model.current();
      if (!app) {
        void vscode.window.showWarningMessage(s.session.noApp, { detail: s.session.noAppHint } as vscode.MessageOptions);
        return undefined;
      }
      config = { type: 'capmac', request: 'launch', name: `${studio.common.live}: ${app.app.name}`, projectPath: app.project.dir, app: app.app.id };
    }
    if (folder && !config.projectPath) config.projectPath = folder.uri.fsPath;
    config.internalConsoleOptions ??= 'openOnSessionStart';
    return config;
  }

  async resolveDebugConfigurationWithSubstitutedVariables(_folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration): Promise<vscode.DebugConfiguration | undefined> {
    if (this.model.engine.state !== 'ready') {
      void vscode.window.showWarningMessage(s.engine.starting);
      return undefined;
    }
    if (!this.model.apps.length) await this.model.detect();
    const app = findApp(this.model, config as CapmacLaunch);
    if (!app) {
      void vscode.window.showWarningMessage(s.session.noApp, { detail: s.session.noAppHint } as vscode.MessageOptions);
      return undefined;
    }
    // A launch.json entry for a project: it becomes the app CapMac works on.
    if (this.model.current()?.key !== app.key) await this.model.useApp(app);
    if (!(await this.sessions.ready(app))) return undefined;
    return config;
  }
}

/**
 * The dropdown's entries: Live and Run for each app, where it runs now. VS
 * Code asks once for each workspace folder, and again for the workspace and
 * the user's settings: an app comes under the folder it was found in.
 */
export class DynamicConfigProvider implements vscode.DebugConfigurationProvider {
  constructor(private readonly model: Model) {}

  provideDebugConfigurations(folder: vscode.WorkspaceFolder | undefined): vscode.DebugConfiguration[] {
    if (!folder) return [];
    const found = new Set(this.model.searches.get(keyOf(folder.uri.fsPath))?.projects.map((p) => keyOf(p.dir)));
    const configs: vscode.DebugConfiguration[] = [];
    for (const app of this.model.runnableApps()) {
      if (!found.has(keyOf(app.project.dir))) continue;
      const dest = this.model.resolveDestination(app);
      const where = dest.kind === 'none' ? '' : ` · ${dest.label}`;
      for (const mode of ['live', 'run'] as const) {
        configs.push({
          type: 'capmac',
          request: 'launch',
          name: `${mode === 'live' ? studio.common.live : studio.common.run}: ${app.app.name}${where}`,
          mode,
          projectPath: app.project.dir,
          app: app.app.id,
        });
      }
      // A React Native app as people get it: a release build with its JavaScript inside.
      if (isNative(app.project.framework)) configs.push({ type: 'capmac', request: 'launch', name: `${s.cmd.runRelease}: ${app.app.name}${where}`, mode: 'run', configuration: 'Release', projectPath: app.project.dir, app: app.app.id });
    }
    return configs;
  }
}
