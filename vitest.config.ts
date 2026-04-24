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
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
  },
})
