// src/services/sentry.ts
// Sentry init wrapper. Kept thin so consumers (main.tsx + service callers)
// don't import @sentry/react directly — that gives us a single chokepoint
// to swap providers, mute in dev, or no-op when DSN isn't configured.
//
// DSN config: read from VITE_SENTRY_DSN at build time. Missing DSN means
// "telemetry disabled" — useful for dev / preview branches that shouldn't
// pollute the production project. Production builds without a DSN log a
// warning to console so a misconfigured deploy is noisy rather than silent.
//
// Free tier (Developer plan): 5K errors/mo + 10K performance traces — the
// `tracesSampleRate` and `replaysSessionSampleRate` defaults below stay
// well within that for a < 50-user app.
import * as Sentry from '@sentry/react'

const DSN = import.meta.env.VITE_SENTRY_DSN as string | undefined

let initialized = false

export function initSentry(): void {
  if (initialized) return
  initialized = true

  if (!DSN) {
    if (import.meta.env.PROD) {
      console.warn('[sentry] VITE_SENTRY_DSN not set — production telemetry is disabled.')
    }
    return
  }

  Sentry.init({
    dsn: DSN,
    environment: import.meta.env.MODE,                    // 'development' | 'production'
    release:     import.meta.env.PROD ? __APP_VERSION__ : undefined,
    // Trace 10% of sessions in prod; sample-all in dev so console matches
    // what gets sent. Replays at 1% of normal sessions, 100% on error so
    // we always have context for bugs. The 1% × 100%-on-error mix already
    // costs little — replay code only activates when sampled, and most
    // of its bytes are gz-compressed in the SDK chunk that Vite already
    // splits separately. Lazy-loading was tried and rolled back as
    // over-engineering: it added a window.requestIdleCallback dance and
    // an extra failure path for ~0 KB of measurable savings.
    tracesSampleRate:         import.meta.env.PROD ? 0.1 : 1.0,
    replaysSessionSampleRate: 0.01,
    replaysOnErrorSampleRate: 1.0,
    integrations: [
      Sentry.browserTracingIntegration(),
      Sentry.replayIntegration({ maskAllText: true, blockAllMedia: true }),
    ],
    // Filter noise: ignore aborted fetches that happen on route change and
    // ResizeObserver loops which are user-environment quirks not bugs.
    ignoreErrors: [
      'AbortError',
      'ResizeObserver loop limit exceeded',
      'ResizeObserver loop completed with undelivered notifications',
    ],
  })
}

/**
 * Capture a known error with optional context. Use this instead of bare
 * console.error in service / hook code — it reaches Sentry in prod and
 * still appears in dev console (Sentry mirrors there).
 */
export function captureError(err: unknown, context?: Record<string, unknown>): void {
  if (DSN) {
    Sentry.captureException(err, context ? { extra: context } : undefined)
  } else {
    console.error('[sentry/disabled]', err, context ?? '')
  }
}

export { Sentry }
