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
    // Each database suite starts a PostgreSQL schema or an embedded PGlite instance.
    maxWorkers: 2,
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          include: [
            'apps/api/src/**/*.test.ts',
            'packages/**/*.test.ts',
            'tests/**/*.test.ts',
          ],
        },
      },
      {
        extends: true,
        test: {
          name: 'web',
          include: ['apps/web/src/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
          setupFiles: ['apps/web/src/test/setup.ts'],
          restoreMocks: true,
          unstubGlobals: true,
        },
      },
    ],
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
