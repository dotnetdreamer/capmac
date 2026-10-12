// Drives the running `npm run desktop:dev` app over its debugging port (39217, or CDP_PORT).
//   node apps/desktop/scripts/tools/drive.mjs "click:nav >> text=Devices" "wait:800" "eval:document.title" "shot:out.png"
// Steps: click:<selector> hover:<selector> fill:<selector>=><text> type:<text> press:<key>
//        wait:<ms> waitfor:<selector> eval:<js expression> text:<selector> shot:<file> (page-only screenshot;
//        for what the window really looks like, Mica included, use capture.ps1).
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../../../package.json', import.meta.url));
const { chromium } = require('@playwright/test');

const port = process.env.CDP_PORT ?? '39217';
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const page = browser.contexts().flatMap((c) => c.pages()).find((p) => /127\.0\.0\.1|app:\/\/capmac/.test(p.url()));
if (!page) {
  console.error('No CapMac Studio page on that port. Is npm run desktop:dev running?');
  process.exit(1);
}
// Playwright emulates a light colour scheme when it attaches; keep the app's real theme.
await page.emulateMedia({ colorScheme: null }).catch(() => undefined);
const errors = [];
page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && errors.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));

for (const step of process.argv.slice(2)) {
  const i = step.indexOf(':');
  const verb = step.slice(0, i);
  const arg = step.slice(i + 1);
  try {
    switch (verb) {
      case 'click':
        await page.click(arg, { timeout: 8000 });
        break;
      case 'hover':
        await page.hover(arg, { timeout: 8000 });
        break;
      case 'fill': {
        const [selector, ...rest] = arg.split('=>');
        await page.fill(selector, rest.join('=>'), { timeout: 8000 });
        break;
      }
      case 'type':
        await page.keyboard.type(arg, { delay: 15 });
        break;
      case 'press':
        await page.keyboard.press(arg);
        break;
      case 'wait':
        await page.waitForTimeout(Number(arg));
        break;
      case 'waitfor':
        await page.waitForSelector(arg, { timeout: 120_000 });
        break;
      case 'eval': {
        const value = await page.evaluate(arg);
        console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
        break;
      }
      case 'text':
        console.log((await page.innerText(arg || 'body')).slice(0, 4000));
        break;
      case 'shot':
        await page.screenshot({ path: arg });
        console.log(`saved ${arg}`);
        break;
      default:
        console.error(`unknown step "${verb}"`);
    }
  } catch (err) {
    console.error(`step "${step}" failed: ${err.message.split('\n')[0]}`);
  }
}
if (errors.length) console.log(`--- console errors and warnings:\n${errors.join('\n')}`);
await browser.close().catch(() => undefined);
