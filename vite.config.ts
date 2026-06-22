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
    // Sentry tree-shake flags. The SDK gates its replay + debug code
    // behind these globals at build time -- substituting `false` here
    // lets Rollup eliminate the unreachable branches. Belt-and-
    // suspenders with services/sentry.ts not even importing the
    // replay/tracing integrations: this flag is a defensive guard in
    // case a future Sentry version adds replay code paths that bypass
    // the integrations array. Tracing is ALSO stripped (no integration
    // imported); the SDK exposes no __SENTRY_TRACING__ build flag, but
    // the destructured dynamic import in sentry.ts excludes its
    // exports from the chunk.
    // See: https://docs.sentry.io/platforms/javascript/configuration/tree-shaking/
    __SENTRY_REPLAY__: 'false',
    __SENTRY_DEBUG__:  'false',
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
    // Conditional modulepreload for Firestore. An inline script runs
    // synchronously during HTML parse, reads the `tripmate.auth.hint`
    // localStorage marker (set by useAuth on sign-in / cleared on
    // sign-out), and only then appends <link rel="modulepreload"> for
    // the firestore chunk. Two layers must agree with main.tsx's
    // `if (readAuthHint())` gate around `void getFirebase()`:
    //
    //   - Hinted (returning signed-in user): preload fires during HTML
    //     parse → chunk downloads in parallel with main.js → first
    //     useMyTrips()'s firestore needs land hot. Matches the original
    //     unconditional-preload speed for the common case.
    //   - Unhinted (first visit / demo / signed-out): nothing is
    //     preloaded AND main.tsx skips `void getFirebase()`, so the
    //     104 KB gz vendor-firebase-firestore chunk doesn't even get
    //     downloaded until the user explicitly signs in. Closes the
    //     "demo browser pays signed-in bandwidth" gap.
    //
    // Why an inline script instead of a static <link>:
    //   - Static <link> fires unconditionally; the browser pays full
    //     bandwidth cost even when main.tsx never imports the chunk
    //     (modulepreload reserves and warms the parse cache).
    //   - <link rel="prefetch"> downgrades to "low-priority idle" which
    //     hurts hinted users' first-paint.
    //   - SSR / per-user HTML would be cleanest but we're a pure SPA.
    //
    // Auth SDK and Sentry are intentionally NOT preloaded here for
    // separate reasons (see the previous version of this comment block
    // — preserved in git history).
    {
      name: 'preload-firebase-chunks',
      transformIndexHtml: {
        order: 'post',
        handler(html, ctx) {
          if (!ctx.bundle) return html
          const targets: string[] = []
          for (const [fileName, chunk] of Object.entries(ctx.bundle)) {
            if (chunk.type !== 'chunk') continue
            if (/vendor-firebase-firestore/.test(fileName)) targets.push(fileName)
          }
          if (targets.length === 0) return html
          // JSON.stringify each path so the inline JS sees properly
          // quoted string literals (and we escape any odd chars Vite
          // might mint into the chunk filename).
          const hrefs = JSON.stringify(targets.map(f => `/${f}`))
          // Inline script — minified by hand because vite's HTML pass
          // doesn't run our terser config over transformIndexHtml output.
          // try/catch guards against private-mode / SSR localStorage throws.
          const script = `<script>(function(){try{if(localStorage.getItem('tripmate.auth.hint')==='1'){var hs=${hrefs};for(var i=0;i<hs.length;i++){var l=document.createElement('link');l.rel='modulepreload';l.href=hs[i];l.crossOrigin='';document.head.appendChild(l);}}}catch(e){}})();</script>`
          return html.replace('</head>', `    ${script}\n  </head>`)
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
        share_target: {
          action: '/bookings',
          method: 'GET',
          params: {
            title: 'title',
            text:  'text',
            url:   'url',
          },
        },
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
        // Firebase Auth redirect helper is served by Cloudflare Pages
        // Functions at /__/auth/*. It must bypass Workbox's SPA navigation
        // fallback; otherwise an existing PWA service worker can respond
        // with index.html, React Router sees /__/auth/handler, and the
        // login return path becomes a client-side 404.
        navigateFallbackDenylist: [/^\/__\/auth\//],
        // Chunks excluded from the SW install-time precache. Each one
        // has a runtimeCaching rule below so signed-in users still get
        // a populated cache after first use; demo / first-visit /
        // signed-out users pay zero bandwidth for the chunks they
        // never actually import.
        //
        // - vendor-sentry-*: dynamically imported via
        //   requestIdleCallback in services/sentry.ts. Precaching would
        //   defeat the idle deferral.
        // - vendor-firebase-firestore-* / vendor-firebase-auth-*:
        //   loaded on demand by getFirebase() / getFirebaseAuth(),
        //   gated in main.tsx by readAuthHint() (firestore) and by
        //   useAuth's lazy init (auth). Without exclusion the SW
        //   install would background-fetch these for EVERY first
        //   visitor including demo users, defeating the conditional
        //   modulepreload + the runtime auth-hint gate. Found in
        //   2026-05-22 review: HTML preload was correctly skipped but
        //   precache silently re-introduced the 150KB+gz download.
        globIgnores: [
          '**/vendor-sentry-*.js',
          '**/vendor-firebase-firestore-*.js',
          '**/vendor-firebase-auth-*.js',
        ],
        // Intentionally no Firestore runtime cache: Firestore uses WebChannel /
        // long-polling that Workbox can't meaningfully cache at the HTTP layer.
        // Offline support is delegated to the Firestore SDK's own IndexedDB
        // persistence (when enabled), which understands document semantics.
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'google-fonts-cache',
              // Bounded growth — Google Fonts CSS evolves rarely; 30
              // entries covers every font family / weight we'd realistically
              // request. maxAgeSeconds gives a 1y ceiling so an unused
              // entry eventually evicts on its own (Workbox runs the
              // expiration sweep on each cache hit).
              expiration: { maxEntries: 30, maxAgeSeconds: 365 * 24 * 60 * 60 },
            },
          },
          {
            // Cache vendor-sentry chunk on first runtime fetch (the
            // dynamic import inside services/sentry.ts). After that
            // subsequent loads come from SW cache without network.
            // CacheFirst is safe because the filename is content-
            // hashed -- a new Sentry version ships under a different
            // chunk URL and the old cache entry becomes garbage.
            urlPattern: /\/assets\/vendor-sentry-.*\.js$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'vendor-sentry-cache',
              // Without expiration, every prior content-hashed chunk
              // accumulates indefinitely after each deploy -- the
              // CacheFirst handler never reaches the old URL again
              // (filename changed), but the entry stays in IndexedDB
              // forever. maxEntries=3 keeps the previous handful (in
              // case the SW rollback path serves an old chunk briefly);
              // 90 days is a generous floor for entries that DO get
              // re-served via revisited URLs.
              expiration: { maxEntries: 3, maxAgeSeconds: 90 * 24 * 60 * 60 },
            },
          },
          {
            // Runtime cache for the Firebase SDK chunks that are
            // excluded from precache (see globIgnores above). First
            // import after install / after deploy fetches from the
            // network; subsequent navigations are SW-served. Pattern
            // intentionally matches both firestore + auth (one cache
            // bucket for Firebase, easier eviction story than per-chunk).
            //
            // maxEntries=4: 2 current chunks × 2 deploys of headroom
            // (in case the SW briefly serves the previous deploy's
            // assets during rollover).
            urlPattern: /\/assets\/vendor-firebase-(firestore|auth)-.*\.js$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'vendor-firebase-cache',
              expiration: { maxEntries: 4, maxAgeSeconds: 90 * 24 * 60 * 60 },
            },
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
  // Force-pre-bundle lucide-react: it ships as a barrel re-exporting ~1900
  // individual icon ESM files, and without pre-bundling Vite's dev server
  // walks every file on cold start (~2-3s slower). Prod is unaffected —
  // Rollup tree-shakes correctly because the package has `sideEffects: false`.
  optimizeDeps: {
    include: ['lucide-react'],
  },
  build: {
    // Vite preloads dynamic-import dependencies by default -- the chunk
    // is still fetched on initial page load via <link modulepreload>,
    // defeating sentry.ts's requestIdleCallback deferral. Filter the
    // vendor-sentry chunk out of every entry's preload list so it
    // actually waits for idle.
    modulePreload: {
      resolveDependencies: (_filename, deps) =>
        deps.filter(d => !/vendor-sentry/.test(d)),
    },
    rollupOptions: {
      // Suppress rolldown's `[PLUGIN_TIMINGS] Warning: significant time
      // in @rolldown/plugin-babel`. React Compiler does its work inside
      // that Babel pass (presets: [reactCompilerPreset(...)]) so the
      // "significant time" is the compiler analysing every React file
      // -- working as designed, not a misconfiguration. The check is
      // useful for catching accidentally-slow custom plugins; for this
      // expected-heavy known one it's just noise on every build.
      checks: { pluginTimings: false },
      output: {
        // Stable names for vendor chunks the modulepreload plugin above
        // can target. Splitting Sentry off keeps it out of the main
        // bundle (~26 KB gz post-replay+tracing strip) AND lets it be
        // excluded from the SW precache so it actually defers to idle.
        // The chunk does NOT download in parallel via modulepreload --
        // the resolveDependencies hook below explicitly filters it out
        // so the dynamic import in services/sentry.ts is the only
        // trigger.
        manualChunks: id => {
          if (id.includes('@firebase/firestore') || id.includes('firebase/firestore'))
            return 'vendor-firebase-firestore'
          if (id.includes('@firebase/auth') || id.includes('firebase/auth'))
            return 'vendor-firebase-auth'
          if (id.includes('@sentry'))
            return 'vendor-sentry'
          return undefined
        },
      },
    },
  },
})
