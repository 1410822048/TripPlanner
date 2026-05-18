import { defineConfig } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { visualizer } from 'rollup-plugin-visualizer'
import path from 'path'
import { execSync } from 'node:child_process'

// Inline build-identifying constants at config-load time so they land in
// the bundle as statically-inlined strings (no runtime JSON import, no
// extra network cost on the PWA critical path).
//
// `__APP_VERSION__` is the short git hash of HEAD — uniquely identifies
// every commit, much more useful than `package.json.version` (which never
// changed: it was stuck at 0.0.0 forever). Used as Sentry release tag so
// each error gets bucketed to a specific commit and as the user-visible
// version on AccountPage's footer.
//
// `__BUILD_DATE__` is timestamp with minute resolution so multiple builds
// on the same day are distinguishable.
function getGitHash(): string {
  try {
    const hash  = execSync('git rev-parse --short HEAD').toString().trim()
    // Append `-dirty` if working tree has uncommitted changes so we don't
    // claim a clean commit hash for an in-progress build.
    const dirty = execSync('git status --porcelain').toString().trim().length > 0
    return dirty ? `${hash}-dirty` : hash
  } catch {
    return 'dev'
  }
}
const gitHash   = getGitHash()
const buildDate = new Date().toISOString().slice(0, 16).replace('T', ' ')

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(gitHash),
    __BUILD_DATE__:  JSON.stringify(buildDate),
  },
  plugins: [
    react(),
    // React Compiler integration. @vitejs/plugin-react v6 dropped its
    // inline `babel` option (Babel is no longer a dependency of the
    // plugin itself — JSX runs through Oxc in Rust). The supported
    // path is a separate `@rolldown/plugin-babel` pass that consumes
    // `reactCompilerPreset()` — the preset returns both a babel preset
    // and a rolldown filter/applyToEnvironmentHook/optimizeDeps block,
    // so the compiler only touches client-side React modules and the
    // optimizeDeps bundling picks up `react/compiler-runtime` for free.
    babel({ presets: [reactCompilerPreset({ target: '19' })] }),
    tailwindcss(),
    // Inject <link rel="modulepreload"> for the Firebase SDK chunks
    // into index.html at build time. Without this, the browser only
    // discovers these chunks after main.js parses and executes
    // initAuth() — adding ~1.5s of serial wait on first cold launch.
    // With modulepreload the chunks download in parallel with main.js
    // so by the time React calls initAuth() the bundle is hot.
    {
      name: 'preload-firebase-chunks',
      transformIndexHtml: {
        order: 'post',
        handler(html, ctx) {
          if (!ctx.bundle) return html
          const targets: string[] = []
          for (const [fileName, chunk] of Object.entries(ctx.bundle)) {
            if (chunk.type !== 'chunk') continue
            if (/vendor-firebase-(auth|firestore)/.test(fileName)) targets.push(fileName)
          }
          if (targets.length === 0) return html
          const tags = targets
            .map(f => `    <link rel="modulepreload" href="/${f}" crossorigin>`)
            .join('\n')
          return html.replace('</head>', `${tags}\n  </head>`)
        },
      },
    },
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
  build: {
    rollupOptions: {
      output: {
        // Stable names for Firebase SDK chunks so the modulepreload
        // plugin below can target them by glob. (No dedupe benefit —
        // Vite was already deduping correctly.)
        manualChunks: id => {
          if (id.includes('@firebase/firestore') || id.includes('firebase/firestore'))
            return 'vendor-firebase-firestore'
          if (id.includes('@firebase/auth') || id.includes('firebase/auth'))
            return 'vendor-firebase-auth'
          return undefined
        },
      },
    },
  },
})
