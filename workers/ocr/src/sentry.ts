// workers/ocr/src/sentry.ts
// Minimal Sentry transport for Workers — hand-rolled HTTP POST to the
// `/envelope/` ingest endpoint instead of pulling @sentry/cloudflare.
// Rationale:
//   - The SDK adds ~30-50 KB to the Worker bundle for features we don't
//     use (auto-instrumentation, breadcrumbs, perf monitoring, replay).
//   - We only fire a handful of capture calls per cron run (abuse alerts,
//     potentially future error reporting). A direct envelope POST is
//     ~30 lines and zero deps.
//   - Same DSN as the frontend so events land in the same Sentry project;
//     the `server_name`/tag conventions below let us filter Worker events
//     from frontend events in the UI.
//
// DSN format: `https://PUBLIC_KEY@oXXX.ingest.sentry.io/PROJECT_ID`
// Envelope endpoint: `${origin}/api/${PROJECT_ID}/envelope/`
// Auth: `X-Sentry-Auth` header with sentry_key=PUBLIC_KEY (plus version + client tags).
// Body: a multi-line envelope -- header line + item header line + item body line.
//
// All errors are swallowed: telemetry failures must NEVER bubble into
// the cron's reported success/failure path. A failed Sentry POST just
// means we lose ONE event; the cron's own console.log/.error is the
// authoritative "did this run work" signal.

export type SentryLevel = 'fatal' | 'error' | 'warning' | 'info' | 'debug'

/**
 * Report an unexpected failure. Built once per request in the fetch
 * handler so route code needs neither `env` nor `executionCtx`: the
 * closure already carries the DSN, the endpoint / uid / trace tags, and
 * the `waitUntil` that keeps the POST alive past the response.
 *
 * Deliberately returns void — reporting must never be something a caller
 * can await, forget to await, or fail on.
 */
export type ReportWorkerError = (message: string, extra?: Record<string, unknown>) => void

/** How far down an `Error.cause` chain to walk. Three covers every
 *  wrap depth this Worker builds (provider → helper → endpoint) and
 *  bounds the payload against a cycle or a pathological chain. */
const MAX_CAUSE_DEPTH = 3

interface SerializedError {
  name:    string
  message: string
  stack?:  string
  cause?:  SerializedError
}

/**
 * Flatten an error and its `cause` chain into something JSON can carry.
 *
 * Needed because neither half of an error survives `JSON.stringify` on
 * its own: `cause` is non-enumerable, and the outer `stack` does NOT
 * include the inner one. Reporting `{ stack, name }` therefore threw away
 * exactly the frames that say what actually failed — the cron re-throws
 * and the token-verification wrappers all attach a `cause` whose stack is
 * the only record of the underlying provider or Firestore error.
 *
 * Messages are copied verbatim; they already pass through
 * `captureMessage`, which only ever reaches our own Sentry project.
 * Nothing here widens what a CALLER sees — route-security's narrow
 * "invalid preview token" is unchanged on the wire.
 */
export function serializeErrorChain(error: unknown, depth = 0): SerializedError {
  const err = error instanceof Error ? error : new Error(String(error))
  const out: SerializedError = {
    name:    err.name,
    message: err.message,
    ...(err.stack ? { stack: err.stack } : {}),
  }
  if (err.cause !== undefined && err.cause !== null && depth < MAX_CAUSE_DEPTH) {
    out.cause = serializeErrorChain(err.cause, depth + 1)
  }
  return out
}

interface DsnParts {
  publicKey: string
  host:      string
  projectId: string
}

/** Parse the DSN once per call. DSN string parsing failures return null
 *  so the caller can no-op cleanly when the env var is unset / malformed
 *  (e.g. local dev without Sentry configured). */
function parseDsn(dsn: string | undefined): DsnParts | null {
  if (!dsn) return null
  try {
    const u = new URL(dsn)
    const projectId = u.pathname.replace(/^\//, '')
    if (!u.username || !u.host || !projectId) return null
    return { publicKey: u.username, host: u.host, projectId }
  } catch {
    return null
  }
}

/**
 * Send a message-level event to Sentry. Always non-blocking from the
 * caller's perspective: a failed POST gets swallowed (logged to
 * console.warn) rather than thrown.
 *
 * `tags` surface as searchable filters in the Sentry UI; `extra` is
 * structured context attached to the event body.
 *
 * Pass the same `SENTRY_DSN` as the frontend so all events land in
 * one project. The `server_name: 'tripmate-ocr'` makes Worker events
 * trivially filterable from frontend events.
 */
export async function captureMessage(
  env: { SENTRY_DSN?: string },
  message: string,
  level:   SentryLevel = 'info',
  tags?:   Record<string, string>,
  extra?:  Record<string, unknown>,
): Promise<void> {
  const dsn = parseDsn(env.SENTRY_DSN)
  if (!dsn) return  // not configured / dev / parse failure → silent no-op

  const eventId  = crypto.randomUUID().replace(/-/g, '')
  const sentAt   = new Date().toISOString()
  // Envelope = JSONL: { envelope header }, { item header }, { item body }
  const envelopeHeader = JSON.stringify({
    event_id: eventId,
    sent_at:  sentAt,
    dsn:      env.SENTRY_DSN,
  })
  const itemBody = JSON.stringify({
    event_id:    eventId,
    timestamp:   Date.now() / 1000,
    platform:    'javascript',
    level,
    message,
    server_name: 'tripmate-ocr',
    tags:        tags ?? {},
    extra:       extra ?? {},
    environment: 'production',
  })
  const itemHeader = JSON.stringify({
    type:           'event',
    content_type:   'application/json',
    // BYTES, not `itemBody.length`. A JS string's length counts UTF-16
    // code units, so one CJK character reads as 1 but serializes to 3 —
    // Sentry would then take only the declared prefix and reject the
    // envelope as malformed. Every error message this Worker reports can
    // carry Traditional Chinese, so this is the common case, not an edge.
    length:         new TextEncoder().encode(itemBody).byteLength,
  })
  const body = `${envelopeHeader}\n${itemHeader}\n${itemBody}`

  const url = `https://${dsn.host}/api/${dsn.projectId}/envelope/`
  // X-Sentry-Auth header — required for ingest. sentry_version=7 is the
  // current stable; sentry_client identifies this transport for
  // server-side filtering / debugging.
  const auth = [
    'Sentry sentry_version=7',
    'sentry_client=tripmate-worker/1.0',
    `sentry_key=${dsn.publicKey}`,
  ].join(', ')

  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/x-sentry-envelope',
        'X-Sentry-Auth': auth,
      },
      body,
    })
    if (!res.ok) {
      console.warn(`[sentry] envelope POST → ${res.status}`)
    }
  } catch (e) {
    // Network failure / DNS / etc. Don't crash the caller -- telemetry
    // is best-effort.
    console.warn(`[sentry] envelope POST failed: ${(e as Error).message}`)
  }
}
