/**
 * Finding the Electron app in a project: a plain Electron app (its
 * package.json depends on electron), one built with electron-vite or
 * Electron Forge, or Capacitor's Electron platform (the electron/ folder of
 * @capacitor-community/electron). No Mac involved.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ElectronFlavor } from '../shared/electron.js';
import type { ProjectConfig } from './config.js';

export interface ElectronProject {
  flavor: ElectronFlavor;
  /** The Electron app's folder on this PC. */
  dir: string;
  /** POSIX path from the project folder to the app ('' when it is the project itself). */
  rel: string;
  /** The app's name (productName, else name, in its package.json). */
  name: string;
  /** The app id electron-builder or Electron Forge would sign with, when the project says. */
  appId: string | null;
  /** The Electron version the app asks for (its package.json), for display. */
  electronRange: string | null;
  scripts: Record<string, string>;
  /** The app's main entry (package.json `main`). */
  main: string | null;
  /** A PNG of the app's icon, if the project has one. */
  icon: string | null;
}

type PackageJson = {
  name?: string;
  productName?: string;
  main?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  build?: { appId?: string; productName?: string; icon?: string; mac?: { icon?: string }; directories?: { buildResources?: string } };
  config?: { forge?: { packagerConfig?: { appBundleId?: string; icon?: string; name?: string } } };
};

export function readPackageJson(dir: string): PackageJson | null {
  try {
    return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as PackageJson;
  } catch {
    return null;
  }
}

export function allDependencies(pkg: PackageJson | null): Record<string, string> {
  return { ...pkg?.optionalDependencies, ...pkg?.dependencies, ...pkg?.devDependencies };
}

/** Whether a package.json is an Electron app's (it depends on Electron). */
export function dependsOnElectron(pkg: PackageJson | null): boolean {
  const deps = allDependencies(pkg);
  return Boolean(deps.electron || deps['electron-nightly']);
}

/** How the app is built: by the tool it depends on. */
export function electronFlavor(pkg: PackageJson | null, capacitor: boolean): ElectronFlavor {
  if (capacitor) return 'capacitor';
  const deps = allDependencies(pkg);
  if (deps['electron-vite']) return 'electron-vite';
  if (deps['@electron-forge/cli']) return 'forge';
  return 'plain';
}

/** Capacitor's Electron platform in a Capacitor project (the electron/ folder), if it has one. */
export function capacitorElectronDir(capDir: string, config: ProjectConfig): string | null {
  const dir = path.resolve(capDir, config.electron?.dir ?? 'electron');
  const pkg = readPackageJson(dir);
  if (!pkg) return null;
  const deps = allDependencies(pkg);
  return dependsOnElectron(pkg) || deps['@capacitor-community/electron'] ? dir : null;
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

const BUILDER_FILES = [
  'electron-builder.json',
  'electron-builder.json5',
  'electron-builder.config.json',
  'electron-builder.yml',
  'electron-builder.yaml',
  'electron-builder.config.js',
  'electron-builder.config.cjs',
  'electron-builder.config.mjs',
  'electron-builder.config.ts',
  'forge.config.js',
  'forge.config.cjs',
  'forge.config.mjs',
  'forge.config.ts',
];

/** electron-builder's or Forge's settings, read without running the project's code. */
function builderSetting(dir: string, pkg: PackageJson | null, key: 'appId' | 'icon' | 'productName'): string | null {
  const inPackage =
    key === 'appId'
      ? pkg?.build?.appId ?? pkg?.config?.forge?.packagerConfig?.appBundleId
      : key === 'icon'
        ? pkg?.build?.mac?.icon ?? pkg?.build?.icon ?? pkg?.config?.forge?.packagerConfig?.icon
        : pkg?.build?.productName ?? pkg?.config?.forge?.packagerConfig?.name;
  if (inPackage) return inPackage;
  const forgeKey = key === 'appId' ? 'appBundleId' : 'icon';
  for (const file of BUILDER_FILES) {
    // Forge's makers have names too: its app name is only trusted from package.json.
    if (key === 'productName' && file.startsWith('forge')) continue;
    const text = readText(path.join(dir, file));
    if (!text) continue;
    const name = file.startsWith('forge') ? forgeKey : key;
    // In code (not JSON or YAML), only a quoted value is the setting: `appId = process.env.X` is not.
    const quote = /\.[cm]?[jt]s$/.test(file) ? '["\'`]' : '["\'`]?';
    const value = text.match(new RegExp(`["']?\\b${name}["']?\\s*[:=]\\s*${quote}([^"'\`\\n,}]+)`))?.[1]?.trim();
    if (value) return value;
  }
  return null;
}

/** The Electron app's name as it shows in the Dock: its packaging settings' productName, else its package.json name. */
export function electronProductName(app: Pick<ElectronProject, 'dir' | 'name'>): string {
  return builderSetting(app.dir, readPackageJson(app.dir), 'productName') ?? app.name;
}

/** A PNG of the app's icon: the one the packaging tool uses, else the usual places. */
function findIcon(dir: string, pkg: PackageJson | null): string | null {
  const candidates: string[] = [];
  const configured = builderSetting(dir, pkg, 'icon');
  if (configured) {
    const base = path.resolve(dir, configured);
    candidates.push(base.endsWith('.png') ? base : `${base.replace(/\.(icns|ico)$/i, '')}.png`);
  }
  const resources = pkg?.build?.directories?.buildResources ?? 'build';
  candidates.push(
    path.join(dir, resources, 'icon.png'),
    path.join(dir, 'build', 'icon.png'),
    path.join(dir, 'build', 'icons', '512x512.png'),
    path.join(dir, 'resources', 'icon.png'),
    path.join(dir, 'resources', 'icons', '512x512.png'),
    path.join(dir, 'assets', 'icon.png'),
    path.join(dir, 'assets', 'appIcon.png'),
    path.join(dir, 'src', 'assets', 'icon.png'),
    path.join(dir, 'public', 'icon.png'),
    path.join(dir, 'icon.png'),
  );
  return candidates.find((file) => existsSync(file)) ?? null;
}

/** What CapMac needs to know about the Electron app in `dir`. */
export function describeElectronApp(dir: string, rel: string, capacitor: boolean): ElectronProject {
  const pkg = readPackageJson(dir);
  const deps = allDependencies(pkg);
  return {
    flavor: electronFlavor(pkg, capacitor),
    dir,
    rel,
    name: pkg?.productName ?? pkg?.build?.productName ?? pkg?.name ?? path.basename(dir),
    appId: builderSetting(dir, pkg, 'appId'),
    electronRange: deps.electron ?? deps['electron-nightly'] ?? null,
    scripts: pkg?.scripts ?? {},
    main: pkg?.main ?? null,
    icon: findIcon(dir, pkg),
  };
}
