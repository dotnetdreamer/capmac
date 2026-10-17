import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

const desktopDir = fileURLToPath(new URL('..', import.meta.url));
const sampleDir = path.resolve(desktopDir, '..', '..', 'examples', 'hello-capacitor');

let app: ElectronApplication;
let page: Page;
let temp: string;

/** A paired Mac that is never there: Run and its menu are enabled, and connecting fails fast. */
function pairOfflineMac(configDir: string): void {
  mkdirSync(configDir, { recursive: true });
  const host = { name: 'offline-mac', host: '127.0.0.1', port: 9, username: 'test', hostKey: 'SHA256:test', macName: 'Offline Mac', pairedAt: '2026-10-16T00:00:00.000Z' };
  writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ version: 1, defaultHost: 'offline-mac', hosts: { 'offline-mac': host } }));
}

test.beforeEach(async () => {
  temp = mkdtempSync(path.join(os.tmpdir(), 'capmac-studio-e2e-'));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  delete env.CAPMAC_STUDIO_DEV;
  env.CAPMAC_STUDIO_USER_DATA = path.join(temp, 'profile');
  env.CAPMAC_CONFIG_DIR = path.join(temp, 'capmac');
  pairOfflineMac(env.CAPMAC_CONFIG_DIR);
  app = await electron.launch({ args: ['.'], cwd: desktopDir, env });
  page = await app.firstWindow();
  // Copies land here, not on this PC's clipboard.
  await page.evaluate(() => {
    (window as unknown as { copied: string[] }).copied = [];
    navigator.clipboard.writeText = async (text: string) => void (window as unknown as { copied: string[] }).copied.push(text);
  });
  await openSample();
});

test.afterEach(async () => {
  await app?.close();
  rmSync(temp, { recursive: true, force: true });
});

async function openSample(): Promise<void> {
  const skip = page.getByRole('button', { name: 'Skip for now' });
  if (await skip.isVisible({ timeout: 5000 }).catch(() => false)) await skip.click();
  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [dir] });
  }, sampleDir);
  await page.keyboard.press('Control+O');
  const chooser = page.getByRole('dialog', { name: 'Hello CapMac has two apps' });
  await chooser.getByRole('button', { name: 'Open iOS app' }).click();
  await expect(page.getByRole('heading', { name: 'Hello CapMac', level: 1 })).toBeVisible();
}

/** Lines from the app, as the engine sends them (console.log output). */
async function pushLines(from: number, n: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, { projectPath, from, n }) => {
    const batch = [];
    for (let i = from; i < from + n; i++) {
      batch.push({ scope: { projectPath }, event: { type: 'app-log', entry: { kind: 'console', level: i % 100 === 99 ? 'error' : 'log', text: `line ${i} lorem ipsum dolor sit amet`, stream: 'stdout', ts: Date.now() } } });
    }
    BrowserWindow.getAllWindows()[0]!.webContents.send('engine:events', batch);
  }, { projectPath: sampleDir, from, n });
}

/** What Ctrl+C would put on the clipboard (the copy event, without touching the real one). */
function copied(): Promise<string> {
  return page.evaluate(() => {
    const data = new DataTransfer();
    document.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }));
    return data.getData('text/plain');
  });
}

const output = () => page.getByRole('log', { name: 'Console output' });
const jump = () => page.getByRole('button', { name: /Go to the latest line/ });

test('a long console: only nearby rows in the page, back to the latest line, select all and copy', async () => {
  await pushLines(0, 50_000);
  await expect(output().getByText('line 49999 lorem')).toBeVisible();
  // 50k lines, a few dozen rows in the page.
  expect(await output().locator('.cl-row').count()).toBeLessThan(250);
  await expect(jump()).toBeHidden();

  // Scrolled up: the arrow shows, and counts lines that come in meanwhile.
  await output().hover();
  await page.mouse.wheel(0, -3000);
  await expect(jump()).toBeVisible();
  await pushLines(50_000, 12);
  await expect(jump()).toHaveAccessibleName(/12 new lines/);
  await expect(output().getByText('line 50011 lorem')).toBeHidden();
  await jump().click();
  await expect(output().getByText('line 50011 lorem')).toBeVisible();
  await expect(jump()).toBeHidden();

  // At the latest line, new lines keep showing.
  await pushLines(50_012, 3);
  await expect(output().getByText('line 50014 lorem')).toBeVisible();

  // Ctrl+A selects every line, not the page; copying gives them all.
  await output().getByText('line 50014 lorem').click();
  await page.keyboard.press('Control+A');
  const all = (await copied()).split('\n');
  expect(all).toHaveLength(50_015);
  expect(all[0]).toMatch(/^\d\d:\d\d:\d\d\.\d{3} JS {2}line 0 lorem/);
  expect(all[99]).toMatch(/ JS {2}ERROR line 99 lorem/);
  expect(all.at(-1)).toMatch(/line 50014 lorem/);
  // The selection survives scrolling to the top (the first rows come back selected).
  await page.keyboard.press('Home');
  await expect(output().getByText('line 0 lorem', { exact: false }).first()).toBeVisible();
  expect((await copied()).split('\n')).toHaveLength(50_015);
});

test('clicking into the console holds it still; Clear follows new lines again', async () => {
  await pushLines(0, 200);
  await expect(output().getByText('line 199 lorem')).toBeVisible();
  // A click (to select, say) holds the view: new lines wait below, counted.
  await output().getByText('line 199 lorem').click();
  await pushLines(200, 1);
  await expect(jump()).toHaveAccessibleName(/^1 new line\b/);
  await jump().click();
  await expect(output().getByText('line 200 lorem')).toBeVisible();
  await expect(jump()).toBeHidden();
  // Scrolled up, then cleared: the next lines show at the bottom again.
  await output().hover();
  await page.mouse.wheel(0, -2000);
  await expect(jump()).toBeVisible();
  await page.keyboard.press('Control+L');
  await pushLines(300, 60);
  await expect(output().getByText('line 359 lorem')).toBeVisible();
  await expect(jump()).toBeHidden();
});

test('select across rows by dragging past the edge, right-click to copy', async () => {
  await pushLines(0, 5000);
  await expect(output().getByText('line 4999 lorem')).toBeVisible();
  const box = (await output().boundingBox())!;
  const first = output().getByText('line 4980 lorem');
  const start = (await first.boundingBox())!;
  // Drag from "line 4980" up past the console's top edge: it scrolls, selecting as it goes.
  await page.mouse.move(start.x + 40, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + 40, box.y - 80, { steps: 5 });
  await page.waitForTimeout(2500);
  await page.mouse.move(start.x + 60, box.y - 80);
  await page.mouse.up();
  const rendered = await output().locator('.cl-row').count();
  const text = await copied();
  const lines = text.split('\n');
  // More lines than were ever in the page at once, all in order, ending in the middle of line 4980.
  expect(lines.length).toBeGreaterThan(rendered);
  const numbers = lines.slice(1, -1).map((l) => Number(/line (\d+) /.exec(l)?.[1]));
  expect(numbers.every((n, i) => i === 0 || n === numbers[i - 1]! + 1)).toBe(true);
  expect(numbers.at(-1)).toBe(4979);
  expect(lines.at(-1)).not.toContain('lorem ipsum dolor sit amet');

  // The right-click menu copies the same.
  await output().getByText(/line \d+ lorem/).nth(3).click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Console actions' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /Select all/ })).toBeEnabled();
  await menu.getByRole('menuitem', { name: /^Copy line/ }).click();
  const copiedLines = await page.evaluate(() => (window as unknown as { copied: string[] }).copied);
  expect(copiedLines.at(-1)).toMatch(/^\d\d:\d\d:\d\d\.\d{3} JS {2}line \d+ lorem ipsum dolor sit amet$/);

  // Select all from the menu, then Copy.
  await output().getByText(/line \d+ lorem/).first().click({ button: 'right' });
  await menu.getByRole('menuitem', { name: /Select all/ }).click();
  await output().getByText(/line \d+ lorem/).first().click({ button: 'right' });
  await menu.getByRole('menuitem', { name: /^Copy\b/ }).first().click();
  const afterCopy = await page.evaluate(() => (window as unknown as { copied: string[] }).copied);
  expect(afterCopy.at(-1)!.split('\n')).toHaveLength(5000);
});

test('search jumps between matches in a long console', async () => {
  await pushLines(0, 30_000);
  await expect(output().getByText('line 29999 lorem')).toBeVisible();
  const search = page.getByRole('searchbox', { name: 'Find in console' });
  await search.fill('line 1234');
  // line 1234, 12340-12349 → 11 matches.
  await expect(page.getByText('1 of 11', { exact: true })).toBeVisible();
  await search.press('Enter');
  await expect(page.getByText('2 of 11', { exact: true })).toBeVisible();
  await expect(output().locator('.cl-row.is-current')).toContainText('line 12340 lorem');
  await search.press('Shift+Enter');
  await search.press('Shift+Enter');
  await expect(page.getByText('11 of 11', { exact: true })).toBeVisible();
  await expect(output().locator('.cl-row.is-current')).toContainText('line 12349 lorem');
  // Typing more narrows it.
  await search.fill('line 12345');
  await expect(page.getByText('1 of 1', { exact: true })).toBeVisible();
});

test('Run has an arrow: run without building, or sync only', async () => {
  const more = page.getByRole('button', { name: 'More ways to run' });
  await expect(more).toBeEnabled();
  await more.click();
  const menu = page.getByRole('menu', { name: 'More ways to run' });
  await expect(menu.getByRole('menuitem', { name: /^Run Builds your web app first/ })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /^Run without building/ })).toBeVisible();
  await menu.getByRole('menuitem', { name: /^Sync/ }).click();
  // The Mac is offline: the sync starts, then fails, and Try again would sync again.
  await expect(output().getByText('Sync started')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();

  await more.click();
  await menu.getByRole('menuitem', { name: /^Run without building/ }).click();
  await expect(output().getByText('Run started, without building the web app')).toBeVisible();
});
