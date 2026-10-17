// npm run dist: builds out/, then the installers and portable exes with electron-builder,
// signed and with an update feed when the environment says so (see release-config.mjs).
// They carry the screen-mirroring receiver (mirror-receiver.mjs: set CAPMAC_MIRROR_RECEIVER).
//   node scripts/dist.mjs            NSIS installer + portable, x64 and arm64
//   node scripts/dist.mjs --x64      the same for x64 only
//   node scripts/dist.mjs --dir      just release/<version>/win-unpacked (x64, no update feed), to try things quickly
import path from 'node:path';
import { Arch, build, Platform } from 'electron-builder';
import { desktopDir } from './config.mjs';
import { stageMirrorReceiver } from './mirror-receiver.mjs';
import { releaseConfig } from './release-config.mjs';

const dir = process.argv.includes('--dir');
const x64 = process.argv.includes('--x64');
let release;
try {
  release = releaseConfig(process.env);
} catch (err) {
  console.error(`CapMac Studio: ${err.message}`);
  process.exit(1);
}
for (const note of release.notes) console.log(`CapMac Studio: ${note}`);

await import('./build.mjs');

// This PC's iPhone screen: the receiver goes next to app.asar (an x64 build, which Windows on Arm runs too).
try {
  const receiver = await stageMirrorReceiver(path.join(desktopDir, 'out', 'mirror-receiver'));
  console.log(`CapMac Studio: screen receiver ${receiver.version} from ${receiver.dir}`);
} catch (err) {
  console.error(`CapMac Studio: ${err.message}`);
  process.exit(1);
}

await build({
  projectDir: desktopDir,
  targets: dir ? Platform.WINDOWS.createTarget('dir', Arch.x64) : x64 ? Platform.WINDOWS.createTarget(['nsis', 'portable'], Arch.x64) : Platform.WINDOWS.createTarget(),
  config: { extends: path.join(desktopDir, 'electron-builder.yml'), ...release.config },
  publish: 'never',
});
