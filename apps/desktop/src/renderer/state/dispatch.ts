/** Routes engine event batches to the stores that show them. */
import type { Envelope } from '../../shared/contract';
import { toast, useApp } from './app';
import { consoleFor, type ConsoleLevel } from './console';
import { useMacs, useTargets } from './macs';
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

function showsProject(path: string): boolean {
  const route = useApp.getState().route;
  return route.name === 'project' && projectKey(route.path) === projectKey(path);
}

export function handleBatch(batch: Envelope[]): void {
  useRuns.getState().apply(batch);
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
          buffer.pushText('capmac', `Native change (${event.paths.slice(0, 3).join(', ')}${event.paths.length > 3 ? ` +${event.paths.length - 3}` : ''}): rebuilding`, 'info');
          break;
        case 'session-started':
          buffer.pushText('capmac', event.mode === 'live' ? 'Live reload started' : event.mode === 'ipa' ? 'Building an .ipa' : 'Run started', 'info');
          break;
        case 'app':
          if (event.state === 'running') buffer.pushText('capmac', `${event.name ?? 'The app'} is running on ${event.target ?? 'the simulator'}`, 'info');
          if (event.state === 'exited') buffer.pushText('capmac', `The app exited${event.exitCode !== null && event.exitCode !== undefined ? ` (code ${event.exitCode})` : ''}`, 'info');
          break;
        case 'session-ended':
          if (!event.ok && event.error) {
            buffer.pushText('capmac', event.error.hint ? `${event.error.message} → ${event.error.hint}` : event.error.message, 'error');
            if (!showsProject(scope.projectPath)) {
              const path = scope.projectPath;
              toast({ tone: 'critical', title: `${projectName(path)}: ${event.mode === 'ipa' ? 'export' : 'build'} failed`, body: event.error.message, action: { label: 'Open', run: () => useApp.getState().navigate({ name: 'project', path }) } });
            }
          }
          break;
        case 'ipa-ready': {
          const file = event.file;
          toast({ tone: 'success', title: 'IPA ready', body: file.split(/[\\/]/).pop(), action: { label: 'Show in folder', run: () => void window.capmac.invoke('app:show-in-folder', { path: file }) }, timeout: 0 });
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
