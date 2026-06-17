import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
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
