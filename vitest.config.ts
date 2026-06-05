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
    // RTL DOM cleanup after each test (see vitest.setup.ts). Required because
    // we don't set `globals: true`, so RTL's auto-cleanup wouldn't register —
    // without it render() output accumulates across tests in document.body.
    setupFiles: ['./vitest.setup.ts'],
    // Glob covers .ts (utility tests) AND .tsx (component / hook tests).
    // The previous .ts-only glob silently dropped any future *.test.tsx
    // file, which is the scariest kind of test gap — passes by not running.
    //
    // `packages/**` picks up workspace packages (e.g. @tripmate/settlement-
    // core) so their internal tests run as part of the root suite. The
    // Worker still has its own vitest config (workers/ocr/vitest.config.mts)
    // because it needs the Cloudflare Workers pool; the client + packages
    // share this one node/jsdom config.
    include: [
      'src/**/*.{test,spec}.{ts,tsx}',
      'packages/**/src/**/*.{test,spec}.{ts,tsx}',
    ],
  },
})
