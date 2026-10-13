import {bundle} from '@remotion/bundler';
import {openBrowser, renderStill, selectComposition} from '@remotion/renderer';
import {mkdir} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(project, '../../out/intro-v3-frames');
await mkdir(output, {recursive: true});
const serveUrl = await bundle({entryPoint: resolve(project, 'src/index.ts'), publicDir: resolve(project, 'public')});
const browser = await openBrowser('chrome');
try {
  const composition = await selectComposition({serveUrl, id: 'CapMacIntro', browserInstance: browser});
  const shots = [['01-purpose', 38], ['02-ionic-opening', 115], ['03-ionic-command', 240], ['04-ionic-result', 290], ['05-capacitor-command', 350], ['06-remote-login-wide', 435], ['07-remote-login-on', 460], ['08-password-once', 510], ['09-ssh-key', 565], ['10-openssh-agent', 605], ['11-remote-access-wide', 644], ['12-remote-access-on', 670], ['13-internet-route', 720], ['14-keep-awake', 785], ['15-live-click', 881], ['16-build-pan', 947], ['17-simulator', 1052], ['18-ionic-live-reload', 1158], ['19-app-before', 1222], ['20-app-after', 1238], ['21-app-home', 1292], ['22-json-focus', 1420], ['23-error-focus', 1475], ['24-source-line', 1520], ['25-screenshot', 1625], ['26-agent', 1700], ['27-upload', 1797], ['28-finale', 1980]];
  for (const [name, frame] of shots) {
    await renderStill({serveUrl, composition, frame, output: resolve(output, `${name}.png`), browserInstance: browser, imageFormat: 'png', logLevel: 'error'});
    process.stdout.write(`${name} · frame ${frame}\n`);
  }
} finally {
  await browser.close({silent: true});
}
