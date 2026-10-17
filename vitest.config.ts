import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    {
      // The agent ships the stream helper's Objective-C source as text (esbuild's text loader), the WSL
      // backend its Ruby, shell, Python and C helpers.
      name: 'objc-source-as-text',
      enforce: 'pre',
      transform(code, id) {
        if (/\.(m|rb|sh|py|c)$/.test(id)) return { code: `export default ${JSON.stringify(code)};`, map: null };
      },
    },
  ],
  test: {
    include: ['test/unit/**/*.test.ts', 'apps/desktop/test/**/*.test.ts', 'apps/vscode/test/unit/**/*.test.ts'],
    testTimeout: 30_000,
    pool: 'forks',
  },
});
