/** Where capmac Studio finds its files, in development and when packaged. */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

/** apps/desktop in development; resources/app.asar when packaged. */
const appRoot = () => app.getAppPath();

/** Built output (main, preload, engine, renderer). */
export function outDir(...parts: string[]): string {
  return path.join(appRoot(), 'out', ...parts);
}

/** Files shipped next to app.asar (electron-builder extraResources). */
function resources(...parts: string[]): string {
  return path.join(process.resourcesPath, ...parts);
}

export function agentPath(): string {
  return app.isPackaged ? resources('agent', 'agent.mjs') : outDir('agent', 'agent.mjs');
}

/** The capmac CLI shipped for takeover: cli.mjs, agent.mjs and takeover.cjs, run by the user's own Node.js. */
export function cliDir(): string {
  return app.isPackaged ? resources('cli') : outDir('cli');
}

export function iconsDir(): string {
  return app.isPackaged ? resources('icons') : path.join(appRoot(), 'resources', 'icons');
}

function firstExisting(dirs: string[]): string | null {
  return dirs.find((dir) => existsSync(dir)) ?? null;
}

/**
 * The sample ("Try a sample"). Installed: next to app.asar. Otherwise the
 * repo's examples folder, else the copy a production build put in out/ (a
 * build copied out of the repo has no examples folder around it).
 */
export function sampleDir(): string | null {
  return firstExisting(app.isPackaged ? [resources('sample')] : [path.join(appRoot(), '..', '..', 'examples', 'hello-capacitor'), outDir('sample')]);
}

/** The Electron sample ("Try the Electron sample"), found the same way. */
export function electronSampleDir(): string | null {
  return firstExisting(app.isPackaged ? [resources('sample-electron')] : [path.join(appRoot(), '..', '..', 'examples', 'hello-electron'), outDir('sample-electron')]);
}

/** The Flutter sample ("Try the Flutter sample"), found the same way. */
export function flutterSampleDir(): string | null {
  return firstExisting(app.isPackaged ? [resources('sample-flutter')] : [path.join(appRoot(), '..', '..', 'examples', 'hello-flutter'), outDir('sample-flutter')]);
}

/** The React Native sample ("Try the React Native sample"), found the same way. */
export function reactNativeSampleDir(): string | null {
  return firstExisting(app.isPackaged ? [resources('sample-react-native')] : [path.join(appRoot(), '..', '..', 'examples', 'hello-react-native'), outDir('sample-react-native')]);
}

/** node-datachannel (WebRTC for remote access), shipped next to app.asar; in development it comes from node_modules. */
export function remoteModulesDir(): string | null {
  if (!app.isPackaged) return null;
  const dir = resources('remote');
  return existsSync(dir) ? dir : null;
}

/**
 * CapMac's screen-mirroring receiver (UxPlay), shipped next to app.asar: also when it went missing,
 * so the engine says to install Studio again. In development the engine finds the one set up on this PC.
 */
export function mirrorReceiverDir(): string | null {
  return app.isPackaged ? resources('mirror-receiver') : null;
}

export function rendererDir(): string {
  return outDir('renderer');
}
