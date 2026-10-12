import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts', 'apps/desktop/test/**/*.test.ts'],
    testTimeout: 30_000,
    pool: 'forks',
  },
});
