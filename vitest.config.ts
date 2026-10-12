import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
    testTimeout: 30_000,
    pool: 'forks',
  },
});
