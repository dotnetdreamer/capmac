/** Smaller operations: run a command on the Mac, copy files back, open Xcode, clean, stream logs. */
import { unpackArchive } from '../shared/archive.js';
import type { Target } from '../shared/protocol.js';
import { withStep, type EngineContext } from './context.js';
import { formatBytes, plural } from './format.js';
import { Pipeline } from './pipeline.js';
import { requireIos, type ProjectInfo } from './project.js';
import type { MacSession } from './session.js';
import { syncToMac } from './sync-client.js';

/** Joins argv into one shell command line (one argument is taken as a command line as is). */
export function commandLine(command: string[]): string {
  return command.length === 1
    ? command[0]!
    : command.map((part) => (/^[\w@%+=:,./-]+$/.test(part) ? part : `'${part.replace(/'/g, `'\\''`)}'`)).join(' ');
}

/** Runs a shell command in the project's folder on the Mac; returns its exit code. */
export async function execOnMac(
  session: MacSession,
  project: ProjectInfo,
  command: string,
  options: { cwd?: 'project' | 'root' | 'ios'; signal?: AbortSignal; onOutput?: (stream: 'stdout' | 'stderr', text: string) => void },
): Promise<number | null> {
  const result = await session.call<{ code: number | null }>('exec', { projectId: project.projectId, projectRel: project.projectRel, command, cwd: options.cwd ?? 'project' }, {
    signal: options.signal,
    onEvent: (event) => {
      if (event.t === 'out') options.onOutput?.(event.stream, event.text);
    },
  });
  return result.code;
}

/** Copies paths (relative to the Capacitor project) from the Mac's copy back to this PC. */
export async function pullFromMac(session: MacSession, project: ProjectInfo, paths: string[], ctx: EngineContext): Promise<{ files: number; bytes: number }> {
  const queue: Buffer[] = [];
  let ended = false;
  let wake: (() => void) | null = null;
  const notify = () => {
    const w = wake;
    wake = null;
    w?.();
  };
  const chunks = (async function* () {
    for (;;) {
      if (queue.length) {
        yield queue.shift()!;
        continue;
      }
      if (ended) return;
      await new Promise<void>((resolve) => (wake = resolve));
    }
  })();
  const call = await session.agent.start<{ files: number; bytes: number }>('pull', { projectId: project.projectId, projectRel: project.projectRel, paths }, {
    onBinary: (data) => {
      queue.push(data);
      notify();
    },
    onEvent: (event) => {
      if (event.t === 'archive-end') {
        ended = true;
        notify();
      }
    },
  });
  call.result.catch(() => {
    ended = true;
    notify();
  });
  return withStep(ctx, `Copying ${paths.join(', ')} from ${session.label}`, 'download', async () => {
    try {
      const stats = await unpackArchive(chunks, { root: project.capDir });
      await call.result;
      return stats;
    } catch (err) {
      await call.result; // surfaces the agent's own error if it failed first
      throw err;
    }
  }, (r) => `${plural(r.files, 'file')}, ${formatBytes(r.bytes)}`);
}

/**
 * What the Mac opens in Xcode for the project's iOS app: Capacitor's ios/App (the agent finds it),
 * a Flutter app's Runner workspace, a React Native app's own (CocoaPods makes it on the Mac).
 */
export function xcodeOpenParams(project: ProjectInfo): { projectId: string; projectRel: string; iosDir: string; xcodeName?: string } {
  const ref = { projectId: project.projectId, projectRel: project.projectRel };
  if (project.kind === 'flutter') return { ...ref, iosDir: 'ios', xcodeName: 'Runner' };
  if (project.kind === 'react-native') {
    const ios = project.reactNative?.ios;
    return { ...ref, iosDir: ios?.dir ?? 'ios', xcodeName: ios?.xcodeproj?.replace(/\.xcodeproj$/, '') ?? ios?.scheme ?? project.scheme };
  }
  return { ...ref, iosDir: project.iosDir };
}

/** Syncs the project and opens its iOS app in Xcode on the Mac's screen. */
export async function openInXcode(session: MacSession, project: ProjectInfo, ctx: EngineContext, signal?: AbortSignal): Promise<string> {
  // An Electron app, or an app with no iOS app yet: says what to do before anything is copied.
  requireIos(project);
  await syncToMac(session, project, { includeWebDir: true, signal }, ctx);
  const result = await withStep(ctx, 'Opening the project in Xcode on the Mac', 'other', () => session.call<{ opened: string }>('open-xcode', xcodeOpenParams(project)));
  return result.opened;
}

/** Deletes build products on the Mac (or the whole copy of the project with `all`). */
export async function cleanOnMac(session: MacSession, project: ProjectInfo, all: boolean, ctx: EngineContext): Promise<string> {
  const result = await withStep(ctx, all ? 'Removing the project from the Mac' : 'Removing build products on the Mac', 'other', () =>
    session.call<{ removed: string }>('clean', { projectId: project.projectId, projectRel: project.projectRel, what: all ? 'all' : 'build' }));
  return result.removed;
}

/** Streams the system log (os_log/NSLog) of the app on a simulator until `signal` aborts. */
export async function streamAppLogs(session: MacSession, project: ProjectInfo, target: Target, ctx: EngineContext, signal: AbortSignal): Promise<void> {
  const pipeline = new Pipeline(session, project, ctx);
  await pipeline.call('logs', { target, executable: project.scheme }, { signal });
}
