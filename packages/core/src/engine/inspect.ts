/** What capmac Studio shows about a project before any Mac is involved. */
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { hasInstalledDependencies, loadProject, type ProjectInfo } from './project.js';
import { scanProject } from './scan.js';
import { scanOptionsFor } from './sync-client.js';

export interface ProjectSummary {
  /** A Capacitor app, or an Electron app on its own. */
  kind: ProjectInfo['kind'];
  /** Folder with capacitor.config.* (or the Electron app's package.json). */
  path: string;
  appName: string;
  appId: string;
  projectId: string;
  iosPackageManager: ProjectInfo['iosPackageManager'];
  hasIos: boolean;
  webDir: string;
  packageManager: ProjectInfo['packageManager'];
  /** Largest app icon PNG in AppIcon.appiconset (or the Electron app's icon), if any. */
  iconPath: string | null;
  /** The Mac this project is pinned to in capmac.json. */
  host: string | null;
  /** Whether node_modules exists on this PC (needed for the web build and the dev server). */
  hasNodeModules: boolean;
  /** The dev server command or URL live reload would use, if any. */
  devCommand: string | null;
  /** The Electron app (the project itself, or Capacitor's Electron platform), which runs on the Mac's desktop. */
  electron: {
    flavor: NonNullable<ProjectInfo['electron']>['flavor'];
    /** POSIX path from the project to the app ('' when it is the project). */
    rel: string;
    name: string;
    electronRange: string | null;
  } | null;
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
  const electron = project.electron;
  // An Electron app's dev command runs on the Mac: nothing to install on this PC for it.
  const devCommand = project.kind === 'electron'
    ? null
    : project.config.web?.devUrl ?? project.config.web?.dev ?? (project.scripts.dev ? 'dev' : project.scripts.start ? 'start' : project.scripts.serve ? 'serve' : null);
  return {
    kind: project.kind,
    path: project.capDir,
    appName: project.appName,
    appId: project.appId,
    projectId: project.projectId,
    iosPackageManager: project.iosPackageManager,
    hasIos: project.hasIos,
    webDir: project.webDir,
    packageManager: project.packageManager,
    iconPath: (project.hasIos ? await findAppIcon(project) : null) ?? electron?.icon ?? null,
    host: project.config.host ?? null,
    hasNodeModules: hasInstalledDependencies(project),
    devCommand,
    electron: electron ? { flavor: electron.flavor, rel: electron.rel, name: electron.name, electronRange: electron.electronRange } : null,
  };
}

/** How much `capmac run` would sync: file count and bytes (uses the hash cache, so it is fast after the first run). */
export async function syncSize(project: ProjectInfo, includeWebDir = true): Promise<{ files: number; bytes: number }> {
  const scan = await scanProject(scanOptionsFor(project, includeWebDir));
  return { files: scan.files.length, bytes: scan.files.reduce((sum, f) => sum + f.size, 0) };
}
