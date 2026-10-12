// npm run dist: builds out/, then the installers and portable exes with electron-builder,
// signed and with an update feed when the environment says so (see release-config.mjs).
//   node scripts/dist.mjs            NSIS installer + portable, x64 and arm64
//   node scripts/dist.mjs --x64      the same for x64 only
//   node scripts/dist.mjs --dir      just release/<version>/win-unpacked (x64, no update feed), to try things quickly
import path from 'node:path';
import { Arch, build, Platform } from 'electron-builder';
import { desktopDir } from './config.mjs';
import { releaseConfig } from './release-config.mjs';

const dir = process.argv.includes('--dir');
const x64 = process.argv.includes('--x64');
let release;
try {
  release = releaseConfig(process.env);
} catch (err) {
  console.error(`capmac Studio: ${err.message}`);
  process.exit(1);
}
for (const note of release.notes) console.log(`capmac Studio: ${note}`);

await import('./build.mjs');

await build({
  projectDir: desktopDir,
  targets: dir ? Platform.WINDOWS.createTarget('dir', Arch.x64) : x64 ? Platform.WINDOWS.createTarget(['nsis', 'portable'], Arch.x64) : Platform.WINDOWS.createTarget(),
  config: { extends: path.join(desktopDir, 'electron-builder.yml'), ...release.config },
  publish: 'never',
});
