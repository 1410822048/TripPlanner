import { defineConfig } from 'vitest/config'
import path from 'path'

// Separate config because rules tests:
//   1. Need the Firebase emulator running on a known port (regular unit
//      tests don't), so they're started via `npm run test:rules` not
//      `npm test`. CI runs unit tests without spinning up an emulator.
//   2. Are slower (each test waits for emulator round-trips), so the
//      tight feedback loop of unit tests would suffer if mixed in.
//   3. Use 'node' environment — they speak the Firebase SDK directly,
//      no DOM needed.
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/rules/**/*.test.ts'],
    // Sequential because tests share emulator state via clearFirestore /
    // clearStorage — running in parallel would race on the cleanup.
    fileParallelism: false,
    testTimeout: 10_000,
  },
})
