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
    length:         itemBody.length,
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
