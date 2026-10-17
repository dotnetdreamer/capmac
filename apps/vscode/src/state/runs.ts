/**
 * Per-project run state (the timeline, problems, the app, live reload), built
 * from engine events, as CapMac Studio builds it (apps/desktop/src/renderer/
 * state/runs.ts). Kept free of VS Code so it is unit-tested on its own.
 */
import type { Diagnostic, ErrorInfo, HostEvent, Target } from '../../../desktop/src/shared/contract.js';
import { s, studio } from '../i18n.js';

export type TimelinePhase = 'web' | 'devserver' | 'sync' | 'deps' | 'electron' | 'cap' | 'build' | 'boot' | 'install' | 'launch' | 'archive' | 'export' | 'download';

export const RUN_PHASES: TimelinePhase[] = ['web', 'sync', 'deps', 'cap', 'build', 'boot', 'install', 'launch'];
export const IPA_PHASES: TimelinePhase[] = ['web', 'sync', 'deps', 'cap', 'archive', 'export', 'download'];
/** An Electron app on the Mac's desktop; Capacitor's adds its web build and `cap copy`. */
export const ELECTRON_PHASES: TimelinePhase[] = ['sync', 'deps', 'electron', 'build', 'launch'];
export const CAP_ELECTRON_PHASES: TimelinePhase[] = ['web', 'sync', 'deps', 'electron', 'cap', 'build', 'launch'];
/** Built on this PC: no copy to a Mac, no cap sync, no simulator. */
export const PC_PHASES: TimelinePhase[] = ['web', 'deps', 'build', 'install', 'launch'];
export const PC_IPA_PHASES: TimelinePhase[] = ['web', 'deps', 'build'];
/** A Flutter app: Flutter builds, installs and opens it (no web build, no cap sync). */
export const FLUTTER_PHASES: TimelinePhase[] = ['sync', 'deps', 'boot', 'build', 'launch'];
export const FLUTTER_MAC_PHASES: TimelinePhase[] = ['sync', 'deps', 'build', 'launch'];
export const FLUTTER_PC_PHASES: TimelinePhase[] = ['deps', 'build', 'launch'];
export const FLUTTER_IPA_PHASES: TimelinePhase[] = ['sync', 'deps', 'build', 'download'];
/** Sync only: the files and plugins go to the Mac, nothing builds (feature/run-options-console). */
export const SYNC_PHASES: TimelinePhase[] = ['sync', 'deps', 'cap'];
/**
 * A React Native (or Expo) app, as CapMac Studio shows it: Metro starts on this
 * PC first (it serves the JavaScript), then the native app builds where it
 * builds and opens; its Mac app opens on the Mac's desktop. Its Windows app,
 * and its iOS app built on this PC, have no copy to a Mac. Its IPA is made on
 * this PC (PC_IPA_PHASES).
 */
export const NATIVE_PHASES: TimelinePhase[] = ['devserver', 'sync', 'deps', 'boot', 'build', 'install', 'launch'];
export const NATIVE_MAC_PHASES: TimelinePhase[] = ['devserver', 'sync', 'deps', 'build', 'launch'];
export const NATIVE_PC_PHASES: TimelinePhase[] = ['devserver', 'deps', 'build', 'install', 'launch'];

export const MAC_TARGET_ID = 'mac-desktop';
export const PC_TARGET_ID = 'pc-desktop';

/** Frameworks whose apps are native projects built by Xcode or Visual Studio, with no web build of their own (React Native, Expo). */
export const isNative = (framework: string): boolean => framework === 'react-native' || framework === 'expo';

const TIMELINE = new Set<string>([...RUN_PHASES, ...IPA_PHASES, ...CAP_ELECTRON_PHASES, ...FLUTTER_IPA_PHASES, ...NATIVE_PHASES]);

type Words = Partial<Record<TimelinePhase, string>>;
/** CapMac Studio's words for a group of steps; a group (or step) a newer Studio has (React Native's) comes from the extension's own until then. */
const studioWords = (group: string): Words => ((studio as unknown as Record<string, Words | undefined>)[group] ?? {});

/**
 * A step's name: some read differently for an Electron app, on this PC, or for
 * a Flutter or React Native app (whose Mac and Windows apps don't build with
 * Xcode's name on them).
 */
export function phaseLabel(phase: TimelinePhase, where: { onMac: boolean; pc: boolean; flutter: boolean; onPc?: boolean; reactNative?: boolean }): string {
  const own = where.reactNative ? studioWords('phasesReactNative')[phase] ?? (s.phasesReactNative as Words)[phase] : where.flutter ? studioWords('phasesFlutter')[phase] : undefined;
  if (own) return own;
  if ((where.flutter || where.reactNative) && (where.onMac || where.onPc) && phase === 'build') return studio.phasesMac.build;
  // A Windows app (Flutter's, React Native's) isn't built by Xcode.
  if (where.onPc && phase === 'build') return studio.phasesMac.build;
  const general = studioWords('phases')[phase] ?? (s.phases as Words)[phase] ?? phase;
  if (where.pc) return (studio.pc.phases as Words)[phase] ?? general;
  return (where.onMac ? (studio.phasesMac as Words)[phase] : undefined) ?? general;
}

/** What is happening now ("Building"), for the status bar. */
export function phaseNow(phase: TimelinePhase | null, pc: boolean): string {
  if (!phase) return studio.phaseNow.starting;
  const general = studioWords('phaseNow')[phase] ?? (s.phaseNow as Words)[phase] ?? studio.phaseNow.starting;
  if (pc) return (studio.pc.phaseNow as Words)[phase] ?? general;
  return general;
}

export interface PhaseState {
  status: 'pending' | 'running' | 'done' | 'skipped' | 'failed' | 'cancelled';
  title?: string;
  detail?: string;
  progress?: string;
  /** Files compiled so far (xcodebuild), not a fraction. */
  count?: number;
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

export type RunStatus = 'idle' | 'starting' | 'building' | 'running' | 'stopping' | 'failed' | 'stopped' | 'done';
export type RunMode = 'run' | 'live' | 'ipa' | 'sync';

export interface RunState {
  path: string;
  sessionId: string | null;
  mode: RunMode | null;
  status: RunStatus;
  runNumber: number;
  startedAt: number | null;
  endedAt: number | null;
  phases: Partial<Record<TimelinePhase, PhaseState>>;
  stepPhase: Record<string, TimelinePhase>;
  /** Before the first timeline step: what the run does now, like checking this PC's build tools. */
  preparing: { id: string; title: string } | null;
  diagnostics: Diagnostic[];
  error: ErrorInfo | null;
  app: { state: 'launching' | 'running' | 'exited' | 'stopped'; name?: string; target?: string; exitCode?: number | null; at: number } | null;
  target: Target | null;
  /** The target id the session started with (a udid, the Mac's or this PC's desktop), before the engine names it. */
  startedTarget: string | null;
  onMac: boolean;
  onPc: boolean;
  backend: 'mac' | 'wsl';
  mac: string | null;
  /** The run skipped the web build ("Run without building"). */
  keepsWebFiles: boolean;
  live: LiveState | null;
  buildLogPath: string | null;
  ipa: { file: string; size: number } | null;
  previous: { runNumber: number; phases: Partial<Record<TimelinePhase, PhaseState>>; ms: number | null; ok: boolean; mode: RunMode | null } | null;
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
    app: null,
    target: null,
    startedTarget: null,
    onMac: false,
    onPc: false,
    backend: 'mac',
    mac: null,
    keepsWebFiles: false,
    live: null,
    buildLogPath: null,
    ipa: null,
    previous: null,
  };
}

export const isActive = (run: RunState | undefined): boolean => Boolean(run && run.sessionId && !['stopped', 'done'].includes(run.status));
export const isBusy = (run: RunState | undefined): boolean => Boolean(run && (run.status === 'starting' || run.status === 'building' || run.status === 'stopping'));

/**
 * The phases a run of this kind goes through, in order. A framework CapMac
 * learns later (React Native, Expo) gets the native app's steps, and any step
 * a run reports that the list doesn't have is shown too.
 */
export function phasesFor(run: Pick<RunState, 'mode' | 'onMac' | 'onPc' | 'backend' | 'phases'>, kind: { flutter: boolean; capacitorElectron: boolean; native?: boolean }): TimelinePhase[] {
  const list = basePhases(run, kind);
  // Not one it skipped (a React Native run's web build: Metro serves the JavaScript).
  const extra = (Object.keys(run.phases) as TimelinePhase[]).filter((p) => !list.includes(p) && run.phases[p]?.status !== 'skipped');
  return extra.length ? [...list, ...extra] : list;
}

function basePhases(run: Pick<RunState, 'mode' | 'onMac' | 'onPc' | 'backend' | 'phases'>, kind: { flutter: boolean; capacitorElectron: boolean; native?: boolean }): TimelinePhase[] {
  if (run.mode === 'sync') return SYNC_PHASES;
  if (kind.native) {
    if (run.mode === 'ipa') return run.backend === 'wsl' ? PC_IPA_PHASES : IPA_PHASES;
    if (run.backend === 'wsl' || run.onPc) return NATIVE_PC_PHASES;
    return run.onMac ? NATIVE_MAC_PHASES : NATIVE_PHASES;
  }
  if (kind.flutter) {
    if (run.backend === 'wsl') return run.mode === 'ipa' ? PC_IPA_PHASES : PC_PHASES;
    if (run.mode === 'ipa') return FLUTTER_IPA_PHASES;
    if (run.onPc) return FLUTTER_PC_PHASES;
    return run.onMac ? FLUTTER_MAC_PHASES : FLUTTER_PHASES;
  }
  if (run.backend === 'wsl') return run.mode === 'ipa' ? PC_IPA_PHASES : PC_PHASES;
  if (run.mode === 'ipa') return IPA_PHASES;
  if (run.onMac) return kind.capacitorElectron ? CAP_ELECTRON_PHASES : ELECTRON_PHASES;
  return RUN_PHASES;
}

/** The phase that is running now, if any. */
export function runningPhase(run: RunState): TimelinePhase | null {
  for (const [phase, state] of Object.entries(run.phases) as Array<[TimelinePhase, PhaseState]>) {
    if (state.status === 'running') return phase;
  }
  return null;
}

/** Starts a fresh run (a new session, or a new live-reload cycle). */
function newRun(run: RunState, mode: RunMode | null): RunState {
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
    buildLogPath: null,
    ipa: null,
    previous: finished
      ? { runNumber: run.runNumber, phases: run.phases, ms: run.endedAt && run.startedAt ? run.endedAt - run.startedAt : null, ok: run.status !== 'failed', mode: run.mode }
      : run.previous,
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

/** One engine event applied to a project's run. Returns the same object when nothing changed. */
export function reduceRun(run: RunState, event: HostEvent, sessionId: string | undefined, now = Date.now()): RunState {
  switch (event.type) {
    case 'session-started': {
      const e = event as typeof event & { webBuild?: false };
      // Another place than the last run (a Flutter app's iOS app, then its Windows app): its target and last run are not this one's.
      const place = (onMac: boolean, onPc: boolean, backend: string) => (onPc ? 'pc' : onMac ? 'mac' : backend);
      const onMac = event.target === MAC_TARGET_ID;
      const onPc = event.target === PC_TARGET_ID;
      const backend = event.backend ?? 'mac';
      const elsewhere = run.runNumber > 0 && place(run.onMac, run.onPc, run.backend) !== place(onMac, onPc, backend);
      const base: RunState = elsewhere ? { ...run, target: null, previous: null, phases: {} } : run;
      const mode: RunMode = event.mode === 'build' ? 'ipa' : (event.mode as RunMode);
      const next = newRun({ ...base, sessionId: sessionId ?? null, mac: event.mac, app: null, onMac, onPc, backend, startedTarget: event.target }, mode);
      next.status = 'starting';
      next.keepsWebFiles = e.webBuild === false;
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
      } else next.status = run.status === 'failed' ? 'failed' : run.mode === 'ipa' || run.mode === 'sync' ? 'done' : 'stopped';
      if (next.app && (next.app.state === 'running' || next.app.state === 'launching')) next.app = { ...next.app, state: 'stopped', at: now };
      return next;
    }
    case 'step': {
      if (!TIMELINE.has(event.phase)) return run.status === 'starting' ? { ...run, preparing: { id: event.id, title: event.title } } : run;
      const phase = event.phase as TimelinePhase;
      // A launch step once the app runs is the app loading (React Native's first bundle from Metro), not a build.
      const loading = phase === 'launch' && run.status === 'running' && run.app?.state === 'running';
      return {
        ...run,
        preparing: null,
        status: !loading && (run.status === 'starting' || run.status === 'idle' || run.status === 'running') ? 'building' : run.status,
        phases: { ...run.phases, [phase]: { status: 'running', title: event.title, startedAt: now } },
        stepPhase: { ...run.stepPhase, [event.id]: phase },
      };
    }
    case 'step-progress': {
      const phase = run.stepPhase[event.id];
      const state = phase && run.phases[phase];
      if (!phase || !state || state.status !== 'running') return run;
      return { ...run, phases: { ...run.phases, [phase]: { ...state, progress: event.text, count: event.done ?? state.count } } };
    }
    case 'step-end': {
      if (run.preparing?.id === event.id) return { ...run, preparing: null };
      const phase = run.stepPhase[event.id];
      const state = phase && run.phases[phase];
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
      const next = { ...run, target: event.target, onMac: event.target.kind === 'mac', onPc: event.target.kind === 'pc' };
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
    default:
      return run;
  }
}

/** A short reason for a skipped step ("unchanged", "dev server"), as Studio's timeline words it. */
export function shortReason(reason: string | undefined): string {
  const r = (reason ?? '').toLowerCase();
  const short = studio.timeline.short;
  if (!r) return short.skipped;
  if (/unchanged|no changes|nothing to copy/.test(r)) return short.unchanged;
  if (/already (on|booted)|edits already/.test(r)) return short.alreadyOn;
  if (/dev server|served by/.test(r)) return short.devServer;
  if (/device/.test(r)) return short.device;
  if (/turned off|off in/.test(r)) return short.off;
  if (/already built|prebuilt/.test(r)) return short.prebuilt;
  if (/no build script/.test(r)) return short.noScript;
  if (/ready|in place|up to date/.test(r)) return short.upToDate;
  if (/dev command/.test(r)) return short.devCommand;
  return short.skipped;
}
