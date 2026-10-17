/** What capmac Studio shows about a project before any Mac is involved. */
import { appsOf, type ProjectApp } from './apps.js';
import { backendOf } from './backend.js';
import { appFor, hasInstalledDependencies, loadProject, type BuildBackend, type ProjectInfo, type RunnableApp } from './project.js';
import { scanProject } from './scan.js';
import { scanOptionsFor } from './sync-client.js';

export interface ProjectSummary {
  /** A Capacitor app, an Electron app on its own, a Flutter app, or a React Native app. */
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
  /** The icon of the app CapMac works on (an iOS app's largest AppIcon PNG, an Electron app's icon), else of another of its apps, if any. */
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
  /** A Flutter app's details: its platform folders, entry point and the Flutter version it asks for. */
  flutter: {
    name: string;
    platforms: NonNullable<ProjectInfo['flutter']>['platforms'];
    target: string;
    flavor: string | null;
    /** The Flutter version the project pins (FVM, capmac.json), else its pubspec constraint. */
    wants: string | null;
  } | null;
  /** A React Native app's details: its platform folders, whether it is an Expo app, and the versions it asks for. */
  reactNative: {
    name: string;
    expo: boolean;
    platforms: NonNullable<ProjectInfo['reactNative']>['platforms'];
    /** An Expo app whose ios/ folder `expo prebuild` makes on its first build. */
    prebuild: boolean;
    versions: NonNullable<ProjectInfo['reactNative']>['versions'];
  } | null;
  /** Its apps: the iOS app, the Electron app, a Flutter or React Native app's Mac and Windows apps, when it has them (see apps.ts). */
  apps: ProjectApp[];
  /** The app Run and Live use: the one picked for the project, else the iOS app, else the Electron app. */
  app: RunnableApp;
  /** Whether that app was picked (in CapMac Studio, or with `capmac apps use`) rather than taken by default. */
  appChosen: boolean;
  /** Where the iOS app builds: a paired Mac, or this PC (`capmac backend`). */
  backend: BuildBackend;
}

export async function inspectProject(dir: string): Promise<ProjectSummary> {
  return summarizeProject(await loadProject(dir));
}

/** The summary of a project already loaded (loading a TypeScript config runs the project's Capacitor CLI). */
export async function summarizeProject(project: ProjectInfo): Promise<ProjectSummary> {
  const electron = project.electron;
  // An Electron app's dev command runs on the Mac: nothing to install on this PC for it.
  const devCommand = project.kind === 'react-native'
    // Metro runs on this PC: it needs the app's packages here.
    ? (project.reactNative?.expo ? 'expo start' : 'react-native start')
    : project.kind !== 'capacitor'
      ? null
      : project.config.web?.devUrl ?? project.config.web?.dev ?? (project.scripts.dev ? 'dev' : project.scripts.start ? 'start' : project.scripts.serve ? 'serve' : null);
  const apps = await appsOf(project);
  const app = appFor(project);
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
    iconPath: apps.find((a) => a.id === app)?.icon ?? apps.find((a) => a.icon)?.icon ?? null,
    host: project.config.host ?? null,
    hasNodeModules: hasInstalledDependencies(project),
    devCommand,
    electron: electron ? { flavor: electron.flavor, rel: electron.rel, name: electron.name, electronRange: electron.electronRange } : null,
    flutter: project.flutter
      ? { name: project.flutter.name, platforms: project.flutter.platforms, target: project.flutter.target, flavor: project.flutter.options.flavor ?? null, wants: project.flutter.wantsFlutter.exact ?? project.flutter.wantsFlutter.constraint }
      : null,
    reactNative: project.reactNative
      ? { name: project.reactNative.name, expo: project.reactNative.expo, platforms: project.reactNative.platforms, prebuild: project.reactNative.prebuild, versions: project.reactNative.versions }
      : null,
    apps,
    app,
    appChosen: project.chosenApp === app,
    backend: await backendOf(project),
  };
}

/** How much `capmac run` would sync: file count and bytes (uses the hash cache, so it is fast after the first run). */
export async function syncSize(project: ProjectInfo, includeWebDir = true): Promise<{ files: number; bytes: number }> {
  const scan = await scanProject(scanOptionsFor(project, includeWebDir));
  return { files: scan.files.length, bytes: scan.files.reduce((sum, f) => sum + f.size, 0) };
}
