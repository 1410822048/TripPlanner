// src/services/sentry.ts
// Deferred-init Sentry wrapper. After stripping replay + tracing the
// @sentry/browser vendor chunk lands at ~26 KB gz, but it's still on
// the critical path if loaded eagerly -- so we defer it to idle. The
// shape is three phases:
//
//   1. Boot-time sync: register tiny window.onerror / unhandledrejection
//      handlers that BUFFER errors into a module-level array. No SDK
//      bytes loaded yet, so a module-load failure during initial render
//      is still observable.
//
//   2. Idle: dynamic-import @sentry/browser in requestIdleCallback (or
//      a setTimeout fallback for Safari < 16.4). Run init, drain the
//      buffer through captureException, then uninstall our bootstrap
//      handlers (Sentry installs its own that capture stack traces +
//      breadcrumbs richer than our buffer can).
//
//   3. Steady-state: captureError() routes directly through the cached
//      Sentry module ref; new errors no longer buffer.
//
// An earlier deferral attempt was rolled back because the @sentry chunk
// stayed on the critical path via modulepreload + the dynamic import
// resolved synchronously. This round: vite.config.ts excludes the
// chunk from modulepreload AND from the PWA precache AND from the
// initial entry graph via destructured `await import('@sentry/browser')`,
// so the chunk only loads when the idle callback fires.

// Narrow surface we actually call. Typed import (no runtime side
// effect) so we can hold a ref without pulling the chunk. Switched
// from @sentry/react to @sentry/browser because we don't use the
// React-specific exports (ErrorBoundary, Profiler) and the react
// wrapper just re-exports the browser package plus those components.
type SentryBrowser = typeof import('@sentry/browser')
/** Runtime ref holds only the named exports we use, NOT the whole
 *  namespace. Destructured dynamic import below makes the unused
 *  exports (replay, profiling, etc.) tree-shakeable -- a namespace
 *  import would defeat that. */
type SentryRef = Pick<SentryBrowser, 'captureException' | 'addBreadcrumb'>

const DSN = import.meta.env.VITE_SENTRY_DSN as string | undefined

interface BufferedError {
  err:     unknown
  context?: Record<string, unknown>
}

/** Cap on the pre-init error buffer. If the @sentry chunk fails to
 *  load (network blackhole, ad blocker, CSP) or the idle callback never
 *  fires (page hidden the whole session), captureError keeps appending
 *  to `pending`. A long session that throws frequently could otherwise
 *  hold MB of error objects + breadcrumbs alive. 100 is enough to
 *  preserve early boot-stage signal while keeping memory bounded. */
const PENDING_CAP = 100

const pending: BufferedError[] = []
let sentryRef: SentryRef | null = null
let initStarted = false
/** Flipped when the dynamic import permanently fails. Subsequent
 *  captureError calls fall back to console.error instead of buffering,
 *  which would otherwise leak indefinitely. */
let loadFailed = false

function pushPending(item: BufferedError): void {
  if (pending.length >= PENDING_CAP) {
    // Drop the oldest to keep the most recent context (typically the
    // one causing the current crash). FIFO would lose the active error.
    pending.shift()
  }
  pending.push(item)
}

/** Boot-time global error handler. Pushes the error onto the buffer so
 *  that once Sentry loads we can replay it. Removed from the window
 *  after Sentry installs its own, richer handlers. */
function bufferGlobalError(e: Event): void {
  let err: unknown
  const type = e.type
  if (e instanceof PromiseRejectionEvent) {
    err = e.reason
  } else if (e instanceof ErrorEvent) {
    err = e.error ?? new Error(e.message)
  } else {
    err = new Error(`unknown global error event: ${type}`)
  }
  pushPending({ err, context: { source: 'window-global', type } })
}

export function initSentry(): void {
  if (initStarted) return
  initStarted = true

  if (!DSN) {
    if (import.meta.env.PROD) {
      console.warn('[sentry] VITE_SENTRY_DSN not set — production telemetry is disabled.')
    }
    return
  }

  // Sync global handlers fire BEFORE the @sentry chunk loads. Without
  // them a render-time crash during the idle window slips past Sentry
  // entirely (the page just dies). Tiny cost: two addEventListener calls.
  window.addEventListener('error', bufferGlobalError)
  window.addEventListener('unhandledrejection', bufferGlobalError)

  const load = async () => {
    try {
      // Destructured dynamic import so Rollup tree-shakes unused
      // exports. Surface kept to the minimum we actually use --
      // `init` once at startup and `captureException` at runtime.
      // Replay + browserTracing both deliberately omitted: this
      // project never consumed the recorded playback or performance
      // dashboards, and each integration costs ~50 KB raw of bundle
      // weight that lands on the critical path of every visitor.
      // captureException + breadcrumbs + stack traces are still
      // enough to triage every error this app actually emits.
      const { init, captureException, addBreadcrumb } = await import('@sentry/browser')
      init({
        dsn:          DSN,
        environment:  import.meta.env.MODE,
        release:      import.meta.env.PROD ? __APP_VERSION__ : undefined,
        integrations: [],
        ignoreErrors: [
          'AbortError',
          'ResizeObserver loop limit exceeded',
          'ResizeObserver loop completed with undelivered notifications',
        ],
      })
      sentryRef = { captureException, addBreadcrumb }
      window.removeEventListener('error', bufferGlobalError)
      window.removeEventListener('unhandledrejection', bufferGlobalError)
      for (const { err, context } of pending) {
        captureException(err, context ? { extra: context } : undefined)
      }
      pending.length = 0
    } catch (loadErr) {
      // Permanent failure path: stop buffering so captureError doesn't
      // leak. Existing pending errors are flushed to console so they're
      // still inspectable in DevTools; the bootstrap window handlers
      // are removed so we don't keep appending to a now-unused buffer.
      console.error('[sentry] dynamic import failed; telemetry disabled this session', loadErr)
      loadFailed = true
      window.removeEventListener('error', bufferGlobalError)
      window.removeEventListener('unhandledrejection', bufferGlobalError)
      for (const { err, context } of pending) {
        console.error('[sentry/queued]', err, context ?? '')
      }
      pending.length = 0
    }
  }

  // requestIdleCallback isn't on Safari < 16.4 (~6% of iOS as of mid-
  // 2026). Fallback to a setTimeout so the chunk still loads, just on
  // a fixed delay instead of idle-aware.
  if ('requestIdleCallback' in window) {
    requestIdleCallback(load, { timeout: 3000 })
  } else {
    setTimeout(load, 1500)
  }
}

/**
 * Capture a known error with optional context. Use this instead of bare
 * console.error in service / hook code — it reaches Sentry in prod and
 * still appears in dev console (Sentry mirrors there).
 *
 * Before Sentry's chunk loads, errors are buffered and replayed once
 * init completes. After load, they go directly to captureException.
 */
export function captureError(err: unknown, context?: Record<string, unknown>): void {
  if (!DSN || loadFailed) {
    // Either telemetry isn't configured, or the dynamic import gave up.
    // Either way, log to console and don't buffer -- buffering after a
    // permanent failure would grow unboundedly over a long session.
    console.error('[sentry/disabled]', err, context ?? '')
    return
  }
  if (sentryRef) {
    sentryRef.captureException(err, context ? { extra: context } : undefined)
  } else {
    pushPending({ err, context })
  }
}

/**
 * Record a breadcrumb that will attach to the next captured error.
 * Used by the upload flow (mintAndUploadEntityIntents + feature
 * services) to leave a `traceId`-tagged trail of mint → upload → write
 * stages, so a Sentry error event lets the operator reconstruct the
 * full chain and `wrangler tail | grep <traceId>` correlates it to
 * Worker logs.
 *
 * Pre-init: no-op. Sentry's breadcrumb buffer only collects post-init
 * events; replaying pre-init breadcrumbs would need a separate buffer
 * + replay path that's overkill for upload observability (an error
 * that fires before the @sentry chunk loads would have no breadcrumbs
 * anyway -- captureError's pending buffer catches the error itself
 * and traceId still threads through Worker logs via the header).
 */
export function breadcrumb(b: {
  category: string
  message:  string
  level?:   'info' | 'warning' | 'error'
  data?:    Record<string, unknown>
}): void {
  if (!sentryRef) return
  sentryRef.addBreadcrumb({
    category: b.category,
    message:  b.message,
    level:    b.level ?? 'info',
    data:     b.data,
  })
}
