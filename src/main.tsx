// src/main.tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './utils/perf'   // FIRST — captures the app-start mark on module load
import { initSentry } from './services/sentry'
import { getFirebase } from './services/firebase'
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

// Warm-up Firestore in parallel with React's mount → first render.
// The first useMyTrips() inside React awaits the in-flight result
// instead of starting from cold. Saves ~500ms–1s on cold launch.
//
// Auth is NOT warmed here — it's loaded on demand by the first
// `useAuth()` call (which happens during SchedulePage's render via
// useTripContext). The Auth SDK is ~45 KB gz; deferring keeps it off
// the bandwidth-competition path during initial render and skips it
// entirely for visitors who never tap sign-in. The auth hint
// (localStorage `tripmate.auth.hint`) gives SchedulePage a correct
// synchronous "demo vs signed-in" answer while the chunk loads.
markPerf('boot-init-firestore')
void getFirebase()

markPerf('react-mount')
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
