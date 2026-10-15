/**
 * capmac agent: runs on the Mac, one process per operation, driven over an
 * SSH exec channel by the Windows CLI. Uses only Node.js built-ins.
 */
import type { AgentErrorInfo } from '../shared/protocol.js';
import { AgentIO } from './io.js';
import { opArchive, opDownload } from './ops/archive.js';
import { opBuild } from './ops/build.js';
import { opBoot, opDeploy, opLogs, opShutdown } from './ops/deploy.js';
import { opElectronDialog, opElectronLaunch, opElectronPrepare, opElectronScreen, opElectronScreenshot } from './ops/electron.js';
import { opClean, opExec, opKeychain, opOpenXcode, opPull, opRelay } from './ops/misc.js';
import { opPrepare } from './ops/prepare.js';
import { opRemoteInstall, opRemoteRevoke, opRemoteSet, opRemoteStatus, opRemoteUninstall } from './ops/remote.js';
import { keychainLocked, opProbe } from './ops/probe.js';
import { toolEnv } from './env.js';
import { opScreen, opScreenshot } from './ops/screen.js';
import { opDeviceStream, opStream, opStreamHelper } from './ops/stream.js';
import { opSync } from './ops/sync.js';
import { opInstallTools, opTargets, opWatchTargets } from './ops/targets.js';
import { AgentError, killAll } from './proc.js';
import { AGENT_VERSION } from './version.js';

type Handler = (params: any, io: AgentIO) => Promise<unknown>;

const OPS: Record<string, Handler> = {
  probe: () => opProbe(),
  sync: opSync,
  prepare: opPrepare,
  build: opBuild,
  archive: opArchive,
  download: opDownload,
  deploy: opDeploy,
  boot: opBoot,
  shutdown: opShutdown,
  logs: opLogs,
  targets: () => opTargets(),
  'watch-targets': opWatchTargets,
  screen: opScreen,
  stream: opStream,
  'device-stream': opDeviceStream,
  'stream-helper': opStreamHelper,
  screenshot: opScreenshot,
  exec: opExec,
  pull: opPull,
  keychain: (params) => opKeychain(params),
  'keychain-status': async () => ({ locked: await keychainLocked(await toolEnv()) }),
  clean: opClean,
  'open-xcode': (params) => opOpenXcode(params),
  relay: opRelay,
  'install-tools': opInstallTools,
  'remote-status': () => opRemoteStatus(),
  'remote-install': (params, io) => opRemoteInstall(params, io),
  'remote-set': (params, io) => opRemoteSet(params, io),
  'remote-revoke': (params, io) => opRemoteRevoke(params, io),
  'remote-uninstall': (params, io) => opRemoteUninstall(params, io),
  'electron-prepare': opElectronPrepare,
  'electron-launch': opElectronLaunch,
  'electron-screen': opElectronScreen,
  'electron-screenshot': opElectronScreenshot,
  'electron-dialog': opElectronDialog,
  version: async () => ({ version: AGENT_VERSION, node: process.version, platform: process.platform, arch: process.arch }),
};

function toErrorInfo(err: unknown): AgentErrorInfo {
  if (err instanceof AgentError) {
    return { message: err.message, code: err.code, hint: err.hint, tail: err.tail, logPath: err.logPath };
  }
  const e = err as { message?: string; code?: string } | undefined;
  return { message: e?.message ?? String(err), code: typeof e?.code === 'string' ? e.code : undefined };
}

async function main(): Promise<void> {
  const io = new AgentIO(process.stdin, process.stdout);
  let exitCode = 0;
  try {
    const params = await io.nextJson('params');
    const handler = OPS[params.op];
    if (!handler) throw new AgentError(`Unknown operation "${params.op}" (agent ${AGENT_VERSION})`, 'BAD_REQUEST');
    const data = await handler(params, io);
    io.send({ t: 'result', ok: true, data: data ?? null });
  } catch (err) {
    exitCode = 1;
    const info = toErrorInfo(err);
    if (io.signal.aborted && !info.code) info.code = 'CANCELLED';
    io.send({ t: 'result', ok: false, error: info });
  }
  await io.flush();
  killAll();
  process.exit(exitCode);
}

// The SSH session went away (or someone stopped the agent): take what it started along, so no
// app window or tool is left running on the Mac.
for (const [signal, code] of [['SIGHUP', 129], ['SIGTERM', 143]] as const) {
  process.on(signal, () => {
    killAll();
    process.exit(code);
  });
}

process.on('unhandledRejection', (reason) => {
  process.stderr.write(`CapMac agent: unhandled rejection: ${String((reason as Error)?.stack ?? reason)}\n`);
});

void main();
