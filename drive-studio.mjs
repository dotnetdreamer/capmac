// Drives the open CapMac Studio over CDP so the user can watch. Usage: node drive.mjs <command> [arg]
import { chromium } from 'playwright-core';

const [cmd, arg] = process.argv.slice(2);
const browser = await chromium.connectOverCDP('http://127.0.0.1:39217');
const context = browser.contexts()[0];
const page = context.pages().find((p) => !p.url().startsWith('devtools://')) ?? context.pages()[0];
await page.emulateMedia({ colorScheme: null });

const text = async () => (await page.evaluate(() => document.body.innerText)).split('\n').map((l) => l.trim()).filter(Boolean);

if (cmd === 'state') {
  console.log('URL', page.url());
  console.log((await text()).slice(0, 60).join('\n'));
} else if (cmd === 'buttons') {
  const btns = await page.evaluate(() => [...document.querySelectorAll('button, [role=button]')].map((b) => (b.getAttribute('aria-label') || b.innerText || '').trim()).filter(Boolean));
  console.log(btns.join('\n'));
} else if (cmd === 'click') {
  const btn = page.getByRole('button', { name: new RegExp(arg, 'i') }).first();
  await btn.scrollIntoViewIfNeeded();
  await btn.click({ timeout: 5000 });
  console.log('clicked', arg);
  await page.waitForTimeout(800);
  console.log((await text()).slice(0, 40).join('\n'));
} else if (cmd === 'clicktext') {
  await page.getByText(new RegExp(arg, 'i')).first().click({ timeout: 5000 });
  console.log('clicked text', arg);
  await page.waitForTimeout(800);
} else if (cmd === 'shot') {
  await page.screenshot({ path: arg || 'shot.png' });
  console.log('shot', arg);
}
await browser.close();
