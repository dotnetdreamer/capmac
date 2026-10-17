/**
 * A native Mac app CapMac built (a Flutter or React Native app's Mac app),
 * launched with CapMac's module in it, as a child of the agent: the app stays
 * behind whatever the Mac shows, its window comes to the PC through the
 * `electron-screen` op (the module speaks that protocol, on a local TCP port,
 * see electron-socket.ts), and its output comes here. Runs until the app
 * quits or the PC stops it.
 */
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { parseAppLine } from '../../shared/electron.js';
import type { MacAppLaunchParams, MacAppLaunchResult } from '../../shared/protocol.js';
import { tcpEndpointFile } from '../electron-socket.js';
import { toolEnv } from '../env.js';
import { ensureAppHook } from '../helper/build.js';
import { APP_HOOK_SOURCE } from '../helper/source.js';
import type { AgentIO } from '../io.js';
import { AgentError, isExecutable, run } from '../proc.js';
import { readAppInfo } from './build.js';
import { socketPath } from './electron.js';

/** A free TCP port on 127.0.0.1 (the app's module listens on it). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port'))));
    });
  });
}

export interface MacAppHooks {
  /** The app's environment (a framework's own settings), over the tool PATH. */
  env?: NodeJS.ProcessEnv;
  /** Each line the app prints that is not CapMac's module's, before it goes to the PC as an `app` event. */
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
  /** What the error says when the app quits before its window opens. */
  failureCode?: string;
}

/** Launches the app and follows it until it quits (see the module comment). */
export async function launchMacAppWithHook(params: MacAppLaunchParams, io: AgentIO, hooks: MacAppHooks = {}): Promise<MacAppLaunchResult> {
  const env = { ...(await toolEnv()), NSUnbufferedIO: 'YES', ...hooks.env };
  const info = await readAppInfo(path.join(params.appPath, 'Contents')).catch(() => null);
  const executable = path.join(params.appPath, 'Contents', 'MacOS', info?.executable ?? path.basename(params.appPath, '.app'));
  const failureCode = hooks.failureCode ?? 'RUN_FAILED';
  if (!(await isExecutable(executable))) throw new AgentError(`The Mac app was not found at ${params.appPath}.`, failureCode, 'Build it again.');
  const dylib = await ensureAppHook(APP_HOOK_SOURCE, env, { signal: io.signal, onBuild: () => io.send({ t: 'progress', text: 'Building CapMac’s module for Mac apps (first time only)' }) });
  const socket = socketPath(params.projectId);
  await fs.mkdir(path.dirname(socket), { recursive: true, mode: 0o700 });
  const endpoint = tcpEndpointFile(socket);
  const port = await freePort();
  const token = randomBytes(16).toString('hex');
  await fs.writeFile(endpoint, JSON.stringify({ port, token, app: params.appPath }), { mode: 0o600 });
  let ready = false;
  let windows = 0;
  const announce = (data: unknown) => {
    if (ready) return;
    ready = true;
    io.send({ t: 'ready', data });
  };
  // A window-less app (or a module that did not load) still counts as launched after a while.
  const fallback = setTimeout(() => announce({ windows: 0 }), 20_000);
  try {
    const result = await run(executable, params.args ?? [], {
      cwd: path.dirname(executable),
      env: { ...env, ...params.env, DYLD_INSERT_LIBRARIES: dylib, CAPMAC_APP_HOOK: `${port}:${token}` },
      signal: io.signal,
      capture: false,
      keepStdinOpen: true,
      quitChildFirst: true,
      tailLines: 40,
      onLine: (line, stream) => {
        const parsed = parseAppLine(line);
        if (parsed.kind === 'hook') {
          const event = parsed.event;
          if (event.e === 'window') {
            windows += 1;
            announce({ window: event.window });
          } else if (event.e === 'note') {
            io.log('info', event.message);
          }
          io.send({ t: 'electron', event });
          return;
        }
        hooks.onLine?.(line, stream);
        if (line.trim()) io.send({ t: 'app', stream, text: line });
      },
    });
    if (result.cancelled || io.signal.aborted) return { reason: 'cancelled', exitCode: null };
    if (!ready && result.code !== 0) {
      throw new AgentError('The Mac app quit as it started.', failureCode, windows ? undefined : 'Run it on the Mac once to see why, or check its logs above.', result.tail.slice(-20));
    }
    return { reason: 'exited', exitCode: result.code };
  } finally {
    clearTimeout(fallback);
    await fs.rm(endpoint, { force: true }).catch(() => undefined);
  }
}

/** `mac-app-launch`: a built Mac app, with CapMac's module in it (see launchMacAppWithHook). */
export function opMacAppLaunch(params: MacAppLaunchParams, io: AgentIO): Promise<MacAppLaunchResult> {
  return launchMacAppWithHook(params, io);
}
