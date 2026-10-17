/**
 * Building on this PC, with no Mac, for CapMac Studio's engine host: setup,
 * health checks, iPhones plugged into this PC, and run, live and build
 * sessions. The same engine calls as `capmac wsl …`, so Studio and the CLI
 * share one setup and one config. Kept apart from host.ts (which needs
 * Electron's parent port) so it can be tested on its own.
 */
import { promises as fs } from 'node:fs';
import { CancelledError, toErrorInfo, UserError, type Check, type EngineContext, type ProjectInfo } from '@capmac/core/engine';
import {
  buildWsl,
  devWsl,
  doctorWsl,
  inspectAppleDeviceServer,
  listWslDevices,
  loadWslOptions,
  runWsl,
  setupWsl,
  startAppleDeviceServer,
  wslDeviceTarget,
  wslSetupState,
} from '@capmac/core/engine/wsl/index';
import type { HostEvent, Scope, WslDevices, WslStatus } from '../shared/contract.js';
import { t } from '../shared/i18n/index.js';

/** The engine calls this uses; tests pass their own. */
export const wslEngine = { setupWsl, wslSetupState, doctorWsl, runWsl, devWsl, buildWsl, listWslDevices, loadWslOptions, inspectAppleDeviceServer, startAppleDeviceServer };
export type WslEngine = typeof wslEngine;

export interface WslHostDeps {
  emit(scope: Scope, event: HostEvent): void;
  contextFor(scope: Scope): EngineContext;
  newId(prefix: string): string;
  engine?: WslEngine;
}

/** Windows paths are case-insensitive: one key per project folder. */
const keyOf = (projectPath: string) => projectPath.replace(/[\\/]+$/, '').toLowerCase();

/** Starting Apple's device server spawns PowerShell: at most this often while nobody asked to run. */
const SERVER_START_EVERY_MS = 60_000;

export function createWslHost(deps: WslHostDeps) {
  const engine = deps.engine ?? wslEngine;
  const setups = new Map<string, { id: string; controller: AbortController; done: Promise<void> }>();
  const listing = new Map<string, Promise<WslDevices>>();
  let serverTriedAt = 0;

  async function status(projectPath: string): Promise<WslStatus> {
    const [state, server] = await Promise.all([engine.wslSetupState(projectPath), engine.inspectAppleDeviceServer().catch(() => 'missing' as const)]);
    return { ...state, server, setupId: setups.get(keyOf(projectPath))?.id ?? null };
  }

  /** Runs setup in the background; it reports through `wsl-setup` events and ends with `setup-ended`. */
  function setup(projectPath: string, appleLogin?: boolean): { setupId: string } {
    const key = keyOf(projectPath);
    const running = setups.get(key);
    if (running) return { setupId: running.id };
    const id = deps.newId('setup');
    const scope: Scope = { setup: projectPath };
    const controller = new AbortController();
    const end = (error?: unknown) => {
      setups.delete(key);
      const info = error === undefined ? undefined : toErrorInfo(error);
      const cancelled = Boolean(info?.cancelled) || controller.signal.aborted;
      deps.emit(scope, { type: 'setup-ended', ok: error === undefined, cancelled, error: cancelled ? undefined : info });
    };
    const done = engine.setupWsl({ cwd: projectPath, ...(appleLogin ? { appleLogin: true } : {}) }, deps.contextFor(scope), controller.signal, { guided: true }).then(() => end(), end);
    setups.set(key, { id, controller, done });
    return { setupId: id };
  }

  async function stopSetup(setupId: string): Promise<void> {
    const entry = [...setups.values()].find((item) => item.id === setupId);
    if (!entry) return;
    entry.controller.abort();
    await entry.done.catch(() => undefined);
  }

  /** `capmac wsl doctor`'s checks, as Studio's health check rows (same words, same fixes). */
  async function doctor(projectPath: string): Promise<{ ready: boolean; checks: Check[] }> {
    const result = await engine.doctorWsl({ cwd: projectPath }, deps.contextFor({ projectPath }), new AbortController().signal);
    return {
      ready: result.ready,
      checks: result.checks.map((check) => ({ id: check.id, group: 'pc' as const, level: check.level, label: check.label, ...(check.detail ? { detail: check.detail } : {}), ...(check.fix ? { fix: check.fix } : {}) })),
    };
  }

  /** iPhones plugged into this PC. Starts Apple's device server (no window) when it is installed but not running. */
  function devices(projectPath: string): Promise<WslDevices> {
    const key = keyOf(projectPath);
    const pending = listing.get(key);
    if (pending) return pending;
    const work = (async (): Promise<WslDevices> => {
      let server = await engine.inspectAppleDeviceServer();
      if (server === 'stopped' && Date.now() - serverTriedAt > SERVER_START_EVERY_MS) {
        serverTriedAt = Date.now();
        server = await engine.startAppleDeviceServer().catch(() => 'stopped' as const);
      }
      if (server !== 'running') return { server, devices: [], error: null };
      try {
        const options = await engine.loadWslOptions({}, projectPath);
        const found = await engine.listWslDevices({ python: options.python });
        return { server, devices: found.map(wslDeviceTarget), error: null };
      } catch (error) {
        return { server, devices: [], error: toErrorInfo(error) };
      }
    })().finally(() => listing.delete(key));
    listing.set(key, work);
    return work;
  }

  /**
   * A run, live or build session on this PC, until it ends or `signal` aborts.
   * `target`: the iPhone's UDID (none: the only one plugged in, or a question);
   * `clean`: drop earlier native build files first (`--clean`); `flutterMode`: a Flutter app's release (default) or profile build.
   */
  async function session(mode: 'run' | 'live' | 'build', project: ProjectInfo, target: string | undefined, ctx: EngineContext, signal: AbortSignal, onIpa: (file: string, size: number) => void, options: { clean?: boolean; flutterMode?: 'debug' | 'profile' | 'release' } = {}): Promise<void> {
    const input = { cwd: project.capDir, ...(target ? { target } : {}), ...(options.clean ? { clean: true } : {}), ...(options.flutterMode ? { mode: options.flutterMode } : {}) };
    if (mode === 'run') return engine.runWsl(input, ctx, signal);
    if (mode === 'live') return engine.devWsl(input, ctx, signal);
    const built = await engine.buildWsl(input, ctx, signal);
    if (signal.aborted) throw new CancelledError();
    if (built.signed === false) throw new UserError(t.host.pcUnsigned, t.host.pcUnsignedHint);
    onIpa(built.ipaPath, (await fs.stat(built.ipaPath)).size);
  }

  async function shutdown(): Promise<void> {
    await Promise.all([...setups.values()].map((entry) => stopSetup(entry.id)));
  }

  return { status, setup, stopSetup, doctor, devices, session, shutdown };
}

export type WslHost = ReturnType<typeof createWslHost>;
