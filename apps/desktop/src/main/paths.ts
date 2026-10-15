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

export function sampleDir(): string | null {
  const dir = app.isPackaged ? resources('sample') : path.join(appRoot(), '..', '..', 'examples', 'hello-capacitor');
  return existsSync(dir) ? dir : null;
}

/** The Electron sample ("Try the Electron sample"). */
export function electronSampleDir(): string | null {
  const dir = app.isPackaged ? resources('sample-electron') : path.join(appRoot(), '..', '..', 'examples', 'hello-electron');
  return existsSync(dir) ? dir : null;
}

/** node-datachannel (WebRTC for remote access), shipped next to app.asar; in development it comes from node_modules. */
export function remoteModulesDir(): string | null {
  if (!app.isPackaged) return null;
  const dir = resources('remote');
  return existsSync(dir) ? dir : null;
}

export function rendererDir(): string {
  return outDir('renderer');
}
