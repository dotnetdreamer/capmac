// node-datachannel (WebRTC for remote access) for the packaged app. It is a
// native module, so it ships outside app.asar, one copy per architecture:
//   out/remote/<arch>/node_modules/{node-datachannel, detect-libc, @node-datachannel/win32-<arch>-msvc}
// electron-builder copies the right one to resources/remote. The engine and
// the standalone CLI load it from there (setNodeDataChannelDir).
import { spawnSync } from 'node:child_process';
import { existsSync, promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';

const ARCHES = ['x64', 'arm64'];

async function copyFiltered(from, to, keep) {
  await fs.cp(from, to, { recursive: true, filter: (src) => keep(path.relative(from, src).split(path.sep).join('/')) });
}

/** The win32 binary package for `arch`: from node_modules, or fetched with npm pack (other architectures). */
async function binaryPackage(repoDir, arch, version) {
  const name = `@node-datachannel/win32-${arch}-msvc`;
  const installed = path.join(repoDir, 'node_modules', name);
  if (existsSync(path.join(installed, 'package.json')) && JSON.parse(readFileSync(path.join(installed, 'package.json'), 'utf8')).version === version) return installed;
  const cache = path.join(repoDir, 'node_modules', '.cache', 'capmac-node-datachannel', `${arch}-${version}`);
  if (existsSync(path.join(cache, 'package.json'))) return cache;
  await fs.mkdir(cache, { recursive: true });
  const pack = spawnSync(`npm pack ${name}@${version} --silent --pack-destination "${cache}"`, { encoding: 'utf8', shell: true });
  if (pack.status !== 0) throw new Error(`Could not download ${name}@${version}: ${pack.stderr || pack.stdout}`);
  const tarball = path.join(cache, pack.stdout.trim().split(/\r?\n/).pop());
  // A relative name: GNU tar (Git Bash) reads "C:" in a path as a remote host.
  const untar = spawnSync('tar', ['-xzf', path.basename(tarball), '--strip-components=1'], { cwd: cache, encoding: 'utf8' });
  if (untar.status !== 0) throw new Error(`Could not unpack ${tarball}: ${untar.stderr}`);
  await fs.rm(tarball, { force: true });
  return cache;
}

/** Stages node-datachannel for every Windows architecture into `outDir/<arch>/node_modules`. */
export async function stageRemoteModules(repoDir, outDir) {
  const source = path.join(repoDir, 'node_modules', 'node-datachannel');
  const version = JSON.parse(readFileSync(path.join(source, 'package.json'), 'utf8')).version;
  for (const arch of ARCHES) {
    const modules = path.join(outDir, arch, 'node_modules');
    await fs.rm(path.join(outDir, arch), { recursive: true, force: true });
    // Only what require() loads: the CommonJS build, its package.json and licence.
    await copyFiltered(source, path.join(modules, 'node-datachannel'), (rel) => rel === '' || rel === 'package.json' || /^LICENSE/i.test(rel) || rel === 'dist' || rel.startsWith('dist/cjs'));
    await fs.cp(path.join(repoDir, 'node_modules', 'detect-libc'), path.join(modules, 'detect-libc'), { recursive: true });
    await fs.cp(await binaryPackage(repoDir, arch, version), path.join(modules, '@node-datachannel', `win32-${arch}-msvc`), { recursive: true });
  }
  return version;
}
