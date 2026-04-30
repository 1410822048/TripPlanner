import { defineConfig } from 'vitest/config'
import path from 'path'

// Separate from vite.config.ts so vitest skips the PWA/Tailwind plugins that
// are only needed for the browser build.
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    // jsdom so component / hook tests can run; node-only suites still work
    // here because they don't touch DOM globals. Keeps a single config
    // instead of splitting projects, which is overkill at this scale.
    environment: 'jsdom',
    // Glob covers .ts (utility tests) AND .tsx (component / hook tests).
    // The previous .ts-only glob silently dropped any future *.test.tsx
    // file, which is the scariest kind of test gap — passes by not running.
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
})
