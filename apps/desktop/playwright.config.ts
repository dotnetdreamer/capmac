import { defineConfig } from '@playwright/test';

// End-to-end tests drive the built app (npm run build first; test:e2e does it).
export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  workers: 1,
  reporter: [['list']],
  outputDir: '../../test-results/desktop',
});
