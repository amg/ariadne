import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@config': path.resolve(rootDir, 'src/config'),
      '@db': path.resolve(rootDir, 'src/db'),
      '@queries': path.resolve(rootDir, 'src/db/queries'),
      '@queue': path.resolve(rootDir, 'queue'),
      '@services': path.resolve(rootDir, 'src/services'),
      '@routes': path.resolve(rootDir, 'app/routes'),
      '@test': path.resolve(rootDir, 'test'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'queue/**/*.test.ts', 'app/**/*.test.ts'],
    globalSetup: ['./test/global-setup.ts'],
    setupFiles: ['./test/worker-db-setup.ts'],
    // Each worker runs against its own database clone, so files run in
    // parallel without sharing rows or truncates. Bounded by the Postgres
    // connection budget, which the dev database shares.
    maxWorkers: 4,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
