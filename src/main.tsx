// src/main.tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './utils/perf'   // FIRST — captures the app-start mark on module load
import { initSentry } from './services/sentry'
import { initAuth } from './hooks/useAuth'
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

// Warm-up Firebase SDKs in parallel with React's mount → first render.
// Both calls cache module-level promises, so the first useAuth() /
// useMyTrips() inside React await the in-flight result instead of
// starting from cold. Saves ~500ms–1.5s on cold launch (the Auth +
// Firestore chunk downloads now overlap with React's parse + mount).
// Returning these promises from main.tsx is intentional fire-and-forget;
// React still owns the loading state for any UI that depends on them.
markPerf('boot-init-auth')
void initAuth()
markPerf('boot-init-firestore')
void getFirebase()

markPerf('react-mount')
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
