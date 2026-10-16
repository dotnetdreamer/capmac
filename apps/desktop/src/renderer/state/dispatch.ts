/** Routes engine event batches to the stores that show them. */
import type { AppDialog, Envelope } from '../../shared/contract';
import { t, tidy } from '../../shared/i18n';
import { toast, useApp } from './app';
import { consoleFor, type ConsoleLevel } from './console';
import { useMacs, useTargets } from './macs';
import { usePc } from './pc';
import { projectKey } from './projects';
import { useRuns } from './runs';

const LOG_LEVEL: Record<string, ConsoleLevel> = { note: 'debug', info: 'info', success: 'info', warn: 'warn', error: 'error' };

/** Dev servers print plain text: spot their errors and warnings. */
function devServerLevel(text: string): ConsoleLevel {
  if (/\b(error|failed|cannot|could not|exception)\b|✘|\bERR!/i.test(text)) return 'error';
  if (/\bwarn(ing)?\b|\(!\)|⚠/i.test(text)) return 'warn';
  return 'log';
}

function projectName(path: string): string {
  const recent = useApp.getState().settings?.recentProjects.find((p) => projectKey(p.path) === projectKey(path));
  return recent?.name ?? path.split(/[\\/]/).pop() ?? path;
}

/** Dialogs already announced, per project (each comes again with every change). */
const announcedDialogs = new Map<string, Set<number>>();

function dialogLine(dialog: AppDialog): string {
  const app = dialog.app || t.common.theApp;
  if (dialog.kind === 'message') return t.appDialog.asks(app, dialog.message || dialog.title || t.appDialog.message);
  if (dialog.kind === 'save') return t.appDialog.wantsSave(app);
  return dialog.properties.includes('openDirectory') && !dialog.properties.includes('openFile') ? t.appDialog.wantsFolder(app) : t.appDialog.wantsFile(app);
}

function showsProject(path: string): boolean {
  const route = useApp.getState().route;
  return route.name === 'project' && projectKey(route.path) === projectKey(path);
}

export function handleBatch(batch: Envelope[]): void {
  useRuns.getState().apply(batch);
  // Setting up this PC: its events carry `scope.setup`, not a project's session.
  if (batch.some((envelope) => envelope.scope.setup)) usePc.getState().apply(batch);
  const verbose = useApp.getState().settings?.verbose ?? false;
  for (const { scope, event } of batch) {
    if (scope.projectPath) {
      const buffer = consoleFor(scope.projectPath);
      switch (event.type) {
        case 'app-log':
          buffer.pushApp(event.entry);
          break;
        case 'devserver-output':
          buffer.pushText('web', event.text, devServerLevel(event.text));
          break;
        case 'log':
          if (event.level !== 'debug' || verbose) buffer.pushText('capmac', event.hint ? `${event.message} → ${event.hint}` : event.message, LOG_LEVEL[event.level] ?? 'log');
          break;
        case 'tool-output':
          // Raw build output (web build, npm install): dimmed, filterable as Debug.
          buffer.pushText('capmac', event.text, 'debug');
          break;
        case 'error':
          if (!event.error.cancelled) buffer.pushText('capmac', event.error.hint ? `${event.error.message} → ${event.error.hint}` : event.error.message, 'error');
          break;
        case 'native-change':
          buffer.pushText('capmac', t.console.nativeChange(event.paths.slice(0, 3).join(', '), Math.max(0, event.paths.length - 3)), 'info');
          break;
        case 'session-started':
          buffer.pushText('capmac', event.mode === 'live' ? t.console.liveStarted : event.mode === 'ipa' ? t.console.ipaStarted : t.console.runStarted, 'info');
          break;
        case 'app-dialogs': {
          // An Electron app asks something: it shows over the app's window, and in the console.
          const seen = announcedDialogs.get(scope.projectPath) ?? new Set<number>();
          announcedDialogs.set(scope.projectPath, seen);
          const open = new Set(event.dialogs.map((d) => d.id));
          for (const id of [...seen]) if (!open.has(id)) seen.delete(id);
          if (event.closed?.how === 'mac') {
            const gone = event.closed;
            buffer.pushText('capmac', t.appDialog.movedToMac(event.dialogs[0]?.app || t.common.theApp), 'info');
            seen.delete(gone.id);
          }
          for (const dialog of event.dialogs) {
            if (seen.has(dialog.id)) continue;
            seen.add(dialog.id);
            buffer.pushText('capmac', `${dialogLine(dialog)} → ${t.appDialog.answerOver}`, 'warn');
            if (!showsProject(scope.projectPath)) {
              const path = scope.projectPath;
              toast({ tone: 'caution', title: t.appDialog.waiting(dialog.app || projectName(path)), body: dialogLine(dialog), action: { label: t.common.open, run: () => useApp.getState().navigate({ name: 'project', path }) } });
            }
          }
          break;
        }
        case 'app':
          if (event.state === 'running') buffer.pushText('capmac', t.console.appRunning(event.name ?? t.common.theApp, event.target ?? t.common.theSimulator), 'info');
          if (event.state === 'exited') buffer.pushText('capmac', t.console.appExited(event.exitCode), 'info');
          break;
        case 'session-ended':
          if (!event.ok && event.error) {
            buffer.pushText('capmac', event.error.hint ? `${event.error.message} → ${event.error.hint}` : event.error.message, 'error');
            if (!showsProject(scope.projectPath)) {
              const path = scope.projectPath;
              toast({ tone: 'critical', title: t.console.buildFailed(projectName(path), event.mode === 'ipa'), body: tidy(event.error.message), action: { label: t.common.open, run: () => useApp.getState().navigate({ name: 'project', path }) } });
            }
          }
          break;
        case 'ipa-ready': {
          const file = event.file;
          toast({ tone: 'success', title: t.ipa.ready, body: file.split(/[\\/]/).pop(), action: { label: t.common.showInFolder, run: () => void window.capmac.invoke('app:show-in-folder', { path: file }) }, timeout: 0 });
          break;
        }
        default:
          break;
      }
      continue;
    }
    if (scope.mac) {
      switch (event.type) {
        case 'connection':
          useMacs.getState().setConnection(scope.mac, event.state, { attempt: event.attempt, error: event.error, latencyMs: event.latencyMs, label: event.label, route: event.route, rttMs: event.rttMs });
          break;
        case 'targets':
          useTargets.getState().set(scope.mac, event.targets);
          break;
        case 'check':
          useMacs.getState().applyCheck(scope.mac, event.check);
          break;
        case 'step':
          if (scope.mac === '#pairing') useMacs.setState((s) => ({ pairing: [...s.pairing, { id: event.id, title: event.title, status: 'running' }] }));
          break;
        case 'step-end':
          if (scope.mac === '#pairing') {
            useMacs.setState((s) => ({ pairing: s.pairing.map((p) => (p.id === event.id ? { ...p, status: event.status === 'ok' ? 'ok' : event.status, detail: event.detail } : p)) }));
          }
          break;
        default:
          break;
      }
    }
    if (event.type === 'macs-changed') void useMacs.getState().refresh();
  }
}
