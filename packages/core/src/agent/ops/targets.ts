import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Target, TargetsResult } from '../../shared/protocol.js';
import { toolEnv } from '../env.js';
import { step, type AgentIO } from '../io.js';
import { AgentError, parseJsonLoose, run, sleep, tryCapture, which } from '../proc.js';

interface SimRuntime {
  name: string;
  version: string;
  platform: string;
}

function runtimeFromIdentifier(id: string): SimRuntime {
  // com.apple.CoreSimulator.SimRuntime.iOS-18-2 -> iOS 18.2
  const m = id.match(/SimRuntime\.([A-Za-z]+)-([\d-]+)$/);
  if (!m) return { name: id, version: '', platform: '' };
  const version = m[2]!.replace(/-/g, '.');
  return { name: `${m[1]} ${version}`, version, platform: m[1]! };
}

function versionKey(v: string): number {
  const [a = 0, b = 0, c = 0] = v.split('.').map(Number);
  return a * 1_000_000 + b * 1000 + c;
}

export function parseSimulators(devicesJson: string, runtimesJson: string | null): Target[] {
  const runtimes = new Map<string, SimRuntime>();
  try {
    for (const rt of parseJsonLoose(runtimesJson)?.runtimes ?? []) {
      runtimes.set(rt.identifier, { name: rt.name, version: rt.version, platform: rt.platform ?? rt.name?.split(' ')[0] ?? '' });
    }
  } catch {
    // fall back to parsing identifiers
  }
  const result: Target[] = [];
  const parsed = parseJsonLoose(devicesJson) ?? {};
  for (const [runtimeId, devices] of Object.entries<any[]>(parsed.devices ?? {})) {
    const runtime = runtimes.get(runtimeId) ?? runtimeFromIdentifier(runtimeId);
    if (!/^iOS$/i.test(runtime.platform) && !/iOS/.test(runtimeId)) continue;
    for (const d of devices) {
      if (d.isAvailable === false) continue;
      result.push({
        kind: 'simulator',
        udid: d.udid,
        name: d.name,
        os: runtime.name,
        osVersion: runtime.version,
        state: d.state ?? 'Shutdown',
        available: true,
        model: String(d.deviceTypeIdentifier ?? '').replace(/^com\.apple\.CoreSimulator\.SimDeviceType\./, '').replace(/-/g, ' ') || undefined,
      });
    }
  }
  result.sort((a, b) => {
    if ((a.state === 'Booted') !== (b.state === 'Booted')) return a.state === 'Booted' ? -1 : 1;
    const v = versionKey(b.osVersion) - versionKey(a.osVersion);
    if (v !== 0) return v;
    const ai = /iPhone/.test(a.name) ? 0 : 1;
    const bi = /iPhone/.test(b.name) ? 0 : 1;
    return ai - bi || a.name.localeCompare(b.name, 'en', { numeric: true });
  });
  return result;
}

/**
 * Parses `devicectl list devices --json-output`. Handles both the classic
 * shape (hardwareProperties/deviceProperties/connectionProperties, JSON v2-3)
 * and Xcode 27's `properties.{hardware,software,state,connection}` (JSON v5),
 * which also lists simulators.
 */
export function parseDevices(json: string): Target[] {
  const parsed = parseJsonLoose(json);
  const out: Target[] = [];
  for (const d of parsed?.result?.devices ?? []) {
    const p = d.properties ?? {};
    const hw = { ...(p.hardware ?? {}), ...(d.hardwareProperties ?? {}) };
    const props = {
      ...(p.state ?? {}),
      ...(p.software?.osVersionNumber !== undefined ? { osVersionNumber: p.software.osVersionNumber?.stringValue ?? p.software.osVersionNumber } : {}),
      ...(d.deviceProperties ?? {}),
    };
    const conn = { ...(p.connection ?? {}), ...(d.connectionProperties ?? {}) };
    if (hw.platform && hw.platform !== 'iOS') continue;
    if (hw.reality && hw.reality !== 'physical') continue;
    if (d.visibilityClass === 'simulators') continue;
    const tunnel = String(conn.tunnelState ?? conn.state ?? 'unknown');
    const paired = conn.pairingState === undefined || conn.pairingState === 'paired';
    const osVersion = String(props.osVersionNumber ?? '');
    out.push({
      kind: 'device',
      udid: String(hw.udid ?? d.identifier),
      name: String(props.name ?? hw.marketingName ?? 'iPhone'),
      os: osVersion ? `iOS ${osVersion}` : 'iOS',
      osVersion,
      state: tunnel === 'connected' ? 'connected' : paired && tunnel !== 'unavailable' ? 'available' : 'unavailable',
      available: paired && tunnel !== 'unavailable' && props.developerModeStatus !== 'disabled',
      model: hw.marketingName ?? hw.productType,
      connection: conn.transportType === 'wired' ? 'usb' : conn.transportType === 'localNetwork' ? 'network' : 'unknown',
      developerMode: props.developerModeStatus === 'enabled' ? 'enabled' : props.developerModeStatus === 'disabled' ? 'disabled' : 'unknown',
      paired,
    });
  }
  return out;
}

export async function listSimulators(env: NodeJS.ProcessEnv): Promise<Target[]> {
  const devicesJson = await tryCapture('xcrun', ['simctl', 'list', 'devices', 'available', '-j'], { env, timeoutMs: 90_000 });
  if (!devicesJson) return [];
  const runtimesJson = await tryCapture('xcrun', ['simctl', 'list', 'runtimes', '-j'], { env, timeoutMs: 90_000 });
  return parseSimulators(devicesJson, runtimesJson);
}

export async function listDevices(env: NodeJS.ProcessEnv): Promise<{ devices: Target[]; supported: boolean }> {
  const tmp = path.join(os.tmpdir(), `capmac-devices-${process.pid}-${Date.now()}.json`);
  try {
    const r = await run('xcrun', ['devicectl', 'list', 'devices', '--json-output', tmp], { env, timeoutMs: 60_000 });
    if (r.code !== 0) return { devices: [], supported: !/unable to find utility|not a developer tool|devicectl/i.test(r.stderr) };
    return { devices: parseDevices(await fs.readFile(tmp, 'utf8')), supported: true };
  } catch {
    return { devices: [], supported: false };
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}

export async function opTargets(): Promise<TargetsResult> {
  const env = await toolEnv();
  const [simulators, devices] = await Promise.all([listSimulators(env), listDevices(env)]);
  return { simulators, devices: devices.devices, deviceSupport: devices.supported };
}

/**
 * Keeps watching simulators and devices and sends `targets` whenever anything
 * changes (booted, shut down, plugged in, …). One long-lived process instead
 * of a new agent per poll; devices (devicectl is slow) are checked less often.
 */
export async function opWatchTargets(params: { simulatorsEveryMs?: number; devicesEveryMs?: number }, io: AgentIO): Promise<{ updates: number }> {
  const env = await toolEnv();
  const simEvery = Math.min(60_000, Math.max(1000, params.simulatorsEveryMs ?? 3000));
  const devEvery = Math.min(120_000, Math.max(5000, params.devicesEveryMs ?? 15_000));
  let devices: { devices: Target[]; supported: boolean } = { devices: [], supported: true };
  let lastDevices = 0;
  let last = '';
  let updates = 0;
  while (!io.signal.aborted) {
    const checkDevices = Date.now() - lastDevices >= devEvery;
    const [simulators, nextDevices] = await Promise.all([listSimulators(env), checkDevices ? listDevices(env) : Promise.resolve(null)]);
    if (io.signal.aborted) break;
    if (nextDevices) {
      devices = nextDevices;
      lastDevices = Date.now();
    }
    const data: TargetsResult = { simulators, devices: devices.devices, deviceSupport: devices.supported };
    const json = JSON.stringify(data);
    if (json !== last) {
      last = json;
      updates += 1;
      io.send({ t: 'targets', data });
    }
    await sleep(simEvery, io.signal);
  }
  return { updates };
}

const BREW_FORMULAE: Record<string, string> = {
  axe: 'cameroncooke/axe/axe',
  xcbeautify: 'xcbeautify',
  cocoapods: 'cocoapods',
  'ios-webkit-debug-proxy': 'ios-webkit-debug-proxy',
};

/** Installs optional helper tools with Homebrew (only when the user asked for it). */
export async function opInstallTools(params: { tools: string[] }, io: AgentIO): Promise<{ installed: string[] }> {
  const env = await toolEnv();
  const brew = await which('brew', env);
  if (!brew) {
    throw new AgentError('Homebrew is not installed on the Mac.', 'TOOL_MISSING', 'Install it from https://brew.sh, then run `capmac doctor --fix` again.');
  }
  const installed: string[] = [];
  for (const name of params.tools) {
    const formula = BREW_FORMULAE[name];
    if (!formula) throw new AgentError(`Unknown tool "${name}"`, 'BAD_REQUEST');
    await step(io, `brew-${name}`, `brew install ${formula}`, async () => {
      const r = await run(brew, ['install', formula], {
        env,
        signal: io.signal,
        onLine: (line) => line.trim() && io.send({ t: 'progress', text: line.trim().slice(0, 160) }),
      });
      if (r.cancelled) throw new AgentError('Cancelled', 'CANCELLED');
      if (r.code !== 0) throw new AgentError(`brew install ${formula} failed`, 'INSTALL_FAILED', undefined, r.tail.slice(-20));
    });
    installed.push(name);
  }
  return { installed };
}
