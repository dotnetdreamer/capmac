/**
 * The H.264 helper on the Mac: compiled from source with the Mac's own Xcode
 * on first use, cached in ~/.capmac/bin/<hash>/ (the hash covers the source,
 * the selected Xcode and the architecture), like the agent's own upload.
 * A compile error is cached too, so a Mac that cannot build it falls back to
 * the compatible stream at once instead of recompiling on every stream.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { StreamHelperState } from '../../shared/protocol.js';
import { capmacHome } from '../env.js';
import { AgentError, isExecutable, run, tryCapture } from '../proc.js';

export interface XcodeIdentity {
  developerDir: string;
  /** "26.6" */
  version: string;
  /** "17F113" */
  build: string;
}

export interface HelperBinary {
  path: string;
  xcode: XcodeIdentity;
  /** Compiled just now (first use for this Xcode). */
  compiled: boolean;
}

const FRAMEWORKS = ['Foundation', 'CoreGraphics', 'CoreMedia', 'CoreVideo', 'IOSurface', 'VideoToolbox'];

let xcodeCache: Promise<XcodeIdentity | null> | null = null;

/** Reads a string value from an XML property list. */
export function plistString(plist: string, key: string): string {
  return new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(plist)?.[1]?.trim() ?? '';
}

/** The selected Xcode and its version, read from its version.plist (much faster than xcodebuild). */
export function selectedXcode(env: NodeJS.ProcessEnv): Promise<XcodeIdentity | null> {
  xcodeCache ??= (async () => {
    const developerDir = env.DEVELOPER_DIR || (await tryCapture('xcode-select', ['-p'], { env }));
    if (!developerDir || developerDir.includes('CommandLineTools')) return null;
    const plist = await fs.readFile(path.join(developerDir, '..', 'version.plist'), 'utf8').catch(() => '');
    return { developerDir, version: plistString(plist, 'CFBundleShortVersionString'), build: plistString(plist, 'ProductBuildVersion') };
  })();
  return xcodeCache;
}

/** Where a helper built from `source` with `xcode` lives: a new Xcode or a new source means a new build. */
export function helperHash(source: string, xcode: XcodeIdentity, arch: string = process.arch): string {
  return createHash('sha256')
    .update(source)
    .update('\0')
    .update(xcode.developerDir)
    .update('\0')
    .update(xcode.build || xcode.version)
    .update('\0')
    .update(arch)
    .digest('hex')
    .slice(0, 16);
}

/** The last lines of a compiler log that say what went wrong. */
export function compilerSummary(output: string, lines = 12): string[] {
  const all = output.split('\n').map((l) => l.trimEnd()).filter(Boolean);
  const errors = all.filter((l) => /\berror\b/.test(l));
  return (errors.length ? errors : all).slice(-lines);
}

function buildError(xcode: XcodeIdentity, output: string): AgentError {
  return new AgentError(
    `The smooth stream's helper does not compile with Xcode ${xcode.version || '(unknown version)'}.`,
    'HELPER_BUILD_FAILED',
    'CapMac shows the compatible stream instead. Updating CapMac usually fixes this after an Xcode update.',
    compilerSummary(output),
  );
}

function helperDir(hash: string): string {
  return path.join(capmacHome(), 'bin', hash);
}

async function removeOldBuilds(keep: string): Promise<void> {
  const root = path.join(capmacHome(), 'bin');
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === keep) continue;
    const dir = path.join(root, entry.name);
    const stat = await fs.stat(dir).catch(() => null);
    if (stat && stat.mtimeMs < cutoff) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** The helper for the selected Xcode, compiling it first when needed. */
export async function ensureHelper(
  source: string,
  env: NodeJS.ProcessEnv,
  options: { force?: boolean; signal?: AbortSignal; onBuild?: (xcode: XcodeIdentity) => void } = {},
): Promise<HelperBinary> {
  const xcode = await selectedXcode(env);
  if (!xcode) {
    throw new AgentError('The smooth stream needs Xcode, and the Mac has only the Command Line Tools selected.', 'STREAM_UNSUPPORTED', 'Run `sudo xcode-select -s /Applications/Xcode.app` on the Mac.');
  }
  const hash = helperHash(source, xcode);
  const dir = helperDir(hash);
  const exe = path.join(dir, 'simstream');
  const errorLog = path.join(dir, 'error.log');
  if (options.force) await fs.rm(errorLog, { force: true });
  if (await isExecutable(exe)) {
    // Marks this build as in use, so the cleanup below keeps it.
    const now = new Date();
    await fs.utimes(dir, now, now).catch(() => undefined);
    return { path: exe, xcode, compiled: false };
  }
  const cached = await fs.readFile(errorLog, 'utf8').catch(() => null);
  if (cached !== null) throw buildError(xcode, cached);

  options.onBuild?.(xcode);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'simstream.m');
  await fs.writeFile(file, source);
  // Compile next to the target and rename into place: two streams starting at once never see half a binary.
  const tmp = path.join(dir, `simstream.${process.pid}.tmp`);
  const args = ['clang', '-fobjc-arc', '-O2', '-Wno-objc-method-access', ...FRAMEWORKS.flatMap((f) => ['-framework', f]), file, '-o', tmp];
  const r = await run('xcrun', args, { env: { ...env, DEVELOPER_DIR: xcode.developerDir }, signal: options.signal, timeoutMs: 180_000 });
  if (r.cancelled) {
    await fs.rm(tmp, { force: true });
    throw new AgentError('Cancelled', 'CANCELLED');
  }
  if (r.code !== 0) {
    await fs.rm(tmp, { force: true });
    const output = `${r.stderr}\n${r.stdout}`.trim() || `clang exited with ${r.code ?? r.signal}`;
    // Only a real compile error is cached; a timeout may go better next time.
    if (!r.timedOut) await fs.writeFile(errorLog, output).catch(() => undefined);
    throw buildError(xcode, output);
  }
  await fs.rename(tmp, exe);
  await fs.writeFile(path.join(dir, 'build.json'), JSON.stringify({ xcode: xcode.version, build: xcode.build, at: new Date().toISOString() })).catch(() => undefined);
  await removeOldBuilds(hash);
  return { path: exe, xcode, compiled: true };
}

// ─── The device screen app (devstream) ───────────────────────────────────────

const SCREEN_APP_FRAMEWORKS = ['Foundation', 'AVFoundation', 'CoreGraphics', 'CoreMedia', 'CoreMediaIO', 'CoreVideo', 'ImageIO', 'VideoToolbox'];

/** The device screen app's bundle id: macOS remembers its camera access by it. */
export const SCREEN_APP_ID = 'dev.capmac.screen';

/** What macOS shows when it asks for camera access for the app (and in System Settings). */
export const SCREEN_APP_CAMERA_REASON = 'CapMac shows the screen of the iPhone plugged into this Mac on your PC. macOS counts that screen as a camera.';

export function screenAppInfoPlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>${SCREEN_APP_ID}</string>
  <key>CFBundleName</key><string>CapMac</string>
  <key>CFBundleDisplayName</key><string>CapMac</string>
  <key>CFBundleExecutable</key><string>devstream</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSUIElement</key><true/>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSCameraUsageDescription</key><string>${SCREEN_APP_CAMERA_REASON}</string>
</dict>
</plist>
`;
}

/**
 * Where the device screen app built from `source` lives. Unlike the
 * simulator helper, a new Xcode is no reason to rebuild: macOS remembers
 * camera access for this exact build, so it changes only with its source,
 * its Info.plist or the Mac's architecture.
 */
export function screenAppHash(source: string, arch: string = process.arch): string {
  return createHash('sha256').update(source).update('\0').update(screenAppInfoPlist()).update('\0screen-app\0').update(arch).digest('hex').slice(0, 16);
}

export interface ScreenApp {
  /** The app bundle (CapMac.app). */
  path: string;
  /** Built just now (its first use on this Mac). */
  compiled: boolean;
}

function screenAppError(output: string): AgentError {
  return new AgentError(
    "CapMac's iPhone screen helper does not compile on this Mac.",
    'HELPER_BUILD_FAILED',
    'Updating CapMac usually fixes this after a macOS or Xcode update.',
    compilerSummary(output),
  );
}

/**
 * The device screen app, building it first when needed: devstream compiled
 * with the Mac's own clang, in a bundle with an Info.plist (no Dock icon, the
 * camera question's text) and an ad-hoc signature macOS can recognise it by.
 */
export async function ensureScreenApp(
  source: string,
  env: NodeJS.ProcessEnv,
  options: { force?: boolean; signal?: AbortSignal; onBuild?: () => void } = {},
): Promise<ScreenApp> {
  const hash = screenAppHash(source);
  const dir = helperDir(hash);
  const app = path.join(dir, 'CapMac.app');
  const ready = async () => (await isExecutable(path.join(app, 'Contents', 'MacOS', 'devstream'))) && (await fs.stat(path.join(app, 'Contents', '_CodeSignature')).then(() => true, () => false));
  const errorLog = path.join(dir, 'error.log');
  if (options.force) await fs.rm(errorLog, { force: true });
  if (await ready()) {
    const now = new Date();
    await fs.utimes(dir, now, now).catch(() => undefined);
    return { path: app, compiled: false };
  }
  const cached = await fs.readFile(errorLog, 'utf8').catch(() => null);
  if (cached !== null) throw screenAppError(cached);

  options.onBuild?.();
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'devstream.m');
  await fs.writeFile(file, source);
  // Built aside and renamed into place: two streams starting at once never see half an app.
  const tmp = path.join(dir, `build-${process.pid}.app`);
  await fs.rm(tmp, { recursive: true, force: true });
  await fs.mkdir(path.join(tmp, 'Contents', 'MacOS'), { recursive: true });
  const fail = async (output: string, cache: boolean): Promise<never> => {
    await fs.rm(tmp, { recursive: true, force: true });
    if (cache) await fs.writeFile(errorLog, output).catch(() => undefined);
    throw screenAppError(output);
  };
  const exe = path.join(tmp, 'Contents', 'MacOS', 'devstream');
  const args = ['clang', '-fobjc-arc', '-O2', '-Wno-objc-method-access', ...SCREEN_APP_FRAMEWORKS.flatMap((f) => ['-framework', f]), file, '-o', exe];
  const r = await run('xcrun', args, { env, signal: options.signal, timeoutMs: 180_000 });
  if (r.cancelled) {
    await fs.rm(tmp, { recursive: true, force: true });
    throw new AgentError('Cancelled', 'CANCELLED');
  }
  if (r.code !== 0) await fail(`${r.stderr}\n${r.stdout}`.trim() || `clang exited with ${r.code ?? r.signal}`, !r.timedOut);
  await fs.writeFile(path.join(tmp, 'Contents', 'Info.plist'), screenAppInfoPlist());
  const signed = await run('codesign', ['--force', '--sign', '-', '--identifier', SCREEN_APP_ID, tmp], { env, timeoutMs: 60_000 });
  if (signed.code !== 0) await fail(`codesign: ${signed.stderr || signed.stdout}`.trim(), false);
  // A half-built app from an interrupted build makes way; a finished one (another stream's) stays.
  if (!(await ready())) await fs.rm(app, { recursive: true, force: true });
  try {
    await fs.rename(tmp, app);
  } catch (err) {
    // Another stream finished the same build first.
    await fs.rm(tmp, { recursive: true, force: true });
    if (!(await ready())) throw err;
    return { path: app, compiled: false };
  }
  await fs.writeFile(path.join(dir, 'build.json'), JSON.stringify({ kind: 'screen-app', at: new Date().toISOString() })).catch(() => undefined);
  await removeOldBuilds(hash);
  return { path: app, compiled: true };
}

/** CoreSimulator 1155.4 (Xcode 27) ignores the legacy input the helper sends. */
export function legacyInputWorks(coreSimulatorVersion: string): boolean {
  const [major = 0, minor = 0] = coreSimulatorVersion.split('.').map(Number);
  return !coreSimulatorVersion || major < 1155 || (major === 1155 && minor < 4);
}

async function coreSimulatorVersion(): Promise<string> {
  const plist = await fs.readFile('/Library/Developer/PrivateFrameworks/CoreSimulator.framework/Versions/A/Resources/Info.plist', 'utf8').catch(() => '');
  return plistString(plist, 'CFBundleVersion');
}

/** What the health check says about the helper, without building it. */
export async function helperState(source: string, env: NodeJS.ProcessEnv): Promise<StreamHelperState> {
  const xcode = await selectedXcode(env);
  if (!xcode) return { state: 'unsupported', detail: 'Only the Command Line Tools are selected (xcode-select).' };
  const input = legacyInputWorks(await coreSimulatorVersion());
  const dir = helperDir(helperHash(source, xcode));
  if (await isExecutable(path.join(dir, 'simstream'))) return { state: 'ready', xcode: xcode.version, input };
  const error = await fs.readFile(path.join(dir, 'error.log'), 'utf8').catch(() => null);
  if (error !== null) return { state: 'failed', xcode: xcode.version, input, detail: compilerSummary(error, 4).join('\n') };
  return { state: 'not-built', xcode: xcode.version, input };
}
