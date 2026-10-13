import { defineConfig } from 'vitest/config'
import path from 'path'

// Worker code against the real Firestore emulator (`npm run test:emulator`).
// The Worker's unit tests use an in-memory Firestore; this suite checks
// what only real Firestore can answer — transactional queries, projections,
// preconditions, conflicts and the 1 MiB document limit. Node environment:
// the Worker modules under test are plain fetch + Web APIs.
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  test: {
    environment: 'node',
    include: ['workers/ocr/test-emulator/**/*.emulator.ts'],
    // Tests share one emulator database and clear it between tests.
    fileParallelism: false,
    testTimeout: 30_000,
  },
})
