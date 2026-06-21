import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    // Forked-e2e (T10) spawns `anvil` in beforeAll (cold-CI: up to 15 s) and
    // deploys + waits on chain receipts inside the suite (the paused-branch
    // case in particular waits ~5 s for the factory-state cache TTL to expire).
    testTimeout: 60_000,
    hookTimeout: 30_000,
    // Each test file gets a fresh module registry. Forked-e2e (T10) mutates
    // the NETWORKS module export in place to register an "anvil-forked" row;
    // explicit isolate: true guarantees that mutation cannot bleed into any
    // other test file in the same worker (T10-R1-F3).
    isolate: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/__tests__/**', 'src/types.ts', 'src/index.ts', '**/*.d.ts'],
      reporter: ['text', 'json', 'html'],
      thresholds: {
        lines: 85,
        statements: 85,
        functions: 85,
        branches: 85,
      },
    },
  },
});
