/** What capmac Studio shows about a project before any Mac is involved. */
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { hasInstalledDependencies, loadProject, type ProjectInfo } from './project.js';
import { scanProject } from './scan.js';
import { scanCacheFile } from './sync-client.js';

export interface ProjectSummary {
  /** Folder with capacitor.config.* */
  path: string;
  appName: string;
  appId: string;
  projectId: string;
  iosPackageManager: ProjectInfo['iosPackageManager'];
  hasIos: boolean;
  webDir: string;
  packageManager: ProjectInfo['packageManager'];
  /** Largest app icon PNG in AppIcon.appiconset, if any. */
  iconPath: string | null;
  /** The Mac this project is pinned to in capmac.json. */
  host: string | null;
  /** Whether node_modules exists on this PC (needed for the web build and the dev server). */
  hasNodeModules: boolean;
  /** The dev server command or URL live reload would use, if any. */
  devCommand: string | null;
}

export async function findAppIcon(project: Pick<ProjectInfo, 'capDir' | 'iosDir'>): Promise<string | null> {
  const appDir = path.join(project.capDir, project.iosDir, 'App', 'App');
  let sets: string[] = [];
  try {
    sets = (await fs.readdir(path.join(appDir, 'Assets.xcassets'))).filter((name) => name.endsWith('.appiconset'));
  } catch {
    return null;
  }
  // Prefer the set called AppIcon (what Xcode uses by default).
  sets.sort((a, b) => (a === 'AppIcon.appiconset' ? -1 : b === 'AppIcon.appiconset' ? 1 : a.localeCompare(b)));
  for (const set of sets) {
    const dir = path.join(appDir, 'Assets.xcassets', set);
    let images: Array<{ filename?: string; size?: string; scale?: string }> = [];
    try {
      images = JSON.parse(await fs.readFile(path.join(dir, 'Contents.json'), 'utf8')).images ?? [];
    } catch {
      continue;
    }
    const pixels = (img: { size?: string; scale?: string }) => Number(img.size?.split('x')[0] ?? 0) * Number(img.scale?.replace('x', '') ?? 1);
    const best = images.filter((img) => img.filename && existsSync(path.join(dir, img.filename))).sort((a, b) => pixels(b) - pixels(a))[0];
    if (best?.filename) return path.join(dir, best.filename);
  }
  return null;
}

export async function inspectProject(dir: string): Promise<ProjectSummary> {
  const project = await loadProject(dir);
  const devCommand = project.config.web?.devUrl ?? project.config.web?.dev ?? (project.scripts.dev ? 'dev' : project.scripts.start ? 'start' : project.scripts.serve ? 'serve' : null);
  return {
    path: project.capDir,
    appName: project.appName,
    appId: project.appId,
    projectId: project.projectId,
    iosPackageManager: project.iosPackageManager,
    hasIos: project.hasIos,
    webDir: project.webDir,
    packageManager: project.packageManager,
    iconPath: await findAppIcon(project),
    host: project.config.host ?? null,
    hasNodeModules: hasInstalledDependencies(project),
    devCommand,
  };
}

/** How much `capmac run` would sync: file count and bytes (uses the hash cache, so it is fast after the first run). */
export async function syncSize(project: ProjectInfo, includeWebDir = true): Promise<{ files: number; bytes: number }> {
  const scan = await scanProject({
    root: project.syncRoot,
    projectRel: project.projectRel,
    webDir: project.webDir,
    iosDir: project.iosDir,
    includeWebDir,
    include: project.config.sync?.include,
    exclude: project.config.sync?.exclude,
    cacheFile: scanCacheFile(project),
  });
  return { files: scan.files.length, bytes: scan.files.reduce((sum, f) => sum + f.size, 0) };
}
