/**
 * Per-project run state (timeline, problems, app, live mode), built from
 * engine events. Events arrive in batches; each batch becomes one update.
 */
import { create } from 'zustand';
import type { Diagnostic, Envelope, ErrorInfo, HostEvent, Target } from '../../shared/contract';
import { t } from '../../shared/i18n';
import { projectKey } from './projects';

export type TimelinePhase = 'web' | 'sync' | 'deps' | 'electron' | 'cap' | 'build' | 'boot' | 'install' | 'launch' | 'archive' | 'export' | 'download';

export const RUN_PHASES: TimelinePhase[] = ['web', 'sync', 'deps', 'cap', 'build', 'boot', 'install', 'launch'];
export const IPA_PHASES: TimelinePhase[] = ['web', 'sync', 'deps', 'cap', 'archive', 'export', 'download'];
/** An Electron app on the Mac's desktop; Capacitor's adds its web build and `cap copy`. */
export const ELECTRON_PHASES: TimelinePhase[] = ['sync', 'deps', 'electron', 'build', 'launch'];
export const CAP_ELECTRON_PHASES: TimelinePhase[] = ['web', 'sync', 'deps', 'electron', 'cap', 'build', 'launch'];
/** Built on this PC: no copy to a Mac, no cap sync, no simulator. */
export const PC_PHASES: TimelinePhase[] = ['web', 'deps', 'build', 'install', 'launch'];
export const PC_IPA_PHASES: TimelinePhase[] = ['web', 'deps', 'build'];
export const PHASE_LABELS: Record<TimelinePhase, string> = t.phases;

/** A step's name: some read differently for an Electron app ("Build", not "Xcode build"), or on this PC. */
export function phaseLabel(phase: TimelinePhase, onMac: boolean, pc = false): string {
  if (pc) return (t.pc.phases as Partial<Record<TimelinePhase, string>>)[phase] ?? PHASE_LABELS[phase];
  return (onMac ? (t.phasesMac as Partial<Record<TimelinePhase, string>>)[phase] : undefined) ?? PHASE_LABELS[phase];
}

/** The target id of the Mac's desktop (where Electron apps run); see core's MAC_TARGET_ID. */
export const MAC_TARGET_ID = 'mac-desktop';

export interface PhaseState {
  status: 'pending' | 'running' | 'done' | 'skipped' | 'failed' | 'cancelled';
  title?: string;
  detail?: string;
  progress?: string;
  fraction?: number;
  ms?: number;
  startedAt?: number;
}

export interface LiveState {
  devServerUrl: string | null;
  external: boolean;
  command: string | null;
  tunnel: 'pending' | 'up' | 'down';
  liveUrl: string | null;
  localUrl: string | null;
  hmr: 'waiting' | 'connected' | 'disconnected';
  hmrUpdatedAt: number | null;
  lastNativeChange: { paths: string[]; at: number } | null;
}

export interface Note {
  id: number;
  level: 'note' | 'info' | 'success' | 'warn' | 'error';
  message: string;
  hint?: string;
  at: number;
}

export type RunStatus = 'idle' | 'starting' | 'building' | 'running' | 'stopping' | 'failed' | 'stopped' | 'done';

export interface RunState {
  path: string;
  sessionId: string | null;
  mode: 'run' | 'live' | 'ipa' | null;
  status: RunStatus;
  runNumber: number;
  startedAt: number | null;
  endedAt: number | null;
  phases: Partial<Record<TimelinePhase, PhaseState>>;
  stepPhase: Record<string, TimelinePhase>;
  /** Before its first build step: what the run does, like checking this PC's build tools. */
  preparing: { id: string; title: string } | null;
  diagnostics: Diagnostic[];
  error: ErrorInfo | null;
  notes: Note[];
  app: { state: 'launching' | 'running' | 'exited' | 'stopped'; name?: string; target?: string; exitCode?: number | null; at: number } | null;
  target: Target | null;
  /** The app runs on the Mac's desktop (an Electron app). */
  onMac: boolean;
  /** Where it builds: the Mac, or this PC (and the iPhone plugged into it). */
  backend: 'mac' | 'wsl';
  mac: string | null;
  live: LiveState | null;
  buildLogPath: string | null;
  ipa: { file: string; size: number } | null;
  /** The last finished run, shown dimmed until the next one starts. */
  previous: { runNumber: number; phases: Partial<Record<TimelinePhase, PhaseState>>; ms: number | null; ok: boolean } | null;
}

export function emptyRun(path: string): RunState {
  return {
    path,
    sessionId: null,
    mode: null,
    status: 'idle',
    runNumber: 0,
    startedAt: null,
    endedAt: null,
    phases: {},
    stepPhase: {},
    preparing: null,
    diagnostics: [],
    error: null,
    notes: [],
    app: null,
    target: null,
    onMac: false,
    backend: 'mac',
    mac: null,
    live: null,
    buildLogPath: null,
    ipa: null,
    previous: null,
  };
}

export const isActive = (run: RunState | undefined) => Boolean(run && run.sessionId && !['stopped', 'done'].includes(run.status));
export const isBusy = (run: RunState | undefined) => Boolean(run && (run.status === 'starting' || run.status === 'building' || run.status === 'stopping'));

const TIMELINE = new Set<string>([...RUN_PHASES, ...IPA_PHASES, ...CAP_ELECTRON_PHASES]);
let noteId = 1;

interface RunsState {
  byKey: Record<string, RunState>;
  apply(batch: Envelope[]): void;
  clearProblems(path: string): void;
}

/** Starts a fresh run (a new session, or a new live-reload cycle). */
function newRun(run: RunState, mode: RunState['mode']): RunState {
  const finished = run.runNumber > 0 && Object.keys(run.phases).length > 0;
  const next: RunState = {
    ...run,
    mode,
    runNumber: run.runNumber + 1,
    status: 'building',
    startedAt: Date.now(),
    endedAt: null,
    phases: {},
    stepPhase: {},
    preparing: null,
    diagnostics: [],
    error: null,
    notes: [],
    buildLogPath: null,
    ipa: null,
    previous: finished ? { runNumber: run.runNumber, phases: run.phases, ms: run.endedAt && run.startedAt ? run.endedAt - run.startedAt : null, ok: run.status !== 'failed' } : run.previous,
  };
  if (mode === 'live') next.phases.web = { status: 'skipped', detail: 'served by your dev server' };
  if (run.target?.kind === 'device') next.phases.boot = { status: 'skipped', detail: 'not needed on a device' };
  return next;
}

function endOpenPhases(run: RunState, status: PhaseState['status']): void {
  for (const [phase, state] of Object.entries(run.phases) as Array<[TimelinePhase, PhaseState]>) {
    if (state.status === 'running') run.phases[phase] = { ...state, status, ms: state.startedAt ? Date.now() - state.startedAt : undefined, progress: undefined };
  }
}

function reduce(run: RunState, event: HostEvent, sessionId: string | undefined, mac: string | undefined): RunState {
  const now = Date.now();
  switch (event.type) {
    case 'session-started': {
      const next = newRun({ ...run, sessionId: sessionId ?? null, mac: event.mac, app: null, onMac: event.target === MAC_TARGET_ID, backend: event.backend ?? 'mac' }, event.mode === 'build' ? 'run' : event.mode);
      next.status = 'starting';
      next.live = event.mode === 'live'
        ? { devServerUrl: null, external: false, command: null, tunnel: 'pending', liveUrl: null, localUrl: null, hmr: 'waiting', hmrUpdatedAt: null, lastNativeChange: null }
        : null;
      return next;
    }
    case 'session': {
      if (event.state === 'building') {
        // A live-reload rebuild after the app was up: a new timeline run.
        return run.status === 'starting' ? { ...run, status: 'building' } : { ...newRun(run, run.mode ?? 'live'), app: run.app };
      }
      if (event.state === 'running') return { ...run, status: 'running', endedAt: run.endedAt ?? now };
      if (event.state === 'idle') return { ...run, status: 'idle' };
      if (event.state === 'failed') {
        const next = { ...run, phases: { ...run.phases }, status: 'failed' as const, error: event.error ?? run.error, endedAt: now };
        endOpenPhases(next, 'failed');
        return next;
      }
      if (event.state === 'stopping') return { ...run, status: 'stopping' };
      return run;
    }
    case 'session-ended': {
      const next = { ...run, phases: { ...run.phases }, sessionId: null, endedAt: run.endedAt ?? now };
      endOpenPhases(next, event.cancelled ? 'cancelled' : event.ok ? 'done' : 'failed');
      if (event.cancelled) next.status = 'stopped';
      else if (!event.ok) {
        next.status = 'failed';
        next.error = event.error ?? next.error;
      } else next.status = run.status === 'failed' ? 'failed' : run.mode === 'ipa' ? 'done' : 'stopped';
      if (next.app && (next.app.state === 'running' || next.app.state === 'launching')) next.app = { ...next.app, state: 'stopped', at: now };
      return next;
    }
    case 'step': {
      if (!TIMELINE.has(event.phase)) return run.status === 'starting' ? { ...run, preparing: { id: event.id, title: event.title } } : run;
      const phase = event.phase as TimelinePhase;
      return {
        ...run,
        preparing: null,
        status: run.status === 'starting' || run.status === 'idle' || run.status === 'running' ? 'building' : run.status,
        phases: { ...run.phases, [phase]: { status: 'running', title: event.title, startedAt: now } },
        stepPhase: { ...run.stepPhase, [event.id]: phase },
      };
    }
    case 'step-progress': {
      const phase = run.stepPhase[event.id];
      const state = phase && run.phases[phase];
      if (!phase || !state || state.status !== 'running') return run;
      return { ...run, phases: { ...run.phases, [phase]: { ...state, progress: event.text, fraction: event.done ?? state.fraction } } };
    }
    case 'step-end': {
      const phase = run.stepPhase[event.id];
      const state = phase && run.phases[phase];
      if (run.preparing?.id === event.id) return { ...run, preparing: null };
      if (!phase || !state) return run;
      const status: PhaseState['status'] = event.status === 'ok' ? 'done' : event.status;
      return { ...run, phases: { ...run.phases, [phase]: { ...state, status, ms: event.ms || (state.startedAt ? now - state.startedAt : undefined), detail: event.detail, progress: undefined } } };
    }
    case 'phase-skipped': {
      if (!TIMELINE.has(event.phase)) return run;
      const phase = event.phase as TimelinePhase;
      if (run.phases[phase]?.status === 'done') return run;
      return { ...run, phases: { ...run.phases, [phase]: { status: 'skipped', detail: event.reason } } };
    }
    case 'diagnostic':
      return { ...run, diagnostics: [...run.diagnostics, event.diagnostic] };
    case 'error': {
      if (event.error.cancelled) return run;
      const next = { ...run, phases: { ...run.phases }, error: event.error, status: 'failed' as const, endedAt: now };
      endOpenPhases(next, 'failed');
      return next;
    }
    case 'app':
      return {
        ...run,
        app: { state: event.state, name: event.name ?? run.app?.name, target: event.target ?? run.app?.target, exitCode: event.exitCode, at: now },
        status: event.state === 'running' ? 'running' : run.status,
        endedAt: event.state === 'running' ? now : run.endedAt,
      };
    case 'target': {
      const next = { ...run, target: event.target, onMac: event.target.kind === 'mac' };
      if (event.target.kind === 'device' && !next.phases.boot) next.phases = { ...next.phases, boot: { status: 'skipped', detail: 'not needed on a device' } };
      return next;
    }
    case 'devserver':
      return run.live ? { ...run, live: { ...run.live, devServerUrl: event.url, external: event.external, command: event.command ?? null } } : run;
    case 'tunnel':
      return run.live ? { ...run, live: { ...run.live, tunnel: event.state, liveUrl: event.liveUrl ?? run.live.liveUrl, localUrl: event.localUrl ?? run.live.localUrl } } : run;
    case 'hmr':
      if (!run.live) return run;
      if (event.state === 'update') return { ...run, live: { ...run.live, hmrUpdatedAt: event.at } };
      return { ...run, live: { ...run.live, hmr: event.state } };
    case 'native-change':
      return run.live ? { ...run, live: { ...run.live, lastNativeChange: { paths: event.paths, at: now } } } : run;
    case 'build-log':
      return { ...run, buildLogPath: event.path };
    case 'ipa-ready':
      return { ...run, ipa: { file: event.file, size: event.size } };
    case 'log': {
      if (event.level === 'debug') return run;
      return { ...run, notes: [...run.notes.slice(-49), { id: noteId++, level: event.level, message: event.message, hint: event.hint, at: now }] };
    }
    default:
      void mac;
      return run;
  }
}

export const useRuns = create<RunsState>((set, get) => ({
  byKey: {},
  apply: (batch) => {
    let changed: Record<string, RunState> | null = null;
    for (const { scope, event } of batch) {
      if (!scope.projectPath) continue;
      const key = projectKey(scope.projectPath);
      changed ??= {};
      const current = changed[key] ?? get().byKey[key] ?? emptyRun(scope.projectPath);
      const next = reduce(current, event, scope.sessionId, scope.mac);
      if (next !== current) changed[key] = next;
    }
    if (changed && Object.keys(changed).length) set((s) => ({ byKey: { ...s.byKey, ...changed } }));
  },
  clearProblems: (path) =>
    set((s) => {
      const key = projectKey(path);
      const run = s.byKey[key];
      return run ? { byKey: { ...s.byKey, [key]: { ...run, diagnostics: [] } } } : s;
    }),
}));

export function useRun(path: string | null): RunState | undefined {
  return useRuns((s) => (path ? s.byKey[projectKey(path)] : undefined));
}
