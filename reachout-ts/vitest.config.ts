import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: { '@': resolve(__dirname) },
  },
  test: {
    environment: 'node',
    // Every test file gets its own SQLite file via DB_PATH override in setup.
    setupFiles: ['./tests/setup.ts'],
    pool: 'forks',
    testTimeout: 20000,
  },
});
