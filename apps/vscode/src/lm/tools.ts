/**
 * CapMac as tools for AI agents in VS Code (Copilot's agent mode and any
 * extension using the language model API): see what runs where, run and stop
 * the app, look at its screen, read its console. The same things the CapMac
 * skill teaches terminal agents to do with the capmac command.
 */
import * as vscode from 'vscode';
import { s, studio, tidy } from '../i18n.js';
import type { Sessions } from '../session.js';
import { keyOf, pcReady, type Model } from '../state/model.js';
import { isActive, isNative, phaseLabel, phasesFor } from '../state/runs.js';
import { appKind, frameworkName, macState } from '../ui/format.js';

const text = (value: string) => new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(value)]);

export function registerTools(context: vscode.ExtensionContext, model: Model, sessions: Sessions): void {
  if (typeof vscode.lm?.registerTool !== 'function') return;
  context.subscriptions.push(
    vscode.lm.registerTool('capmac_status', { invoke: async () => text(statusReport(model)) }),
    vscode.lm.registerTool<{ mode?: 'run' | 'live'; target?: string }>('capmac_run', {
      prepareInvocation: (options) => {
        const app = model.current();
        const mode = options.input.mode ?? 'live';
        const where = app ? model.resolveDestination(app).label : '';
        return {
          invocationMessage: app ? s.lm.runningOn(app.app.name, options.input.target ?? where) : undefined,
          confirmationMessages: app ? { title: s.lm.runConfirmTitle, message: s.lm.runConfirm(app.app.name, options.input.target ?? where, mode) } : undefined,
        };
      },
      invoke: async (options, token) => runTool(model, sessions, options.input, token),
    }),
    vscode.lm.registerTool('capmac_stop', {
      prepareInvocation: () => ({ confirmationMessages: { title: s.lm.stopConfirmTitle, message: model.current()?.app.name ?? '' } }),
      invoke: async () => {
        const app = model.current();
        if (!app || !model.activeSession(app)) return text(s.lm.notRunning);
        await sessions.stop(app);
        return text(s.lm.stopped);
      },
    }),
    vscode.lm.registerTool('capmac_screenshot', { invoke: async () => screenshotTool(model) }),
    vscode.lm.registerTool<{ lines?: number; level?: 'all' | 'warn' | 'error' }>('capmac_logs', {
      invoke: async (options) => {
        const app = model.current();
        if (!app) return text(s.lm.noApp);
        const levels = options.input.level === 'error' ? ['error'] : options.input.level === 'warn' ? ['error', 'warn'] : null;
        const count = Math.max(1, Math.min(1000, Math.floor(options.input.lines ?? 100)));
        const lines = (model.logs.get(keyOf(app.project.dir)) ?? []).filter((l) => !levels || levels.includes(l.level)).slice(-count);
        if (!lines.length) return text('No console output yet.');
        return text(lines.map((l) => `${new Date(l.ts).toISOString().slice(11, 23)} [${l.source}${l.level !== 'log' && l.level !== 'info' ? ` ${l.level}` : ''}] ${l.text}`).join('\n'));
      },
    }),
  );
}

/** What CapMac sees: apps, where the current one runs, Macs, this PC, and the run. */
export function statusReport(model: Model): string {
  const out: string[] = [];
  if (model.engine.state !== 'ready') return 'CapMac is starting. Try again in a moment.';
  if (!model.apps.length) return s.lm.noApp;
  out.push('Apps in this workspace:');
  const current = model.current();
  for (const app of model.apps) {
    const mark = app.key === current?.key ? '* ' : '- ';
    out.push(`${mark}${app.app.name}: ${frameworkName(app)} ${appKind(app)}${app.runnable ? '' : ' (CapMac cannot run it yet)'} [${app.project.dir}]${app.key === current?.key ? ' (current: Run and Live use it)' : ''}`);
  }
  if (!current) return out.join('\n');
  const dest = model.resolveDestination(current);
  out.push('', `Where it runs: ${dest.kind === 'none' ? 'nowhere yet (no Mac paired)' : `${dest.label}${dest.detail ? ` (${dest.detail})` : ''}${dest.kind === 'auto' ? ', picked automatically' : ''}`}`);
  if (model.macs.length) out.push(`Macs: ${model.macs.map((m) => `${m.label} (${macState(m)}${m.isDefault ? ', default' : ''})`).join('; ')}`);
  if (current.app.id === 'ios' && process.platform === 'win32') {
    const pc = model.pc.get(keyOf(current.project.dir));
    out.push(`This PC (no Mac): ${model.backendOf(current) === 'wsl' ? 'selected, ' : ''}${pcReady(pc?.status) ? 'set up' : 'not set up'}${pc?.devices?.devices.length ? `, iPhones: ${pc.devices.devices.map((d) => d.name).join(', ')}` : ''}`);
  }
  const mac = model.macFor(current);
  const targets = mac ? model.targets.get(mac.name) : null;
  if (current.app.id === 'ios' && targets) {
    out.push(`Simulators on ${mac!.label}: ${targets.simulators.filter((t) => t.available).map((t) => `${t.name} (${t.os}${t.state === 'Booted' ? ', running' : ''})`).join(', ') || 'none'}`);
    if (targets.devices.length) out.push(`iPhones and iPads on ${mac!.label}: ${targets.devices.map((t) => `${t.name} (${t.os}, ${t.state})`).join(', ')}`);
  }
  const run = model.runOf(current);
  if (!run || run.runNumber === 0) {
    out.push('', 'Nothing has run yet. Use capmac_run to start the app.');
    return out.join('\n');
  }
  out.push('', `Run #${run.runNumber}: ${run.mode ?? 'run'}, ${isActive(run) ? 'going on' : 'ended'}, status ${run.status}${run.target ? ` on ${run.target.name}` : ''}${run.app ? `; the app is ${run.app.state}` : ''}`);
  const summary = model.summaryOf(current);
  const where = { onMac: run.onMac, onPc: run.onPc, pc: run.backend === 'wsl', flutter: current.project.framework === 'flutter', reactNative: isNative(current.project.framework) };
  for (const phase of phasesFor(run, { flutter: where.flutter, native: where.reactNative, capacitorElectron: summary?.electron?.flavor === 'capacitor' })) {
    const st = run.phases[phase];
    out.push(`  ${phaseLabel(phase, where)}: ${st?.status ?? 'pending'}${st?.detail ? ` (${tidy(st.detail)})` : ''}${st?.progress ? ` (${tidy(st.progress)})` : ''}`);
  }
  if (run.error) out.push(`Error: ${tidy(run.error.message)}${run.error.hint ? `. ${tidy(run.error.hint)}` : ''}`, ...(run.error.details?.slice(-20).map((l) => `  | ${l}`) ?? []));
  const problems = run.diagnostics.filter((d) => d.severity === 'error' || (d.severity === 'warning' && d.own)).slice(0, 30);
  if (problems.length) {
    out.push('Build problems:');
    for (const d of problems) out.push(`  ${d.file ?? ''}${d.line ? `:${d.line}${d.column ? `:${d.column}` : ''}` : ''} ${d.severity}: ${d.message}`);
  }
  if (run.live?.devServerUrl) out.push(`Live reload: dev server ${run.live.devServerUrl}; saving a file reloads the app.`);
  if (run.ipa) out.push(`IPA: ${run.ipa.file}`);
  return out.join('\n');
}

async function runTool(model: Model, sessions: Sessions, input: { mode?: 'run' | 'live'; target?: string }, token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
  const app = model.current();
  if (!app) return text(s.lm.noApp);
  if (input.target) {
    const wanted = input.target.toLowerCase();
    const mac = model.macFor(app);
    const targets = mac ? model.targets.get(mac.name) ?? (await model.refreshTargets(mac.name)) : null;
    const all = targets ? [...targets.simulators, ...targets.devices] : [];
    const found = all.find((t) => t.udid.toLowerCase() === wanted) ?? all.find((t) => t.name.toLowerCase() === wanted) ?? all.find((t) => t.name.toLowerCase().includes(wanted));
    if (found && mac) await model.setDestination(app, { mac: mac.name, target: found.udid });
  }
  const mode = input.mode ?? 'live';
  const before = model.runOf(app)?.runNumber ?? 0;
  // The debug session this start makes, and whether it ended (a start the engine turns down ends it with no run to look at).
  let ours: vscode.DebugSession | undefined;
  let oursEnded: (() => void) | null = null;
  let endedEarly = false;
  const project = keyOf(app.project.dir);
  const watching = [
    vscode.debug.onDidStartDebugSession((session) => {
      if (!ours && session.type === 'capmac' && keyOf(String(session.configuration.projectPath ?? '')) === project) ours = session;
    }),
    vscode.debug.onDidTerminateDebugSession((session) => {
      if (session !== ours) return;
      if (oursEnded) oursEnded();
      else endedEarly = true;
    }),
  ];
  try {
    const started = await sessions.start(app, mode);
    if (!started) return text(s.lm.failed('it could not start (see the notification in VS Code)'));
    // Wait for the app to run, or the build to fail.
    const result = await new Promise<string>((resolve) => {
      const deadline = setTimeout(() => finish(s.lm.timedOut), 15 * 60_000);
      const check = () => {
        const run = model.runOf(app);
        if (!run || run.runNumber <= before) return;
        if (run.app?.state === 'running' || (run.status === 'running' && run.mode === 'live')) {
          const where = run.target?.name ?? model.resolveDestination(app).label;
          finish(mode === 'live' ? s.lm.live(app.app.name, where) : s.lm.started(app.app.name, where));
        } else if (run.status === 'failed' || (!isActive(run) && run.status !== 'starting')) {
          finish(`${s.lm.failed(tidy(run.error?.message) ?? run.status)}\n\n${statusReport(model)}`);
        }
      };
      const listener = model.onDidChange((change) => change === 'runs' && check());
      const cancel = token.onCancellationRequested(() => finish('Stopped waiting; the run goes on. Check capmac_status.'));
      // The run's own end, if it had one, comes with the model's next change.
      oursEnded = () =>
        setTimeout(() => {
          check();
          finish(`${s.lm.failed('it stopped before the app ran (the Debug Console says why)')}\n\n${statusReport(model)}`);
        }, 300);
      let done = false;
      function finish(message: string) {
        if (done) return;
        done = true;
        clearTimeout(deadline);
        listener.dispose();
        cancel.dispose();
        resolve(message);
      }
      if (endedEarly) oursEnded();
      check();
    });
    return text(result);
  } finally {
    for (const disposable of watching) disposable.dispose();
  }
}

async function screenshotTool(model: Model): Promise<vscode.LanguageModelToolResult> {
  const app = model.current();
  if (!app) return text(s.lm.noApp);
  const screen = model.screenFor(app);
  if (!screen) return text(s.lm.noScreen);
  const shot = await model.client.invoke('screen.screenshot', { mac: screen.mac, udid: screen.udid, projectPath: screen.projectPath });
  const caption = `Screenshot of ${screen.name}${shot.width ? ` (${shot.width}×${shot.height})` : ''}`;
  // Images in tool results arrived in VS Code 1.110; older ones get the file.
  const DataPart = (vscode as unknown as { LanguageModelDataPart?: { image(data: Uint8Array, mime: string): unknown } }).LanguageModelDataPart;
  if (DataPart) return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(caption), DataPart.image(new Uint8Array(shot.png), 'image/png') as vscode.LanguageModelTextPart]);
  const { promises: fs } = await import('node:fs');
  const path = await import('node:path');
  const dir = path.join(app.project.dir, '.capmac', 'screenshots');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `agent-${Date.now()}.png`);
  await fs.writeFile(file, Buffer.from(shot.png));
  return text(`${caption}. ${s.lm.shotSaved(file)}`);
}

void studio;
