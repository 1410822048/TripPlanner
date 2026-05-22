// src/main.tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './utils/perf'   // FIRST — captures the app-start mark on module load
import { initSentry } from './services/sentry'
import { getFirebase } from './services/firebase'
import { readAuthHint } from './hooks/useAuth'
import { markPerf } from './utils/perf'
import './index.css'
import App from './App.tsx'

// One-line boot banner so console logs are immediately attributable
// to a specific build — pairs with the AccountPage footer display and
// Sentry's release tag. `%c` styles keep it visually distinct from
// app logs in DevTools.
console.log(
  `%cTripMate %c${__APP_VERSION__} %c· ${__BUILD_DATE__}`,
  'font-weight:bold;color:#3D8B7A',
  'font-weight:bold;color:#666',
  'color:#999',
)

// Boot Sentry before React mounts so an early render-time crash gets
// captured (init after mount → first error in App init slips through
// uncaught). No-op when VITE_SENTRY_DSN isn't set.
initSentry()

// Warm-up Firestore in parallel with React's mount → first render —
// but ONLY when the auth hint says the user is likely signed in.
// Demo / first-visit / signed-out users skip the 104 KB gz
// vendor-firebase-firestore chunk entirely: SchedulePage's demo
// mode runs on in-memory mock data, and the chunk loads on-demand
// from the first useAuth() / useMyTrips() call IF the user later
// signs in.
//
// The vite.config preload-firebase-chunks plugin gates the matching
// <link rel="modulepreload"> on the same hint via an inline script,
// so unhinted visitors pay neither the modulepreload bandwidth nor
// the parse cost. Two layers must agree — without the runtime gate
// here, the preloaded chunk would still get executed on import;
// without the HTML gate, hinted users would lose the parallel
// download window.
//
// Auth is NOT warmed here either — it's loaded on demand by the first
// `useAuth()` call. The Auth SDK is ~45 KB gz; deferring keeps it off
// the bandwidth-competition path during initial render and skips it
// entirely for visitors who never tap sign-in.
if (readAuthHint()) {
  markPerf('boot-init-firestore')
  void getFirebase()
}

markPerf('react-mount')
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
