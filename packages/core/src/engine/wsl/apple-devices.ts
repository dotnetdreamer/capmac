/**
 * Windows reaches iPhones through Apple's own device server (usbmuxd on
 * 127.0.0.1:27015), which comes with the Apple Devices app or iTunes.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { CancelledError, UserError } from '../errors.js';

const APPLE_DEVICES_STORE_ID = '9NP83LWLPZ9K';
const DEVICE_SERVER_PORT = 27015;
export type AppleDeviceServerState = 'running' | 'stopped' | 'missing';

export function appleDeviceServerRunning(timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: DEVICE_SERVER_PORT });
    const done = (running: boolean) => { socket.destroy(); resolve(running); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function run(executable: string, args: string[], signal?: AbortSignal, timeoutMs = 60_000): Promise<{ code: number; stdout: string }> {
  if (signal?.aborted) return Promise.reject(new CancelledError());
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    const stop = () => { child.kill(); reject(new CancelledError()); };
    const timer = setTimeout(() => { child.kill(); resolve({ code: 1, stdout }); }, timeoutMs);
    signal?.addEventListener('abort', stop, { once: true });
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.resume();
    child.on('error', () => resolve({ code: 1, stdout }));
    child.on('close', (code) => { clearTimeout(timer); signal?.removeEventListener('abort', stop); resolve({ code: code ?? 1, stdout }); });
  });
}
const powershell = (script: string, signal?: AbortSignal) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], signal);

/** Reports without changing anything. */
export async function inspectAppleDeviceServer(signal?: AbortSignal): Promise<AppleDeviceServerState> {
  if (process.platform !== 'win32' || await appleDeviceServerRunning()) return 'running';
  const found = await powershell("if (Get-AppxPackage AppleInc.AppleDevices) { 'app' } elseif (Get-Service 'Apple Mobile Device Service' -ErrorAction SilentlyContinue) { 'service' }", signal);
  return /app|service/.test(found.stdout) ? 'stopped' : 'missing';
}

/** Starts Apple's device server without opening any window. */
export async function startAppleDeviceServer(signal?: AbortSignal): Promise<AppleDeviceServerState> {
  if (process.platform !== 'win32' || await appleDeviceServerRunning()) return 'running';
  // The Store app starts its server from a startup task that Windows enables only after
  // the app has been opened once. Running the launcher inside the package does the same.
  const launched = await powershell([
    '$p = Get-AppxPackage AppleInc.AppleDevices | Select-Object -First 1',
    "if ($p) { Invoke-CommandInDesktopPackage -PackageFamilyName $p.PackageFamilyName -AppId App -Command (Join-Path $p.InstallLocation 'AppleMobileDeviceLauncher.exe') -PreventBreakaway; 'app' }",
    "elseif (Get-Service 'Apple Mobile Device Service' -ErrorAction SilentlyContinue) { 'service' }",
  ].join('; '), signal);
  if (launched.stdout.includes('service')) throw new UserError('Apple Mobile Device Service is not running.', 'Start it from Windows Services, or restart the PC, then try again.');
  if (!launched.stdout.includes('app')) return 'missing';
  for (let attempt = 0; attempt < 30; attempt++) {
    if (signal?.aborted) throw new CancelledError();
    if (await appleDeviceServerRunning()) return 'running';
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new UserError('Apple Devices did not start its iPhone connection.', 'Open the Apple Devices app once, then try again.');
}

/** Installs Apple Devices from the Microsoft Store. Ask the developer first: it accepts the Store terms. */
export async function installAppleDevices(signal?: AbortSignal): Promise<void> {
  if (process.platform !== 'win32') return;
  const base = process.env.LOCALAPPDATA;
  const winget = base ? path.join(base, 'Microsoft', 'WindowsApps', 'winget.exe') : 'winget.exe';
  const result = await run(winget, ['install', '--id', APPLE_DEVICES_STORE_ID, '--source', 'msstore', '--accept-package-agreements', '--accept-source-agreements', '--silent', '--disable-interactivity'], signal, 900_000);
  if (result.code !== 0 && !/already installed/i.test(result.stdout)) throw new UserError('Could not install Apple Devices.', 'Install “Apple Devices” from the Microsoft Store, then run capmac wsl setup again.', result.stdout.trim().split(/\r?\n/).slice(-6));
}

/** For run and dev: start the server if it is installed, or say how to install it. */
export async function requireAppleDeviceServer(signal?: AbortSignal): Promise<void> {
  if (await startAppleDeviceServer(signal) === 'missing') throw new UserError('Your PC needs Apple Devices to reach the iPhone.', 'Run `capmac wsl setup` to install it, or install “Apple Devices” from the Microsoft Store.');
}
