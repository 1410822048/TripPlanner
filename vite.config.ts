import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { visualizer } from 'rollup-plugin-visualizer'
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
    // Bundle visualiser. Off by default; opt-in via `ANALYZE=1 npm run build`
    // so the normal build stays fast and doesn't open browser tabs.
    ...(process.env.ANALYZE
      ? [visualizer({
          filename: 'dist/stats.html',
          open:     true,
          gzipSize: true,
          brotliSize: true,
        })]
      : []),
    VitePWA({
      // `prompt` keeps the new SW in "waiting" state until the user clicks
      // "reload" in PwaUpdatePrompt. Prevents silent mid-session reloads
      // that would wipe any in-progress form edits.
      registerType: 'prompt',
      // Bundle these into the precache so the install prompt can fetch
      // them, and so the SW serves them offline (favicon shows in the
      // tab even with no network).
      includeAssets: [
        'favicon.svg',
        'favicon-16x16.png',
        'favicon-32x32.png',
        'apple-touch-icon.png',
      ],
      manifest: {
        name: 'TripMate - 旅遊行程助手',
        short_name: 'TripMate',
        description: '與旅伴共同規劃旅遊行程',
        theme_color: '#6B7C5E',
        background_color: '#FAF7F2',
        display: 'standalone',
        orientation: 'portrait',
        scope: '/',
        // Always boot a fresh launch into /schedule. Resume-from-background
        // can't be controlled from the manifest (the OS picks whatever URL
        // was last visible), so the App-entry redirect in App.tsx handles
        // that path; this manifest line is the cold-start half.
        start_url: '/schedule',
        // Three entries instead of overloading one with `purpose: 'any
        // maskable'`. Splitting them lets each variant be art-directed:
        //   - any:      full-bleed icon (Windows / macOS / Chromebook)
        //   - maskable: padded variant on the cream background_color so
        //               Android adaptive-icon shapes (circle / squircle /
        //               teardrop) don't crop into the styled card.
        icons: [
          { src: 'pwa-192x192.png',          sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'pwa-512x512.png',          sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'pwa-maskable-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
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
