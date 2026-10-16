import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { UserError } from '../errors.js';

/** Machine-local paths. Secrets themselves never belong in this file. */
export interface WslOptions {
  cwd?: string;
  distro?: string;
  sdk?: string;
  swift?: string;
  linker?: string;
  signer?: string;
  swiftResources?: string;
  clang?: string;
  archive?: string;
  lipo?: string;
  strip?: string;
  actool?: string;
  ibtool?: string;
  momc?: string;
  xcstrings?: string;
  ruby?: string;
  pod?: string;
  xcodeVersion?: string;
  /** Which version of CapMac's importer took `sdk` out of Xcode: setup takes it out again after a newer one. */
  sdkImporter?: string;
  installResources?: boolean;
  /** Official Xcode archive to import during setup; never persisted. */
  xcode?: string;
  /** Start a fresh interactive Apple session during setup; never persisted. */
  appleLogin?: boolean;
  python?: string;
  certificate?: string;
  profile?: string;
  extensionProfiles?: Record<string, string>;
  extensionProfile?: string[];
  unsigned?: boolean;
  passwordEnv?: string;
  out?: string;
  url?: string;
  liveHost?: string;
  target?: string;
  device?: boolean;
  webBuild?: boolean;
  logs?: boolean;
  release?: boolean;
  configuration?: string;
  /** A Flutter app's build mode (`--mode`): an iPhone runs release or profile builds here (debug ones need Xcode's debugger). */
  mode?: string;
  clean?: boolean;
  app?: string;
  json?: boolean;
  watch?: boolean;
  devCommand?: string;
  simulator?: boolean;
  electron?: boolean;
  mac?: string;
  screen?: boolean;
  scheme?: string;
  full?: boolean;
  upload?: boolean;
  export?: string;
  for?: string;
  xcodebuildArg?: string[];
  team?: string;
  apiKey?: string;
  apiKeyId?: string;
  apiIssuer?: string;
  route?: string;
  showSimulator?: boolean;
  osLogs?: boolean;
  bridge?: boolean;
  sound?: string;
  stream?: string;
  allWarnings?: boolean;
  fix?: boolean;
  yes?: boolean;
}

const LOCAL_KEYS = ['distro', 'sdk', 'swift', 'linker', 'signer', 'swiftResources', 'python', 'certificate', 'profile', 'passwordEnv', 'clang', 'archive', 'lipo', 'strip', 'actool', 'ibtool', 'momc', 'xcstrings', 'ruby', 'pod', 'xcodeVersion', 'sdkImporter'] as const;
export const settingsPath = (cwd: string) => path.join(cwd, '.capmac', 'wsl.json');

export async function loadWslOptions(options: WslOptions, cwd = options.cwd ?? process.cwd()): Promise<WslOptions> {
  let saved: WslOptions = {};
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(settingsPath(cwd), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected a JSON object.');
    for (const key of LOCAL_KEYS) {
      const value = (parsed as Record<string, unknown>)[key];
      if (value !== undefined && (typeof value !== 'string' || !value.trim())) throw new Error(`${key} must be a nonempty string.`);
      if (typeof value === 'string') saved[key] = value;
    }
    const profiles = (parsed as Record<string, unknown>).extensionProfiles;
    if (profiles !== undefined) {
      validateExtensionProfiles(profiles);
      saved.extensionProfiles = profiles;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new UserError('Cannot read the local WSL settings.', `Fix ${settingsPath(cwd)}: ${(err as Error).message}`);
  }
  const env: WslOptions = {
    sdk: process.env.CAPMAC_IOS_SDK,
    certificate: process.env.CAPMAC_IOS_CERTIFICATE,
    profile: process.env.CAPMAC_IOS_PROFILE,
    passwordEnv: 'CAPMAC_IOS_PASSWORD',
  };
  const merged: WslOptions = Object.assign({ cwd }, Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)), saved,
    Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)));
  if (options.extensionProfile?.length) {
    merged.extensionProfiles = { ...merged.extensionProfiles };
    for (const entry of options.extensionProfile) {
      const index = entry.indexOf('=');
      if (index < 1 || index === entry.length - 1) throw new UserError('Use --extension-profile bundle.identifier=path.mobileprovision.');
      merged.extensionProfiles[entry.slice(0, index)] = entry.slice(index + 1);
    }
  }
  if (merged.extensionProfiles) validateExtensionProfiles(merged.extensionProfiles);
  return merged;
}

export async function saveWslOptions(options: WslOptions, cwd: string): Promise<void> {
  const current = await loadWslOptions(options, cwd);
  const saved: Record<string, unknown> = Object.fromEntries(LOCAL_KEYS.filter((key) => current[key] !== undefined).map((key) => [key, current[key]]));
  if (current.extensionProfiles) saved.extensionProfiles = current.extensionProfiles;
  await excludeLocalWorkspace(cwd);
  await fs.mkdir(path.dirname(settingsPath(cwd)), { recursive: true });
  await fs.writeFile(settingsPath(cwd), `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
}

/** Machine configuration and generated native inputs never belong in a commit. */
async function excludeLocalWorkspace(cwd: string): Promise<void> {
  const exec = promisify(execFile);
  let root: string; let exclude: string;
  try {
    root = (await exec('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { windowsHide: true })).stdout.trim();
    exclude = (await exec('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'], { windowsHide: true })).stdout.trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as { code?: number }).code === 128) return;
    throw new UserError('Could not protect the machine-local CapMac folder from Git.', 'Check access to this repository’s .git/info/exclude file.');
  }
  const relative = path.relative(root, path.join(cwd, '.capmac')).split(path.sep).join('/');
  if (relative.startsWith('../') || path.isAbsolute(relative)) throw new UserError('The CapMac setup folder is outside its Git repository.');
  // Escape Git wildmatch syntax for project folders containing brackets or spaces.
  const pattern = '/' + relative.replace(/[\\*?\[\] #!]/g, '\\$&') + '/';
  const existing = await fs.readFile(exclude, 'utf8').catch((error) => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; });
  if (existing.split(/\r?\n/).includes(pattern)) return;
  await fs.mkdir(path.dirname(exclude), { recursive: true });
  await fs.appendFile(exclude, `${existing && !existing.endsWith('\n') ? '\n' : ''}${pattern}\n`);
}

function validateExtensionProfiles(value: unknown): asserts value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.entries(value).some(([bundleId, file]) => !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(bundleId) || typeof file !== 'string' || !file.trim() || /[\0\r\n]/.test(file))) throw new UserError('Extension profiles must map bundle identifiers to provisioning profile paths.');
}

export function validateWslOptions(options: WslOptions): void {
  const incompatible: Array<[unknown, string]> = [
    [options.simulator, '--simulator'], [options.electron || (options.app && options.app !== 'ios'), '--app'],
    [options.mac, '--mac'], [options.screen, '--screen'],
    [options.full, '--full'], [options.upload, '--upload'], [options.export, '--export'],
    [options.for, '--for'], [options.xcodebuildArg?.length, '--xcodebuild-arg'],
    [options.team, '--team'], [options.apiKey, '--api-key'], [options.apiKeyId, '--api-key-id'],
    [options.apiIssuer, '--api-issuer'], [options.route, '--route'], [options.showSimulator, '--show-simulator'],
    [options.osLogs, '--os-logs'], [options.bridge, '--bridge'], [options.sound, '--sound'],
    [options.stream, '--stream'], [options.fix, '--fix'], [options.yes, '--yes'],
  ];
  const selected = incompatible.filter(([value]) => value).map(([, flag]) => flag);
  if (selected.length) throw new UserError(`The WSL backend does not support ${selected.join(', ')}.`, 'This backend builds development apps for physical iPhones. Use the Mac backend (`--backend mac`) for Xcode-specific operations.');
  if (options.configuration && /[\0\r\n]/.test(options.configuration)) throw new UserError('Invalid build configuration name.');
  if (options.xcodeVersion && !/^\d+(?:\.\d+){0,2}$/.test(options.xcodeVersion)) throw new UserError('--xcode-version must be a version such as 27.0.');
}
