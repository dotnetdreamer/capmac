import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';

const desktopDir = fileURLToPath(new URL('..', import.meta.url));
const sampleDir = path.resolve(desktopDir, '..', '..', 'examples', 'hello-capacitor');

let app: ElectronApplication;
let temp: string;

test.beforeEach(async () => {
  // A fresh profile and no paired Macs: what a first launch looks like.
  temp = mkdtempSync(path.join(os.tmpdir(), 'capmac-studio-e2e-'));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  // Set when the tests run inside another Electron app (VS Code): Electron would start as plain Node.
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  delete env.CAPMAC_STUDIO_DEV;
  env.CAPMAC_STUDIO_USER_DATA = path.join(temp, 'profile');
  env.CAPMAC_CONFIG_DIR = path.join(temp, 'capmac');
  app = await electron.launch({ args: ['.'], cwd: desktopDir, env });
});

test.afterEach(async () => {
  await app?.close();
  rmSync(temp, { recursive: true, force: true });
});

test('launches, shows Home and opens a project', async () => {
  const page = await app.firstWindow();
  await expect(page).toHaveTitle('CapMac Studio');

  // First launch: onboarding, which can be skipped until a Mac is around.
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Skip for now' }).click();

  // Home, empty.
  await expect(page.getByRole('heading', { name: 'Projects', level: 1 })).toBeVisible();
  await expect(page.getByText('Add your Capacitor or Electron app')).toBeVisible();

  // Add the sample through the (stubbed) folder picker.
  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [dir] });
  }, sampleDir);
  await page.getByRole('button', { name: 'Choose a folder…' }).click();

  // The sample has two apps, its iOS app and its Electron app: CapMac asks which one, the iOS app first.
  const chooser = page.getByRole('dialog', { name: 'Hello CapMac has two apps' });
  await expect(chooser).toBeVisible();
  await expect(chooser.getByRole('radio', { name: 'iOS app' })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('ArrowDown');
  await expect(chooser.getByRole('radio', { name: 'Electron app' })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('ArrowUp');
  await chooser.getByRole('button', { name: 'Open iOS app' }).click();

  // The project workspace, with the app picker to switch apps later.
  await expect(page.getByRole('heading', { name: 'Hello CapMac', level: 1 })).toBeVisible();
  await expect(page.getByText('dev.capmac.hello')).toBeVisible();
  await expect(page.getByRole('button', { name: /^App: iOS app/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Run/ })).toBeVisible();

  // Back home, the project is listed.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Home' }).click();
  await expect(page.getByRole('article', { name: 'Hello CapMac' })).toBeVisible();
});

test('the command palette opens with Ctrl+K and finds Settings', async () => {
  const page = await app.firstWindow();
  await page.getByRole('button', { name: 'Skip for now' }).click();
  await expect(page.getByRole('heading', { name: 'Projects', level: 1 })).toBeVisible();

  await page.keyboard.press('Control+K');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  await page.keyboard.type('settings');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
});
