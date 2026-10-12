import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AgentError, capture, exists } from './proc.js';

export interface IosProject {
  /** <project>/ios */
  platformDir: string;
  /** <project>/ios/App */
  nativeProjectDir: string;
  /** <project>/ios/App/App — holds capacitor.config.json and public/ */
  appDir: string;
  xcodeproj: string;
  workspace: string | null;
  packageManager: 'SPM' | 'CocoaPods' | 'unknown';
}

async function listWithExtension(dir: string, ext: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).filter((name) => name.endsWith(ext)).sort();
  } catch {
    return [];
  }
}

/** Finds the Xcode project Capacitor generated (ios/App/App.xcodeproj by default). */
export async function locateIosProject(projectDir: string, iosDirRel = 'ios'): Promise<IosProject> {
  const platformDir = path.join(projectDir, ...iosDirRel.split('/'));
  const nativeProjectDir = path.join(platformDir, 'App');
  if (!(await exists(nativeProjectDir))) {
    throw new AgentError(
      `No iOS project at ${iosDirRel}/App.`,
      'NO_IOS_PLATFORM',
      'Add the iOS platform first: on Windows run `npx cap add ios` (Swift Package Manager: `npx cap add ios --packagemanager SPM`), or let the Mac do it with `capmac exec -- npx cap add ios` followed by `capmac pull ios`.',
    );
  }
  const projects = await listWithExtension(nativeProjectDir, '.xcodeproj');
  const xcodeprojName = projects.includes('App.xcodeproj') ? 'App.xcodeproj' : projects[0];
  if (!xcodeprojName) {
    throw new AgentError(`No .xcodeproj found in ${iosDirRel}/App.`, 'NO_IOS_PLATFORM', 'Re-create the iOS platform with `npx cap add ios`.');
  }
  const workspaces = await listWithExtension(nativeProjectDir, '.xcworkspace');
  const workspaceName = workspaces.includes('App.xcworkspace') ? 'App.xcworkspace' : workspaces[0];
  const hasPodfile = await exists(path.join(nativeProjectDir, 'Podfile'));
  const hasSpm = await exists(path.join(nativeProjectDir, 'CapApp-SPM'));
  return {
    platformDir,
    nativeProjectDir,
    appDir: path.join(nativeProjectDir, 'App'),
    xcodeproj: path.join(nativeProjectDir, xcodeprojName),
    workspace: workspaceName ? path.join(nativeProjectDir, workspaceName) : null,
    packageManager: hasSpm ? 'SPM' : hasPodfile ? 'CocoaPods' : 'unknown',
  };
}

/** Points the bundled capacitor.config.json at a dev server (or removes the override). */
export async function patchLiveUrl(appDir: string, url: string | null): Promise<void> {
  const file = path.join(appDir, 'capacitor.config.json');
  let config: any = {};
  try {
    config = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    if (!url) return;
  }
  if (url) {
    config.server = { ...(config.server ?? {}), url, cleartext: true };
  } else if (config.server) {
    delete config.server.url;
    if (Object.keys(config.server).length === 0) delete config.server;
  }
  await fs.writeFile(file, `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * Capacitor's bridge refuses to start without a bundled web folder, even when
 * server.url points at a dev server. In live-reload mode the real build may
 * never have been synced, so leave a placeholder for `cap copy` to bundle.
 */
export async function ensureWebDirStub(projectDir: string, webDir: string): Promise<boolean> {
  const dir = path.join(projectDir, ...webDir.split('/'));
  const index = path.join(dir, 'index.html');
  if (await exists(index)) return false;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(index, '<!doctype html><meta charset="utf-8"><title>CapMac</title><p style="font:16px -apple-system;padding:2em">Waiting for the dev server (CapMac live reload)…</p>\n');
  return true;
}

export type AtsPatch = 'dict' | 'key' | null;

/**
 * Lets the app load plain-HTTP dev servers on localhost / LAN IPs by adding
 * NSAppTransportSecurity › NSAllowsLocalNetworking to the Mac's copy of
 * Info.plist (never the developer's own file). Returns what was added so it
 * can be removed again. Apps that already allow arbitrary loads are left
 * alone: adding the key would switch ATS back on for every other host.
 */
export async function applyLocalNetworkingException(infoPlist: string, env: NodeJS.ProcessEnv): Promise<AtsPatch> {
  const json = await capture('plutil', ['-convert', 'json', '-o', '-', infoPlist], { env });
  const ats = JSON.parse(json).NSAppTransportSecurity;
  if (ats?.NSAllowsArbitraryLoads === true || ats?.NSAllowsLocalNetworking === true) return null;
  if (!ats) {
    await capture('plutil', ['-insert', 'NSAppTransportSecurity', '-json', '{"NSAllowsLocalNetworking":true}', infoPlist], { env });
    return 'dict';
  }
  await capture('plutil', ['-insert', 'NSAppTransportSecurity.NSAllowsLocalNetworking', '-bool', 'YES', infoPlist], { env });
  return 'key';
}

export async function removeLocalNetworkingException(infoPlist: string, patch: AtsPatch, env: NodeJS.ProcessEnv): Promise<void> {
  if (!patch) return;
  const keyPath = patch === 'dict' ? 'NSAppTransportSecurity' : 'NSAppTransportSecurity.NSAllowsLocalNetworking';
  await capture('plutil', ['-remove', keyPath, infoPlist], { env });
}

/** Locates the project's @capacitor/cli entry, walking up for hoisted installs. */
export async function findCapacitorCli(projectDir: string, stopAt: string): Promise<string | null> {
  let dir = projectDir;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', '@capacitor', 'cli', 'bin', 'capacitor');
    if (await exists(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (dir === stopAt || parent === dir || !dir.startsWith(stopAt)) return null;
    dir = parent;
  }
}
