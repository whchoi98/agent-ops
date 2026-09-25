import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['tests/**/*.test.ts', 'src/**/*.test.{ts,tsx}'],
    exclude: ['tests/e2e/**'],
    testTimeout: 10000,
    pool: 'forks',
  },
});
