/**
 * Setting up this PC to build iPhone apps with no Mac (the WSL backend):
 * build tools, the iPhone connection, one Apple sign-in, signing, Xcode's
 * download and the iPhone SDK, in a progress notification that can be
 * stopped and continued later.
 */
import * as vscode from 'vscode';
import { s, studio, tidy } from './i18n.js';
import { errorText, keyOf, pcReady, type Model, type WorkspaceApp } from './state/model.js';

/** Studio's setup steps, and the engine phases each one covers (renderer/state/pc.ts). */
const SETUP_STEPS = [
  { id: 'tools', phases: ['wsl', 'dependencies'] },
  { id: 'devices', phases: ['apple-devices'] },
  { id: 'signIn', phases: ['apple-sign-in'] },
  { id: 'signing', phases: ['signing'] },
  { id: 'download', phases: ['apple-catalog', 'apple-download'] },
  { id: 'sdk', phases: ['sdk-import'] },
] as const;

const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;

export async function setupPc(model: Model, app: WorkspaceApp, options: { appleLogin?: boolean } = {}): Promise<boolean> {
  if (process.platform !== 'win32') {
    void vscode.window.showInformationMessage(s.pcSetup.windowsOnly);
    return false;
  }
  const projectPath = app.project.dir;
  let setupId: string;
  try {
    setupId = (await model.client.invoke('wsl.setup', { projectPath, appleLogin: options.appleLogin })).setupId;
  } catch (err) {
    void vscode.window.showErrorMessage(`${studio.pc.setupFailed}: ${errorText(err).message}`);
    return false;
  }
  model.pcFor(projectPath).setupId = setupId;
  model.emit('pc');
  const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: s.pcSetup.title, cancellable: true }, (progress, token) =>
    new Promise<{ ok: boolean; cancelled: boolean; error?: string; hint?: string }>((resolve) => {
      token.onCancellationRequested(() => void model.client.call('wsl.stopSetup', { setupId }));
      let reported = 0;
      const report = () => {
        const state = model.pcFor(projectPath);
        // The step that runs now, else the last one that ran.
        let index = -1;
        for (let i = 0; i < SETUP_STEPS.length; i++) if (SETUP_STEPS[i]!.phases.some((p) => state.phases[p]?.state === 'running')) index = i;
        if (index < 0) for (let i = 0; i < SETUP_STEPS.length; i++) if (SETUP_STEPS[i]!.phases.some((p) => state.phases[p])) index = i;
        if (index < 0) return;
        const step = SETUP_STEPS[index]!;
        const phase = [...step.phases].reverse().find((p) => state.phases[p]) ?? step.phases[0];
        const ph = state.phases[phase];
        const title = studio.pc.steps[step.id].title;
        let detail = '';
        if (ph?.bytes) {
          detail = ph.bytes.total ? studio.pc.progress(gb(ph.bytes.received), gb(ph.bytes.total)) : gb(ph.bytes.received);
          if (ph.bytes.resumedFrom) detail += ` · ${studio.pc.continuedFrom(gb(ph.bytes.resumedFrom))}`;
        } else if (typeof ph?.fraction === 'number') detail = studio.pc.percent(Math.round(ph.fraction * 100));
        else if (ph?.detail) detail = tidy(ph.detail);
        else detail = state.lines[state.lines.length - 1] ?? '';
        // Overall: each step a sixth, the running one by its own progress.
        const own = ph?.bytes?.total ? ph.bytes.received / ph.bytes.total : typeof ph?.fraction === 'number' ? ph.fraction : 0;
        const overall = Math.round(((index + (ph?.state === 'running' ? own : 1)) / SETUP_STEPS.length) * 100);
        const increment = Math.max(0, overall - reported);
        reported += increment;
        progress.report({ message: `${s.pcSetup.step(index + 1, SETUP_STEPS.length, title)}${detail ? ` · ${detail.slice(0, 120)}` : ''}`, increment });
      };
      const listener = model.onEnvelopes((batch) => {
        let changed = false;
        for (const { scope, event } of batch) {
          if (!scope.setup || keyOf(scope.setup) !== keyOf(projectPath)) continue;
          changed = true;
          if (event.type === 'setup-ended') {
            listener.dispose();
            resolve({ ok: event.ok && !event.cancelled, cancelled: event.cancelled, error: event.error ? tidy(event.error.message) : undefined, hint: event.error ? tidy(event.error.hint) : undefined });
            return;
          }
        }
        if (changed) report();
      });
    }),
  );
  await model.refreshPc(projectPath);
  if (result.cancelled) {
    void vscode.window.showInformationMessage(s.pcSetup.stopped);
    return false;
  }
  if (!result.ok) {
    const check = studio.pc.check;
    const again = studio.pc.continue;
    const answer = await vscode.window.showErrorMessage(`${s.pcSetup.failed}${result.error ? `: ${result.error}` : ''}`, { detail: result.hint } as vscode.MessageOptions, again, check);
    if (answer === again) return setupPc(model, app);
    if (answer === check) await checkPc(model, app);
    return false;
  }
  // Set up for this app: it builds here from now on.
  if (model.backendOf(app) !== 'wsl') await model.setBackend(app, 'wsl').catch(() => undefined);
  void vscode.window.showInformationMessage(s.pcSetup.ready, { detail: s.pcSetup.readyBody } as vscode.MessageOptions);
  return pcReady(model.pc.get(keyOf(projectPath))?.status);
}

/** This PC's health check (`capmac wsl doctor`), as a list. */
export async function checkPc(model: Model, app: WorkspaceApp): Promise<void> {
  const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `${studio.pc.check}…` }, () => model.client.call('wsl.doctor', { projectPath: app.project.dir }));
  if (!result.ok) {
    void vscode.window.showErrorMessage(errorText(result.error).message);
    return;
  }
  const icons: Record<string, string> = { ok: '$(pass)', warn: '$(warning)', fail: '$(error)', info: '$(info)' };
  const items = result.value.checks.map((c) => ({ label: `${icons[c.level] ?? ''} ${c.label}`, description: c.detail ? tidy(c.detail) : undefined, detail: c.fix && c.level !== 'ok' ? `→ ${tidy(c.fix)}` : undefined }));
  const problems = result.value.checks.filter((c) => c.level === 'fail' || c.level === 'warn').length;
  const setUp = { label: `$(desktop-download) ${result.value.ready ? studio.pc.signInAgain : studio.pc.continue}`, detail: result.value.ready ? studio.pc.signInAgainHint : undefined, action: true };
  const picked = await vscode.window.showQuickPick([...items, { label: '', kind: vscode.QuickPickItemKind.Separator }, setUp], {
    title: result.value.ready ? s.pcSetup.allGood : s.pcSetup.issues(problems),
    placeHolder: studio.pc.checksTitle,
  });
  if (picked && 'action' in picked) await setupPc(model, app, { appleLogin: result.value.ready });
}
