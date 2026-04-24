import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'path'
import { readFileSync } from 'fs'

// Read the version synchronously at config-load time so it lands in the
// bundle as a statically-inlined string (no runtime JSON import, no extra
// network cost on the PWA critical path).
const pkg = JSON.parse(readFileSync('./package.json', 'utf-8')) as { version: string }

export default defineConfig({
  define: {
    // Inline as JSON-stringified literals — these become compile-time
    // constants visible to the app as `__APP_VERSION__` / `__BUILD_DATE__`.
    // Build date is captured at the moment Vite boots; for dev server this
    // is the session start, for production builds it's the build time.
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_DATE__:  JSON.stringify(new Date().toISOString().slice(0, 10)),
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // `prompt` keeps the new SW in "waiting" state until the user clicks
      // "reload" in PwaUpdatePrompt. Prevents silent mid-session reloads
      // that would wipe any in-progress form edits.
      registerType: 'prompt',
      includeAssets: ['favicon.ico', 'apple-touch-icon.png'],
      manifest: {
        name: 'TripMate - 旅遊行程助手',
        short_name: 'TripMate',
        description: '與旅伴共同規劃旅遊行程',
        theme_color: '#6B7C5E',
        background_color: '#FAF7F2',
        display: 'standalone',
        orientation: 'portrait',
        scope: '/',
        start_url: '/',
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        // Intentionally no Firestore runtime cache: Firestore uses WebChannel /
        // long-polling that Workbox can't meaningfully cache at the HTTP layer.
        // Offline support is delegated to the Firestore SDK's own IndexedDB
        // persistence (when enabled), which understands document semantics.
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'google-fonts-cache' },
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
