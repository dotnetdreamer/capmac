import {bundle} from '@remotion/bundler';
import {openBrowser, renderStill, selectComposition} from '@remotion/renderer';
import {mkdir} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// Review frames for a film: `node scripts/previews.mjs CapMacIntro` exports its shot list,
// `node scripts/previews.mjs CapMacIntro 500 hook=40` exports just those frames
const SHOTS = {
  CapMacIntro: {
    '01-title': 40, '02-frameworks': 140, '03-terminal-rise': 215, '04-pair': 300, '05-cap-run': 400, '06-running': 470,
    '07-live-press': 483, '08-steps': 560, '09-app-opens': 625, '10-activity': 680, '11-reload-type': 770, '12-reloaded': 850, '13-reload-pan': 940,
    '14-no-mac-title': 1000, '15-mac-menu': 1050, '16-setup-banner': 1075, '17-setup-signin': 1140, '18-setup-download': 1195, '19-setup-done': 1225,
    '20-pc-run': 1290, '21-iphone': 1340, '22-wifi': 1372, '23-twins': 1460, '24-desktop-apps': 1640, '25-console': 1740, '26-problems': 1800,
    '27-source': 1830, '28-front-ends': 1980, '29-agents': 2180, '30-ship': 2330, '31-finale': 2470,
  },
  CapMacVSCodeIntro: {
    '01-title': 40, '02-frameworks': 140, '03-rise': 205, '04-explorer': 250, '05-activate': 276, '06-capmac-views': 340, '07-lens': 440,
    '08-live-click': 483, '09-steps': 545, '10-screen-opens': 606, '11-app': 660, '12-theme-type': 756, '13-reloaded': 792, '14-activity': 860,
    '15-bloom-click': 917, '16-bloom-run': 952, '17-bloom-type': 990, '18-bloom-reloaded': 1012, '19-pulse-run': 1062, '20-pulse-refreshed': 1116,
    '21-swift-type': 1162, '22-failed': 1216, '23-problem-click': 1240, '24-fixed': 1305, '25-devices': 1352, '26-no-mac': 1392, '27-mac-app': 1452,
    '28-chat-confirm': 1552, '29-chat-done': 1632, '30-toast': 1690, '31-wide': 1800, '32-leave': 1905, '33-finale': 1990,
  },
};

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [id = 'CapMacIntro', ...picked] = process.argv.slice(2);
const shots = picked.length ? Object.fromEntries(picked.map(arg => arg.includes('=') ? arg.split('=') : [`f${arg}`, arg]).map(([name, frame]) => [name, Number(frame)])) : SHOTS[id];
const output = resolve(project, '../../out/previews', id);
await mkdir(output, {recursive: true});
const serveUrl = await bundle({entryPoint: resolve(project, 'src/index.ts'), publicDir: resolve(project, 'public')});
const browser = await openBrowser('chrome');
try {
  const composition = await selectComposition({serveUrl, id, browserInstance: browser});
  for (const [name, frame] of Object.entries(shots)) {
    await renderStill({serveUrl, composition, frame, output: resolve(output, `${name}.png`), browserInstance: browser, imageFormat: 'png', logLevel: 'error'});
    process.stdout.write(`${name} · frame ${frame}\n`);
  }
} finally {
  await browser.close({silent: true});
}
