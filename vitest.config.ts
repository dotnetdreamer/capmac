import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    {
      // The agent ships the stream helper's Objective-C source as text (esbuild's text loader).
      name: 'objc-source-as-text',
      enforce: 'pre',
      transform(code, id) {
        if (id.endsWith('.m')) return { code: `export default ${JSON.stringify(code)};`, map: null };
      },
    },
  ],
  test: {
    include: ['test/unit/**/*.test.ts', 'apps/desktop/test/**/*.test.ts'],
    testTimeout: 30_000,
    pool: 'forks',
  },
});
