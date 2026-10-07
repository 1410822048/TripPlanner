import { defineConfig } from 'vitest/config'
import path from 'path'

// Separate from vite.config.ts so vitest skips the PWA/Tailwind plugins that
// are only needed for the browser build.
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
      // vite-plugin-pwa is intentionally absent from this lean test config,
      // so resolve its virtual React module to a typed test double. Individual
      // suites can vi.mock the same id; production still uses the real plugin.
      'virtual:pwa-register/react': path.resolve(
        import.meta.dirname,
        './src/test/virtualPwaRegister.ts',
      ),
    },
  },
  test: {
    // RTL DOM cleanup + an in-memory localStorage after each test (see
    // vitest.setup.ts; it skips the DOM part when there is no document).
    // Required because we don't set `globals: true`.
    setupFiles: ['./vitest.setup.ts'],
    // Two projects, one config. jsdom costs ~0.3s of environment setup per
    // file, and most plain .ts suites (pure functions, services with mocked
    // SDKs, packages, invariants) never touch the DOM, so they run in node.
    // A .ts suite that does need the DOM (renderHook, window, Blob URLs…)
    // opts in with a `// @vitest-environment jsdom` first line. Component
    // suites (.tsx) always get jsdom.
    //
    // `packages/**` picks up workspace packages (e.g. @tripmate/settlement-
    // core). The Worker keeps its own vitest config (workers/ocr/
    // vitest.config.mts) because it needs the Cloudflare Workers pool.
    // tests/invariants are cross-surface repo checks (client + Worker); they
    // run here because the Worker suite's workerd isolate has no filesystem.
    projects: [
      {
        extends: true,
        test: {
          name:        'dom',
          environment: 'jsdom',
          include:     ['src/**/*.{test,spec}.tsx'],
        },
      },
      {
        extends: true,
        test: {
          name:        'unit',
          environment: 'node',
          include: [
            'src/**/*.{test,spec}.ts',
            'packages/**/src/**/*.{test,spec}.{ts,tsx}',
            'tests/invariants/**/*.{test,spec}.ts',
          ],
        },
      },
    ],
  },
})
