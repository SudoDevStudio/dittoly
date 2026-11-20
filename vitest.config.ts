import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/env.ts'],
    // Bun's and Deno's test files in the projects test/toolchains-docker.test.ts runs in containers.
    exclude: ['**/node_modules/**', 'test/fixtures/toolchains/**'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Database-backed test files share one test database.
    fileParallelism: false,
  },
});
