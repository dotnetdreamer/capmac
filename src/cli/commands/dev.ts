import type { AgentCall } from '../agent-client.js';
import type { BuildResult, Target } from '../../shared/protocol.js';
import { isCancelled, UserError } from '../errors.js';
import { listenForKeys } from '../keys.js';
import { announceTarget, Pipeline } from '../pipeline.js';
import { loadProject } from '../project.js';
import { reportError } from '../report.js';
import { MacSession } from '../session.js';
import { loadApiKey } from '../signing.js';
import { startDevServer, type DevServer } from '../devserver.js';
import { log, pc } from '../ui.js';
import { ScreenViewer } from '../viewer/server.js';
import { watchNativeChanges } from '../watch.js';
import { requireIos } from './run.js';

export interface DevOptions {
  mac?: string;
  target?: string;
  device?: boolean;
  simulator?: boolean;
  url?: string;
  devCommand?: string;
  configuration?: string;
  scheme?: string;
  team?: string;
  full?: boolean;
  clean?: boolean;
  bridge?: boolean;
  allWarnings?: boolean;
  showSimulator?: boolean;
  screen?: boolean;
  watch?: boolean;
  osLogs?: boolean;
  apiKey?: string;
  apiKeyId?: string;
  apiIssuer?: string;
}

interface CycleRequest {
  full?: boolean;
  clean?: boolean;
  relaunchOnly?: boolean;
}

interface Tunnel {
  port: number;
  close: () => Promise<void>;
}

function printKeys(): void {
  log.line(pc.dim(`  press ${pc.bold('r')} rebuild · ${pc.bold('R')} clean rebuild · ${pc.bold('l')} relaunch · ${pc.bold('o')} open screen · ${pc.bold('c')} clear · ${pc.bold('q')} quit`));
}

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });

export async function devCommand(options: DevOptions): Promise<void> {
  const project = await loadProject(process.cwd());
  requireIos(project);
  const auth = options.device || options.target ? await loadApiKey(options, project) : undefined;
  const hostName = options.mac ?? project.config.host;
  const sessionPromise = MacSession.open({ host: hostName });
  sessionPromise.catch(() => undefined);

  let server: DevServer | null = null;
  let session: MacSession | null = null;
  let tunnel: Tunnel | null = null;
  let relay: AgentCall<unknown> | null = null;
  let viewer: ScreenViewer | null = null;
  let stopKeys = () => undefined as void;
  let watcher: { close(): void } | null = null;
  const stopAll = new AbortController();
  /** True while the SSH connection is down and we are dialling back in. */
  let reconnecting = false;

  try {
    server = await startDevServer(project, { url: options.url, command: options.devCommand });
    const devUrl = server.url;
    log.success(`Dev server: ${pc.cyan(devUrl.href)}`);
    session = await sessionPromise;
    const pipeline = new Pipeline(session, project, { bridge: options.bridge, allWarnings: options.allWarnings });

    const target: Target = await pipeline.chooseTarget(options);
    announceTarget(target);

    const devPort = Number(devUrl.port || (devUrl.protocol === 'https:' ? 443 : 80));
    const localHost = devUrl.hostname.replace(/^\[|\]$/g, '');
    const urlPath = `${devUrl.pathname}${devUrl.search}`;
    let relayPort = 0;

    /**
     * Reverse tunnel: the Mac's localhost:<port> reaches the dev server on this
     * PC. Devices cannot reach the Mac's loopback, so for them the tunnel is
     * also exposed on the Mac's LAN address. Returns the URL the app loads.
     */
    const connectLive = async (preferredPort: number): Promise<string> => {
      const current = session!;
      try {
        tunnel = await current.conn.reverseForward(preferredPort, devPort, localHost);
      } catch {
        tunnel = await current.conn.reverseForward(0, devPort, localHost);
      }
      if (target.kind !== 'device') return `${devUrl.protocol}//localhost:${tunnel.port}${urlPath}`;
      relay = await current.agent.start('relay', {
        listenHost: '0.0.0.0',
        listenPort: relayPort || (devPort === tunnel.port ? 0 : devPort),
        targetPort: tunnel.port,
      });
      const ready = await relay.waitFor<{ data: { port: number; addresses: string[] } }>('ready');
      const ip = ready.data.addresses[0];
      if (!ip) throw new UserError('The Mac has no network address the iPhone could use to reach the dev server.');
      relayPort = ready.data.port;
      return `${devUrl.protocol}//${ip}:${ready.data.port}${urlPath}`;
    };

    let liveUrl = await connectLive(devPort);
    log.success(`Live reload: the app loads ${pc.cyan(liveUrl)} ${pc.dim(`→ tunnel → ${devUrl.host} on this PC`)}`);

    let lastBuild: BuildResult | null = null;
    let app: { controller: AbortController; done: Promise<void> } | null = null;
    let busy = false;
    let queued: CycleRequest | null = null;

    const stopApp = async () => {
      if (!app) return;
      const current = app;
      app = null;
      current.controller.abort();
      await current.done;
    };

    const launch = () => {
      const controller = new AbortController();
      const build = lastBuild!;
      const done = pipeline
        .deploy(target, build, {
          attach: true,
          showSimulator: options.showSimulator,
          osLogs: options.osLogs,
          signal: controller.signal,
          onReady: () => {
            log.success(`${pc.bold(build.displayName)} is running on ${target.name} ${pc.dim('· edit your web code and it reloads instantly')}`);
            printKeys();
          },
        })
        .then((result) => {
          if (result.reason === 'exited') log.info(`The app exited${result.exitCode !== null ? ` (code ${result.exitCode})` : ''}. Press ${pc.bold('l')} to relaunch.`);
        })
        .catch((err) => {
          if (!isCancelled(err) && !reconnecting) reportError(err);
        });
      app = { controller, done };
    };

    const cycle = async (request: CycleRequest): Promise<void> => {
      if (busy || reconnecting) {
        queued = { full: queued?.full || request.full, clean: queued?.clean || request.clean, relaunchOnly: (queued?.relaunchOnly ?? true) && request.relaunchOnly };
        return;
      }
      busy = true;
      try {
        if (!request.relaunchOnly || !lastBuild) {
          await pipeline.sync(true, stopAll.signal);
          await pipeline.prepare(liveUrl, { full: request.full, signal: stopAll.signal });
          lastBuild = await pipeline.build(target, {
            configuration: options.configuration,
            scheme: options.scheme,
            team: options.team,
            clean: request.clean,
            force: request.clean,
            auth,
          }, stopAll.signal);
          if (lastBuild.skipped) log.dim('  Native code unchanged: reused the previous build.');
        }
        await stopApp();
        launch();
      } catch (err) {
        if (!stopAll.signal.aborted && !reconnecting) {
          reportError(err);
          log.dim(`  Fix the problem and save, or press ${pc.bold('r')} to retry.`);
        }
      } finally {
        busy = false;
        if (queued && !stopAll.signal.aborted && !reconnecting) {
          const next = queued;
          queued = null;
          void cycle(next);
        }
      }
    };

    // The Mac went to sleep, Wi-Fi dropped, …: dial back in and pick up where we left off.
    const watchConnection = (watched: MacSession) => {
      void watched.conn.closedPromise.then(async () => {
        if (stopAll.signal.aborted || watched !== session) return;
        reconnecting = true;
        app = null; // its channel died with the connection
        const previousPort = tunnel?.port ?? devPort;
        tunnel = null;
        relay = null;
        log.warn(`Lost the connection to ${watched.label}. Reconnecting…`);
        for (let attempt = 1; !stopAll.signal.aborted; attempt++) {
          try {
            const next = await MacSession.open({ host: hostName });
            session = next;
            pipeline.session = next;
            viewer?.useSession(next);
            const nextUrl = await connectLive(previousPort);
            if (nextUrl !== liveUrl) {
              liveUrl = nextUrl;
              log.info(`Live reload now uses ${pc.cyan(liveUrl)}`);
            }
            reconnecting = false;
            log.success(`Reconnected to ${next.label}`);
            watchConnection(next);
            void cycle({});
            return;
          } catch (err: any) {
            if (attempt === 1 || attempt % 10 === 0) log.dim(`  still trying to reach the Mac… (${err?.message ?? err})`);
            await wait(3000, stopAll.signal);
          }
        }
      });
    };
    watchConnection(session);

    let resolveQuit!: () => void;
    const quit = new Promise<void>((resolve) => (resolveQuit = resolve));
    const openScreen = async () => {
      if (target.kind !== 'simulator') {
        log.warn('The remote screen is available for simulators only.');
        return;
      }
      try {
        if (!viewer) {
          viewer = await ScreenViewer.start(session!, target, { title: `${project.appName} · ${target.name}` });
          const v = viewer;
          pipeline.renderer.onAppLine = (raw) => v.pushLog(raw);
        }
        viewer.open();
      } catch (err) {
        reportError(err);
      }
    };
    stopKeys = listenForKeys({
      r: () => void cycle({}),
      R: () => void cycle({ clean: true }),
      l: () => void cycle({ relaunchOnly: true }),
      o: () => void openScreen(),
      c: () => console.clear(),
      h: printKeys,
      '?': printKeys,
      q: () => resolveQuit(),
      'ctrl+c': () => resolveQuit(),
    });
    const onSigint = () => resolveQuit();
    process.on('SIGINT', onSigint);

    await cycle({ full: options.full, clean: options.clean });
    if (options.screen) void openScreen();
    if (options.watch !== false) {
      watcher = watchNativeChanges(project, (kinds, paths) => {
        const shown = paths.slice(0, 3).join(', ') + (paths.length > 3 ? ` +${paths.length - 3} more` : '');
        log.info(`Native change (${shown}) → rebuilding`);
        void cycle({ full: kinds.has('deps') });
      });
    }

    await quit;
    process.off('SIGINT', onSigint);
    log.dim('Shutting down…');
    stopAll.abort();
    await stopApp();
  } finally {
    stopKeys();
    watcher?.close();
    await (viewer as ScreenViewer | null)?.close().catch(() => undefined);
    (relay as AgentCall<unknown> | null)?.cancel();
    await (tunnel as Tunnel | null)?.close().catch(() => undefined);
    await server?.stop().catch(() => undefined);
    (session as MacSession | null)?.close();
  }
}
