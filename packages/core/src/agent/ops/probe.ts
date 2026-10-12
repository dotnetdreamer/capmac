import os from 'node:os';
import path from 'node:path';
import type { ProbeResult, ToolInfo } from '../../shared/protocol.js';
import { toolEnv } from '../env.js';
import { run, tryCapture, which } from '../proc.js';
import { AGENT_VERSION } from '../version.js';

const OPTIONAL_TOOLS = ['pod', 'xcbeautify', 'axe', 'brew', 'git', 'ruby', 'yarn', 'pnpm', 'bun', 'corepack', 'ios_webkit_debug_proxy'];

async function tool(name: string, env: NodeJS.ProcessEnv, versionArgs = ['--version']): Promise<ToolInfo | null> {
  const found = await which(name, env);
  if (!found) return null;
  const out = await tryCapture(found, versionArgs, { env, timeoutMs: 15_000 });
  const version = (out ?? '').split('\n').find((l) => l.trim())?.trim() ?? '';
  return { path: found, version };
}

async function xcodeInfo(env: NodeJS.ProcessEnv): Promise<ProbeResult['xcode']> {
  const developerDir = await tryCapture('xcode-select', ['-p'], { env });
  if (!developerDir) return null;
  if (developerDir.includes('CommandLineTools')) {
    return {
      developerDir,
      version: '',
      build: '',
      ready: false,
      problem: 'Only the Command Line Tools are selected. Install Xcode and run `sudo xcode-select -s /Applications/Xcode.app`.',
    };
  }
  const versionRun = await run('xcodebuild', ['-version'], { env, timeoutMs: 60_000 });
  const text = `${versionRun.stdout}\n${versionRun.stderr}`;
  if (versionRun.code !== 0) {
    const license = /license/i.test(text);
    return {
      developerDir,
      version: '',
      build: '',
      ready: false,
      problem: license
        ? 'The Xcode license has not been accepted. Run `sudo xcodebuild -license accept` on the Mac (or `capmac doctor --fix`).'
        : `xcodebuild failed: ${text.trim().split('\n').slice(-2).join(' ')}`,
    };
  }
  const version = text.match(/Xcode\s+([\d.]+)/)?.[1] ?? '';
  const build = text.match(/Build version\s+(\S+)/)?.[1] ?? '';
  const firstLaunch = await run('xcodebuild', ['-checkFirstLaunchStatus'], { env, timeoutMs: 60_000 });
  const ready = firstLaunch.code === 0;
  return {
    developerDir,
    version,
    build,
    ready,
    problem: ready ? undefined : 'Xcode needs its first-launch setup. Run `sudo xcodebuild -runFirstLaunch` on the Mac (or `capmac doctor --fix`).',
  };
}

async function simulatorSummary(env: NodeJS.ProcessEnv): Promise<ProbeResult['simulators']> {
  const devicesJson = await tryCapture('xcrun', ['simctl', 'list', 'devices', 'available', '-j'], { env, timeoutMs: 60_000 });
  const runtimesJson = await tryCapture('xcrun', ['simctl', 'list', 'runtimes', '-j'], { env, timeoutMs: 60_000 });
  let devices = 0;
  const runtimes: string[] = [];
  try {
    const parsed = JSON.parse(devicesJson ?? '{}');
    for (const [runtime, list] of Object.entries<any[]>(parsed.devices ?? {})) {
      if (/iOS/i.test(runtime)) devices += list.length;
    }
  } catch {
    // ignore
  }
  try {
    for (const rt of JSON.parse(runtimesJson ?? '{}').runtimes ?? []) {
      if (rt.isAvailable !== false && /iOS/i.test(rt.platform ?? rt.name ?? '')) runtimes.push(rt.name ?? rt.version);
    }
  } catch {
    // ignore
  }
  return { devices, runtimes };
}

async function freeDiskGb(env: NodeJS.ProcessEnv): Promise<number | null> {
  const out = await tryCapture('df', ['-k', os.homedir()], { env });
  const cols = out?.split('\n')[1]?.trim().split(/\s+/);
  const kb = cols ? Number(cols[3]) : NaN;
  return Number.isFinite(kb) ? Math.round((kb / 1024 / 1024) * 10) / 10 : null;
}

export async function keychainLocked(env: NodeJS.ProcessEnv): Promise<boolean | null> {
  const keychain = path.join(os.homedir(), 'Library', 'Keychains', 'login.keychain-db');
  const r = await run('security', ['show-keychain-info', keychain], { env, timeoutMs: 15_000 }).catch(() => null);
  if (!r) return null;
  if (r.code === 0) return false;
  return /interaction is not allowed|locked/i.test(`${r.stdout}${r.stderr}`) ? true : null;
}

async function signingIdentities(env: NodeJS.ProcessEnv): Promise<string[]> {
  const out = await tryCapture('security', ['find-identity', '-v', '-p', 'codesigning'], { env });
  return [...(out ?? '').matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

export async function opProbe(): Promise<ProbeResult> {
  const env = await toolEnv();
  const [consoleUser, computerName, macos, xcode, simulators, disk, locked, identities, npm, ...toolInfos] = await Promise.all([
    tryCapture('stat', ['-f', '%Su', '/dev/console'], { env }),
    tryCapture('scutil', ['--get', 'ComputerName'], { env }),
    tryCapture('sw_vers', ['-productVersion'], { env }),
    xcodeInfo(env),
    simulatorSummary(env),
    freeDiskGb(env),
    keychainLocked(env),
    signingIdentities(env),
    tryCapture('npm', ['--version'], { env, timeoutMs: 30_000 }),
    ...OPTIONAL_TOOLS.map((name) => tool(name, env)),
  ]);
  const tools: Record<string, ToolInfo | null> = {};
  OPTIONAL_TOOLS.forEach((name, i) => {
    tools[name] = toolInfos[i] ?? null;
  });
  return {
    agentVersion: AGENT_VERSION,
    home: os.homedir(),
    user: os.userInfo().username,
    hostname: os.hostname(),
    computerName,
    macos,
    arch: process.arch,
    node: { path: process.execPath, version: process.version },
    npm,
    xcode,
    tools,
    simulators,
    freeDiskGb: disk,
    keychainLocked: locked,
    signingIdentities: identities,
    consoleUser,
  };
}
