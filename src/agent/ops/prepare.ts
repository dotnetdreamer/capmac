import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { summarizeChanges } from '../../shared/classify.js';
import type { PrepareParams, PrepareResult } from '../../shared/protocol.js';
import { toolEnv } from '../env.js';
import {
  applyLocalNetworkingException,
  ensureWebDirStub,
  findCapacitorCli,
  locateIosProject,
  patchLiveUrl,
  removeLocalNetworkingException,
} from '../ios-project.js';
import { step, type AgentIO } from '../io.js';
import { AgentError, exists, run, which } from '../proc.js';
import { loadState, projectPaths, saveState, withProjectLock, type ProjectState } from '../state.js';

type PackageManager = 'npm' | 'yarn' | 'pnpm' | 'bun';

const DEPS_BASENAMES = new Set(['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'bun.lockb', 'bun.lock', '.npmrc', '.yarnrc', '.yarnrc.yml', '.pnpmfile.cjs']);

function depsHash(state: ProjectState): string {
  const hash = createHash('sha1');
  hash.update(process.versions.node.split('.')[0]!);
  for (const rel of Object.keys(state.manifest).sort()) {
    const base = rel.slice(rel.lastIndexOf('/') + 1);
    if (!DEPS_BASENAMES.has(base) || rel.split('/').includes('node_modules')) continue;
    hash.update(`${rel}:${state.manifest[rel]!.h}\n`);
  }
  return hash.digest('hex');
}

async function detectPackageManager(root: string): Promise<{ pm: PackageManager; version?: string; lockfile: boolean }> {
  let declared: string | undefined;
  try {
    declared = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).packageManager;
  } catch {
    // no package.json at the root
  }
  const m = declared?.match(/^(npm|yarn|pnpm|bun)@([^+\s]+)/);
  const lock = async (name: string) => exists(path.join(root, name));
  if (m) return { pm: m[1] as PackageManager, version: m[2], lockfile: true };
  if (await lock('pnpm-lock.yaml')) return { pm: 'pnpm', lockfile: true };
  if (await lock('yarn.lock')) return { pm: 'yarn', lockfile: true };
  if ((await lock('bun.lockb')) || (await lock('bun.lock'))) return { pm: 'bun', lockfile: true };
  if ((await lock('package-lock.json')) || (await lock('npm-shrinkwrap.json'))) return { pm: 'npm', lockfile: true };
  return { pm: 'npm', lockfile: false };
}

async function installCommand(root: string, pm: PackageManager, version: string | undefined, lockfile: boolean, env: NodeJS.ProcessEnv): Promise<{ cmd: string; args: string[]; label: string }> {
  const hasNodeModules = await exists(path.join(root, 'node_modules'));
  if (pm === 'npm') {
    const npm = (await which('npm', env)) ?? 'npm';
    const args = !hasNodeModules && lockfile ? ['ci'] : ['install', '--prefer-offline'];
    return { cmd: npm, args: [...args, '--no-audit', '--no-fund'], label: `npm ${args[0]}` };
  }
  if (pm === 'bun') {
    const bun = await which('bun', env);
    if (!bun) throw new AgentError('This project uses bun, which is not installed on the Mac.', 'TOOL_MISSING', 'Install it on the Mac: `curl -fsSL https://bun.sh/install | bash`.');
    return { cmd: bun, args: ['install'], label: 'bun install' };
  }
  const direct = await which(pm, env);
  const installArgs = pm === 'pnpm' ? ['install', '--prefer-offline'] : ['install'];
  if (direct) return { cmd: direct, args: installArgs, label: `${pm} install` };
  const corepack = await which('corepack', env);
  if (corepack) return { cmd: corepack, args: [pm, ...installArgs], label: `${pm} install (corepack)` };
  const npx = (await which('npx', env)) ?? 'npx';
  const spec = `${pm}@${version ?? (pm === 'yarn' ? '1' : 'latest')}`;
  return { cmd: npx, args: ['--yes', spec, ...installArgs], label: `${pm} install (npx ${spec})` };
}

function installEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    // Nothing on the Mac runs browsers or git hooks; skip the slow postinstall work.
    HUSKY: '0',
    PUPPETEER_SKIP_DOWNLOAD: '1',
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD: '1',
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
    CYPRESS_INSTALL_BINARY: '0',
    ELECTRON_SKIP_BINARY_DOWNLOAD: '1',
  };
}

export async function opPrepare(params: PrepareParams, io: AgentIO): Promise<PrepareResult> {
  const paths = projectPaths(params.projectId, params.projectRel);
  return withProjectLock(paths, io, async () => {
    const state = await loadState(paths);
    const env = await toolEnv();
    const iosDir = params.iosDir ?? 'ios';
    const ios = await locateIosProject(paths.project, iosDir);
    const changes = summarizeChanges(state.pendingChanges, { projectRel: params.projectRel, webDir: params.webDir, iosDir });
    const full = Boolean(params.full) || state.pendingFull;
    const infoPlistRel = [params.projectRel, iosDir, 'App', 'App', 'Info.plist'].filter(Boolean).join('/');
    const infoPlistAbs = path.join(ios.appDir, 'Info.plist');
    // A fresh Info.plist from Windows carries none of capmac's live-reload tweaks.
    if (state.pendingFull || state.pendingChanges.includes(infoPlistRel)) state.atsPatch = null;
    if (params.liveUrl) await ensureWebDirStub(paths.project, params.webDir);

    // 1. JavaScript dependencies (needed for `cap sync` and native plugin sources).
    const { pm, version, lockfile } = await detectPackageManager(paths.src);
    const wantDeps = depsHash(state);
    const hasModules = (await exists(path.join(paths.src, 'node_modules'))) || (await exists(path.join(paths.project, 'node_modules')));
    let installed = false;
    if (!params.skipInstall && (Boolean(params.full) || wantDeps !== state.depsHash || !hasModules)) {
      const command = await installCommand(paths.src, pm, version, lockfile, env);
      await step(io, 'install', `Installing dependencies (${command.label})`, async () => {
        const result = await run(command.cmd, command.args, {
          cwd: paths.src,
          env: installEnv(env),
          signal: io.signal,
          onLine: (line) => {
            if (line.trim()) io.send({ t: 'progress', text: line.trim().slice(0, 160) });
          },
        });
        if (result.cancelled) throw new AgentError('Cancelled', 'CANCELLED');
        if (result.code !== 0) {
          throw new AgentError(`${command.label} failed (exit ${result.code})`, 'INSTALL_FAILED', 'If the project uses a private registry, make sure its token is configured on the Mac (for example in ~/.npmrc).', result.tail.slice(-30));
        }
      });
      installed = true;
      state.depsHash = wantDeps;
      state.needsCapSync = true;
      await saveState(paths, state);
    }

    // 2. Capacitor: full `sync` when plugins/pods may have changed, otherwise a fast `copy`.
    const configMissing = !(await exists(path.join(ios.appDir, 'capacitor.config.json')));
    const podsMissing = ios.packageManager === 'CocoaPods' && !(await exists(path.join(ios.nativeProjectDir, 'Pods')));
    const needSync = full || state.needsCapSync || changes.deps || changes.pods || configMissing || podsMissing;
    const liveChanged = (state.liveUrl ?? null) !== (params.liveUrl ?? null);
    const needCopy = !needSync && (changes.capconfig || liveChanged || (!params.liveUrl && changes.web) || !(await exists(path.join(ios.appDir, 'public'))));
    const capCommand: PrepareResult['capCommand'] = needSync ? 'sync' : needCopy ? 'copy' : null;

    if (capCommand) {
      const cli = await findCapacitorCli(paths.project, paths.src);
      if (!cli) {
        throw new AgentError('@capacitor/cli is not installed in this project.', 'CAP_FAILED', 'Add it with `npm install -D @capacitor/cli` on Windows, then run again.');
      }
      await step(io, 'cap', `npx cap ${capCommand} ios`, async () => {
        const result = await run(process.execPath, [cli, capCommand, 'ios'], {
          cwd: paths.project,
          env: { ...env, CI: '1' },
          signal: io.signal,
          onLine: (line) => {
            const text = line.trim();
            if (!text) return;
            if (/^\[(warn|error)\]/.test(text)) io.log(text.startsWith('[error]') ? 'error' : 'warn', text.replace(/^\[(warn|error)\]\s*/, ''));
            else io.send({ t: 'progress', text: text.replace(/^[✔√]\s*/, '').slice(0, 160) });
          },
        });
        if (result.cancelled) throw new AgentError('Cancelled', 'CANCELLED');
        if (result.code !== 0) {
          throw new AgentError(`npx cap ${capCommand} ios failed (exit ${result.code})`, 'CAP_FAILED', undefined, result.tail.slice(-30));
        }
      });
    }

    // 3. Live reload: point the bundled config at the dev server…
    if (capCommand || liveChanged) {
      await patchLiveUrl(ios.appDir, params.liveUrl ?? null);
    }
    // …and let the app talk plain HTTP to it (only in the Mac's copy of Info.plist).
    let atsChanged = false;
    if (await exists(infoPlistAbs)) {
      if (params.liveUrl && !state.atsPatch) {
        const patch = await applyLocalNetworkingException(infoPlistAbs, env).catch((err) => {
          io.log('warn', `Could not add the local-network exception to Info.plist: ${err?.message ?? err}`);
          return null;
        });
        if (patch) {
          state.atsPatch = patch;
          atsChanged = true;
        }
      } else if (!params.liveUrl && state.atsPatch) {
        await removeLocalNetworkingException(infoPlistAbs, state.atsPatch, env);
        state.atsPatch = null;
        atsChanged = true;
      }
      // Keep the sync manifest in step so the edited file is not re-uploaded.
      const record = state.manifest[infoPlistRel];
      if (atsChanged && record) record.s = (await fs.stat(infoPlistAbs)).size;
    }

    const nativeDirty = full || changes.native || changes.pods || capCommand === 'sync' || atsChanged;
    if (nativeDirty) state.nativeGen += 1;
    const webChanged = capCommand !== null || liveChanged;
    if (webChanged) state.webGen += 1;
    state.liveUrl = params.liveUrl ?? null;
    if (capCommand === 'sync') state.needsCapSync = false;
    state.pendingChanges = [];
    state.pendingFull = false;
    await saveState(paths, state);

    return {
      installed,
      packageManager: pm,
      capCommand,
      iosPackageManager: ios.packageManager,
      nativeDirty,
      webChanged,
    };
  });
}
