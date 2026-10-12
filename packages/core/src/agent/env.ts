/**
 * Builds the environment for tools the agent runs. Non-interactive SSH
 * sessions on macOS get a bare PATH (/usr/bin:/bin:/usr/sbin:/sbin), so
 * Homebrew, nvm, rbenv and gem-installed CocoaPods would all be missing.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from './proc.js';

interface EnvCache {
  loginPath: string;
  shell: string;
  at: number;
}

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
let cachedEnv: NodeJS.ProcessEnv | null = null;

export function capmacHome(): string {
  return process.env.CAPMAC_HOME || path.join(os.homedir(), '.capmac');
}

async function globDirs(parent: string, suffix: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(parent, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => path.join(parent, e.name, suffix))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

async function loginShellPath(): Promise<string> {
  const cacheFile = path.join(capmacHome(), 'env.json');
  const shell = process.env.SHELL || '/bin/zsh';
  try {
    const cached = JSON.parse(await fs.readFile(cacheFile, 'utf8')) as EnvCache;
    if (cached.shell === shell && Date.now() - cached.at < CACHE_TTL_MS) return cached.loginPath;
  } catch {
    // no cache yet
  }
  let loginPath = '';
  // Like VS Code's shell-environment resolution: an interactive login shell
  // also reads .zshrc (nvm, fnm, asdf live there); fall back to a plain login
  // shell (.zprofile, where Homebrew's shellenv lives) if that misbehaves.
  for (const flags of ['-ilc', '-lc']) {
    try {
      const result = await run(shell, [flags, 'printf "@@P@@%s@@P@@" "$PATH"'], { timeoutMs: 10_000 });
      loginPath = result.stdout.match(/@@P@@(.*?)@@P@@/s)?.[1] ?? '';
    } catch {
      loginPath = '';
    }
    if (loginPath) break;
  }
  try {
    await fs.mkdir(capmacHome(), { recursive: true });
    await fs.writeFile(cacheFile, JSON.stringify({ loginPath, shell, at: Date.now() } satisfies EnvCache));
  } catch {
    // cache is best effort
  }
  return loginPath;
}

/** Environment with a PATH that finds node/npm, Homebrew, CocoaPods and Xcode tools. */
export async function toolEnv(): Promise<NodeJS.ProcessEnv> {
  if (cachedEnv) return cachedEnv;
  const home = os.homedir();
  const entries: string[] = [path.dirname(process.execPath)];
  const login = await loginShellPath();
  entries.push(...login.split(':'));
  entries.push(
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    path.join(home, '.rbenv', 'shims'),
    path.join(home, '.rvm', 'bin'),
    path.join(home, '.asdf', 'shims'),
    path.join(home, '.local', 'share', 'mise', 'shims'),
    path.join(home, '.volta', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.mint', 'bin'),
    path.join(home, '.local', 'bin'),
    path.join(home, 'bin'),
  );
  entries.push(...(await globDirs(path.join(home, '.gem', 'ruby'), 'bin')));
  entries.push(...(await globDirs('/opt/homebrew/lib/ruby/gems', 'bin')));
  entries.push(...(await globDirs('/usr/local/lib/ruby/gems', 'bin')));
  entries.push(...(process.env.PATH ?? '').split(':'));
  entries.push('/usr/bin', '/bin', '/usr/sbin', '/sbin', '/Library/Apple/usr/bin');

  const seen = new Set<string>();
  const pathValue = entries.filter((p) => p && !seen.has(p) && (seen.add(p), true)).join(':');

  cachedEnv = {
    ...process.env,
    PATH: pathValue,
    // CocoaPods refuses to run without a UTF-8 locale.
    LANG: process.env.LANG?.includes('UTF-8') ? process.env.LANG : 'en_US.UTF-8',
    LC_ALL: process.env.LC_ALL?.includes('UTF-8') ? process.env.LC_ALL : 'en_US.UTF-8',
    HOMEBREW_NO_AUTO_UPDATE: '1',
    HOMEBREW_NO_INSTALL_CLEANUP: '1',
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    FORCE_COLOR: '0',
    NO_COLOR: '1',
  };
  return cachedEnv;
}

/** Same as toolEnv() plus variables xcodebuild needs to stream output promptly. */
export async function xcodeEnv(): Promise<NodeJS.ProcessEnv> {
  return { ...(await toolEnv()), NSUnbufferedIO: 'YES' };
}
