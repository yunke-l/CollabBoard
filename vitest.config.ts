import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@collabboard/contracts': new URL(
        './packages/contracts/src/index.ts',
        import.meta.url,
      ).pathname,
    },
  },
  test: {
    include: ['packages/**/*.test.ts', 'tests/**/*.test.ts'],
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
