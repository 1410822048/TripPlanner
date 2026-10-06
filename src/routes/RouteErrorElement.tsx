// src/routes/RouteErrorElement.tsx
// React Router's data router wraps every route in its own error boundary.
// Without an `errorElement`, a render throw inside an AppLayout tab (bad
// Firestore doc) or a failed lazy-chunk fetch is swallowed by RR's default
// "Unexpected Application Error" screen: English, no recovery action, and
// never reaches the App-level ErrorBoundary (so nothing hits Sentry).
// This element restores the app's own recovery UI + telemetry.
import { useEffect } from 'react'
import { isRouteErrorResponse, useLocation, useNavigate, useRouteError } from 'react-router-dom'
import { captureError } from '@/services/sentry'
import { isChunkLoadError } from '@/utils/chunkLoadError'
import RouteErrorFallback from './RouteErrorFallback'

const CHUNK_RELOAD_KEY = 'tripmate:chunk-reload-at'
const CHUNK_RELOAD_COOLDOWN_MS = 60_000

function toError(raw: unknown): Error {
  if (raw instanceof Error) return raw
  if (isRouteErrorResponse(raw)) return new Error(`${raw.status} ${raw.statusText}`)
  return new Error(String(raw))
}

export default function RouteErrorElement() {
  const raw      = useRouteError()
  const navigate = useNavigate()
  const location = useLocation()
  const error    = toError(raw)

  useEffect(() => {
    // A new deploy removed the hashed chunk this tab still references:
    // one reload picks up the new index + chunk names. Cooldown-guarded so
    // a genuinely offline device doesn't reload in a loop.
    if (isChunkLoadError(raw)) {
      try {
        const last = Number(sessionStorage.getItem(CHUNK_RELOAD_KEY) ?? 0)
        if (Date.now() - last > CHUNK_RELOAD_COOLDOWN_MS) {
          sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now()))
          window.location.reload()
          return
        }
      } catch { /* storage blocked — fall through to the fallback UI */ }
    }
    captureError(raw, { source: 'route-error-element', path: location.pathname })
  }, [raw, location.pathname])

  // Navigating (even to the same URL) clears the data router's error state
  // and re-renders the route — the RR equivalent of ErrorBoundary.reset.
  const reset = () => navigate(`${location.pathname}${location.search}`, { replace: true })

  return <RouteErrorFallback error={error} reset={reset} />
}
