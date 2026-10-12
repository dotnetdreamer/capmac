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
