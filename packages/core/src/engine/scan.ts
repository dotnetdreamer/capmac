/**
 * Walks the project on Windows and builds the manifest to sync to the Mac.
 * Respects .gitignore (plus sensible defaults), always includes the iOS
 * project (even gitignored files like GoogleService-Info.plist) and the
 * built web assets, and caches hashes by size+mtime so re-syncs are instant.
 */
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import ignore, { type Ignore } from 'ignore';

export interface ScanOptions {
  root: string;
  /** POSIX path from root to the Capacitor project ('' if same). */
  projectRel: string;
  /** Capacitor's web assets folder ('' for an Electron app, which has none). */
  webDir: string;
  iosDir: string;
  /** Upload built web assets (false in live-reload mode). */
  includeWebDir: boolean;
  /** Leave out an electron/ folder (default true: only Capacitor's Electron platform uses it, and CapMac syncs it for Electron apps). */
  excludeElectron?: boolean;
  include?: string[];
  exclude?: string[];
  cacheFile?: string;
}

export interface LocalFile {
  rel: string;
  abs: string;
  size: number;
  mtimeMs: number;
  hash: string;
  mode: number;
  toLf: boolean;
}

export interface ScanResult {
  files: LocalFile[];
  hashed: number;
  skippedSymlinks: number;
  ms: number;
}

const ALWAYS_SKIP = new Set(['.git', 'node_modules', '.capmac', '.hg', '.svn']);
const GLOBAL_EXCLUDES = [
  '.DS_Store', 'Thumbs.db', 'desktop.ini', '*.log', '*.swp', '*~',
  '.idea/', '.vscode/', '.vs/', '.gradle/', '.angular/', '.nx/', '.turbo/', '.svelte-kit/', '.vite/',
  '.cache/', '.parcel-cache/', '.eslintcache', 'coverage/', '.nyc_output/',
];
const PROJECT_EXCLUDES = ['android/', 'electron/'];
const PROJECT_EXCLUDES_WITH_ELECTRON = ['android/'];
const IOS_EXCLUDES = [
  'App/build/', 'App/Pods/', 'App/output/', 'App/App/public/', 'App/App/capacitor.config.json', 'App/App/config.xml',
  'DerivedData/', 'build/', '.build/', '.swiftpm/', 'capacitor-cordova-ios-plugins/', 'xcuserdata/', '*.xcuserstate',
];
const SCRIPT_EXT = /\.(sh|bash|zsh|command)$/i;
const SMALL = 4 * 1024 * 1024;

type CacheEntry = [size: number, mtimeMs: number, hash: string, flags: number];
interface HashCache {
  version: 1;
  files: Record<string, CacheEntry>;
}

function under(rel: string, prefix: string): boolean {
  return prefix === '' || rel === prefix || rel.startsWith(`${prefix}/`);
}

function join(...parts: string[]): string {
  return parts.filter(Boolean).join('/');
}

async function loadCache(file?: string): Promise<HashCache> {
  if (!file) return { version: 1, files: {} };
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as HashCache;
    return parsed.version === 1 ? parsed : { version: 1, files: {} };
  } catch {
    return { version: 1, files: {} };
  }
}

async function hashFile(abs: string, size: number, rel: string): Promise<{ hash: string; exec: boolean; toLf: boolean }> {
  const scriptByName = SCRIPT_EXT.test(rel);
  if (size <= SMALL) {
    const data = await fs.readFile(abs);
    const hash = createHash('sha1').update(data).digest('hex');
    const shebang = data.length >= 2 && data[0] === 0x23 && data[1] === 0x21;
    const exec = shebang || scriptByName;
    return { hash, exec, toLf: exec && data.includes('\r\n') };
  }
  const hash = createHash('sha1');
  await new Promise<void>((resolve, reject) => {
    createReadStream(abs)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve())
      .on('error', reject);
  });
  return { hash: hash.digest('hex'), exec: scriptByName, toLf: false };
}

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index++]!;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

export async function scanProject(options: ScanOptions): Promise<ScanResult> {
  const started = Date.now();
  const root = path.resolve(options.root);
  const projectRel = options.projectRel.replace(/^\/+|\/+$/g, '');
  const webDir = options.webDir.replace(/^\.\/+|\/+$/g, '');
  // No web folder (an Electron app): nothing is uploaded for being web assets.
  const webRel = webDir ? join(projectRel, webDir) : null;
  const withWeb = options.includeWebDir && webRel !== null;
  const iosRel = join(projectRel, options.iosDir.replace(/^\.\/+|\/+$/g, ''));

  const globalIgnore = ignore().add(GLOBAL_EXCLUDES);
  const projectIgnore = ignore().add(options.excludeElectron === false ? PROJECT_EXCLUDES_WITH_ELECTRON : PROJECT_EXCLUDES);
  const iosIgnore = ignore().add(IOS_EXCLUDES);
  const userExclude = ignore().add(options.exclude ?? []);
  const userInclude = ignore().add(options.include ?? []);
  const hasUserInclude = (options.include?.length ?? 0) > 0;
  try {
    userExclude.add(await fs.readFile(path.join(root, '.capmacignore'), 'utf8'));
  } catch {
    // optional
  }

  type Level = { base: string; ig: Ignore };

  const isWebPath = (rel: string) => withWeb && under(rel, webRel!);
  const isAncestorOf = (rel: string, target: string) => target === rel || target.startsWith(`${rel}/`);
  // Folders on the way to the web assets / iOS project are walked even if gitignored.
  const isWebAncestor = (rel: string) => (withWeb && isAncestorOf(rel, webRel!)) || isAncestorOf(rel, iosRel);

  /** Returns true when `rel` (a file, or a dir when isDir) should be skipped. */
  const excluded = (rel: string, isDir: boolean, levels: Level[]): boolean => {
    const test = isDir ? `${rel}/` : rel;
    if (isWebPath(rel)) return false;
    if (userExclude.ignores(test)) return true;
    if (hasUserInclude && userInclude.ignores(test)) return false;
    if (globalIgnore.ignores(test)) return !(isDir && isWebAncestor(rel));
    if (under(rel, projectRel) && rel !== projectRel) {
      const inProject = projectRel ? rel.slice(projectRel.length + 1) : rel;
      if (projectIgnore.ignores(isDir ? `${inProject}/` : inProject)) return true;
    }
    if (under(rel, iosRel) && rel !== iosRel) {
      const inIos = rel.slice(iosRel.length + 1);
      return iosIgnore.ignores(isDir ? `${inIos}/` : inIos);
    }
    let ignored = false;
    for (const level of levels) {
      if (!under(rel, level.base) || rel === level.base) continue;
      const local = level.base ? rel.slice(level.base.length + 1) : rel;
      const result = level.ig.test(isDir ? `${local}/` : local);
      if (result.ignored) ignored = true;
      else if (result.unignored) ignored = false;
    }
    if (!ignored) return false;
    // Keep walking into ignored folders that contain the web assets or user includes.
    if (isDir && (isWebAncestor(rel) || hasUserInclude)) return false;
    return true;
  };

  const found: Array<{ rel: string; abs: string; size: number; mtimeMs: number }> = [];
  let skippedSymlinks = 0;

  const walk = async (dirAbs: string, dirRel: string, levels: Level[]): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    let current = levels;
    if (entries.some((e) => e.name === '.gitignore' && e.isFile())) {
      try {
        const content = await fs.readFile(path.join(dirAbs, '.gitignore'), 'utf8');
        current = [...levels, { base: dirRel, ig: ignore().add(content) }];
      } catch {
        // unreadable .gitignore
      }
    }
    const subdirs: Array<Promise<void>> = [];
    for (const entry of entries) {
      const rel = join(dirRel, entry.name);
      const abs = path.join(dirAbs, entry.name);
      if (entry.isSymbolicLink()) {
        skippedSymlinks += 1;
        continue;
      }
      if (entry.isDirectory()) {
        if (ALWAYS_SKIP.has(entry.name)) continue;
        if (excluded(rel, true, current)) continue;
        subdirs.push(walk(abs, rel, current));
        continue;
      }
      if (!entry.isFile()) continue;
      if (excluded(rel, false, current)) continue;
      found.push({ rel, abs, size: 0, mtimeMs: 0 });
    }
    await Promise.all(subdirs);
  };

  await walk(root, '', []);

  const cache = await loadCache(options.cacheFile);
  const nextCache: HashCache = { version: 1, files: {} };
  const files: LocalFile[] = [];
  let hashed = 0;

  await pool(found, 32, async (item) => {
    let st;
    try {
      st = await fs.stat(item.abs);
    } catch {
      return;
    }
    const cached = cache.files[item.rel];
    let hash: string;
    let flags: number;
    if (cached && cached[0] === st.size && cached[1] === st.mtimeMs) {
      hash = cached[2];
      flags = cached[3];
    } else {
      try {
        const result = await hashFile(item.abs, st.size, item.rel);
        hash = result.hash;
        flags = (result.exec ? 1 : 0) | (result.toLf ? 2 : 0);
        hashed += 1;
      } catch {
        return;
      }
    }
    nextCache.files[item.rel] = [st.size, st.mtimeMs, hash, flags];
    files.push({
      rel: item.rel,
      abs: item.abs,
      size: st.size,
      mtimeMs: st.mtimeMs,
      hash,
      mode: flags & 1 ? 0o755 : 0o644,
      toLf: Boolean(flags & 2),
    });
  });

  if (options.cacheFile) {
    try {
      await fs.mkdir(path.dirname(options.cacheFile), { recursive: true });
      await fs.writeFile(options.cacheFile, JSON.stringify(nextCache));
    } catch {
      // cache is an optimisation only
    }
  }

  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return { files, hashed, skippedSymlinks, ms: Date.now() - started };
}
