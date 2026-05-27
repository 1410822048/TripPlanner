// TripMate OCR Worker — entry point.
//
// Endpoints:
//   POST /ocr                  — Gemini receipt OCR (original endpoint)
//   POST /cascade-member       — server-side membership cascade for
//                                accept-invite (admin SDK bypasses rules)
//   POST /cascade-trip-delete  — full trip cascade (Storage + subcollections
//                                + trip doc). Replaces client-side
//                                cascade so firestore.rules can keep
//                                `allow delete: if false` on the
//                                two integrity-critical docs (trip
//                                root + expense tombstones); closes
//                                P1 accepted-risk. Other subcollections
//                                still use ordinary canWrite-style
//                                delete rules for normal editing UX.
//   POST /upload-intents       — mint Worker-issued upload intents for
//                                Firebase Storage uploads (Phase 3.5).
//   POST /expense-create       — Worker-authoritative expense create
//   POST /expense-update         + update, consuming intentIds atomically
//                                with the doc write (Phase 3.5+).
//   POST /wish-file-create     — Worker-authoritative wish create + update
//   POST /wish-file-update       with image attachment (Phase 3.7).
//   POST /booking-file-create  — Worker-authoritative booking create + update
//   POST /booking-file-update    with file attachment (Phase 3.7).
//
// Scheduled:
//   Daily UTC 03:00 — purge expense receipts that have been soft-
//                     deleted for more than 10 days, drain orphan
//                     purges, scan orphan Storage, purge expired
//                     upload intents.
//
// All non-matching requests get a 404. CORS preflight (OPTIONS) is
// handled inline. Hand-rolled `pathname === ...` dispatch — a router
// lib isn't worth the bundle cost for ~10 endpoints with bespoke
// auth/rate-limit/Zod pipelines each.
import { verifyFirebaseToken, extractBearerToken } from './auth'
import { extractReceiptItems, GeminiError }       from './gemini'
import { OcrRequestSchema }                       from './schema'
import { cascadeMemberAdd, CascadeRequestSchema, CascadeError } from './cascade'
import { cascadeTripDelete, TripDeleteRequestSchema } from './trip-cascade'
import { purgeExpiredReceipts }                   from './receipt-purge'
import { drainOrphanPurges }                      from './orphan-purge'
import { scanOrphanStorage }                      from './storage-scan'
import { purgeExpiredUploadIntents }              from './upload-intent-purge'
import {
  expenseCreate, expenseUpdate,
  ExpenseCreateRequestSchema, ExpenseUpdateRequestSchema,
}                                                 from './expense-write'
import { ExpenseValidationError }                 from './expense-validate'
import {
  wishFileCreate,
  wishFileUpdate,
  WishFileCreateRequestSchema,
  WishFileUpdateRequestSchema,
  WishValidationError,
}                                                 from './wish-write'
import {
  bookingFileCreate,
  bookingFileUpdate,
  BookingFileCreateRequestSchema,
  BookingFileUpdateRequestSchema,
  BookingValidationError,
}                                                 from './booking-write'
import {
  createUploadIntents,
  UploadIntentsRequestSchema,
}                                                 from './upload-intent'
import { checkGlobalRateLimit }                   from './rate-limiter'
import {
  handleJsonRoute,
  validationErrorCatcher,
  json,
  uidTag,
}                                                 from './route-dispatch'

export { GlobalRateLimiter } from './rate-limiter'

interface WorkerEnv {
  FIREBASE_PROJECT_ID:      string
  FIREBASE_STORAGE_BUCKET:  string
  ALLOWED_ORIGINS:          string  // comma-separated
  GEMINI_API_KEY:           string  // secret
  FIREBASE_SERVICE_ACCOUNT: string  // secret — JSON string of service account key
  /** Sentry DSN for Worker-side telemetry (abuse alerts, future error
   *  reporting). Same DSN as the frontend's VITE_SENTRY_DSN -- events
   *  land in the same project, filterable by `server_name: 'tripmate-ocr'`.
   *  Empty string disables telemetry cleanly; override via `wrangler
   *  secret put SENTRY_DSN` for production. */
  SENTRY_DSN:               string
  /** Per-PoP per-uid rate limiter for the OCR endpoint. Cheap first-line
   *  filter (~0ms). Counters are local to each Cloudflare location. */
  OCR_RATE_LIMITER:         RateLimit
  /** Per-PoP per-uid rate limiter for the member-cascade endpoint. */
  CASCADE_RATE_LIMITER:     RateLimit
  /** Per-PoP per-uid rate limiter for the trip-delete endpoint.
   *  Tighter than member cascade because trip-delete is heavy
   *  (O(100) docs + Storage purge per call). */
  TRIP_CASCADE_RATE_LIMITER: RateLimit
  /** Per-PoP per-uid rate limiter for expense create/update. Same
   *  cap as OCR (30/min) -- one expense per ~2s sustained covers
   *  rapid form retries without blowing through Firestore admin
   *  write quotas. */
  EXPENSE_RATE_LIMITER:     RateLimit
  /** Cross-PoP global rate limiter. Durable Object — strongly
   *  consistent counter per-uid that catches multi-PoP abuse that
   *  would slip past the per-PoP binding. ~10-50ms latency cost. */
  GLOBAL_LIMITER:           DurableObjectNamespace
}

/** Resolve CORS headers for a given request origin. We allowlist
 *  origins (no reflect-any) because the API requires auth. Entries
 *  starting with `*.` are matched as suffix wildcards — Cloudflare
 *  Pages assigns per-deployment subdomains (e.g. `0b885524.tripmate-
 *  2wg.pages.dev`) so an exact-only match would force every preview
 *  deploy to be re-listed. The wildcard scope is bounded to a single
 *  trusted apex domain we own.
 *
 *  Origin parsing uses URL() so we never fall for substring tricks
 *  (`https://evil.com/?x=tripmate-2wg.pages.dev` would have failed the
 *  old string `indexOf('://')` check anyway, but explicit parse is
 *  cleaner and rejects malformed origins outright). */
function originAllowed(origin: string, patterns: string[]): boolean {
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return false  // malformed Origin header
  }
  // Only allow https + http (latter for localhost dev). Avoids exotic
  // schemes (file:, data:, chrome-extension:, etc.) being whitelisted
  // via wildcard match.
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false

  const host = parsed.host  // hostname[:port]
  return patterns.some(p => {
    if (p.startsWith('*.')) {
      const suffix = p.slice(1)  // ".tripmate-2wg.pages.dev"
      return host.endsWith(suffix) && host.length > suffix.length
    }
    return p === origin
  })
}

function corsHeaders(env: WorkerEnv, originHeader: string | null): Record<string, string> {
  const allowed = env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
  const allow   = originHeader && originAllowed(originHeader, allowed)
    ? originHeader
    : allowed[0]
  return {
    'Access-Control-Allow-Origin':  allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age':       '86400',
    'Vary':                          'Origin',
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url     = new URL(request.url)
    const cors    = corsHeaders(env, request.headers.get('Origin'))

    // ─── CORS preflight ────────────────────────────────────────────────
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors })
    }

    // ─── Routing ──────────────────────────────────────────────────────
    const isOcr           = url.pathname === '/ocr'                  && request.method === 'POST'
    const isCascade       = url.pathname === '/cascade-member'       && request.method === 'POST'
    const isTripCascade   = url.pathname === '/cascade-trip-delete'  && request.method === 'POST'
    const isExpenseCreate = url.pathname === '/expense-create'       && request.method === 'POST'
    const isExpenseUpdate = url.pathname === '/expense-update'       && request.method === 'POST'
    const isUploadIntents = url.pathname === '/upload-intents'       && request.method === 'POST'
    const isWishCreate    = url.pathname === '/wish-file-create'     && request.method === 'POST'
    const isWishUpdate    = url.pathname === '/wish-file-update'     && request.method === 'POST'
    const isBookingCreate = url.pathname === '/booking-file-create'  && request.method === 'POST'
    const isBookingUpdate = url.pathname === '/booking-file-update'  && request.method === 'POST'
    if (!isOcr && !isCascade && !isTripCascade && !isExpenseCreate && !isExpenseUpdate && !isUploadIntents && !isWishCreate && !isWishUpdate && !isBookingCreate && !isBookingUpdate) {
      return json({ error: 'Not found' }, 404, cors)
    }

    console.log(`[req] ${request.method} ${url.pathname} origin=${request.headers.get('Origin') ?? '?'}`)

    // ─── Body size guard ──────────────────────────────────────────────
    // Done before auth so 100MB unauthenticated bodies are rejected
    // without burning CPU on JWT verification first. 9MB covers an 8MB
    // base64 image + JSON envelope; cascade body is <1KB so this is a
    // no-op for it. Content-Length is client-supplied — bytes-actually-
    // streamed are still bounded by the platform's 100MB hard cap.
    const contentLength = Number(request.headers.get('content-length') ?? '0')
    if (contentLength > 9 * 1024 * 1024) {
      console.warn(`[body] too large: contentLength=${contentLength}`)
      return json({ error: 'Body too large' }, 413, cors)
    }

    // ─── Auth (shared by both routes) ─────────────────────────────────
    const token = extractBearerToken(request)
    if (!token) {
      console.warn('[auth] no bearer token')
      return json({ error: 'Missing Authorization' }, 401, cors)
    }
    let uid: string
    try {
      const claims = await verifyFirebaseToken(token, env.FIREBASE_PROJECT_ID)
      uid = claims.sub
      console.log(`[auth] ok uid=${uidTag(uid)}`)
    } catch (e) {
      console.warn(`[auth] invalid token: ${(e as Error).message}`)
      return json({ error: `Invalid token: ${(e as Error).message}` }, 401, cors)
    }

    // ─── Rate limit (per-uid, two-layer) ──────────────────────────────
    // L1: Per-PoP binding — fast (~0ms), catches single-location abuse.
    //     Per-uid key. Done after auth so unauthenticated noise doesn't
    //     burn counter slots.
    // L2: Cross-PoP Durable Object — slower (~10-50ms), strongly
    //     consistent, catches botnet-style multi-PoP multiplication
    //     that L1 alone can't see. Cap deliberately looser than L1 —
    //     L1's tighter per-location bound is the primary defense; L2
    //     is the cluster ceiling.
    const isExpenseWrite = isExpenseCreate || isExpenseUpdate
    // /upload-intents reuses EXPENSE_RATE_LIMITER for this commit --
    // the realistic workload (intent request before each upload)
    // matches expense create/update cadence (30/min). Adding a
    // dedicated UPLOAD_INTENT_RATE_LIMITER binding was deferred so
    // this commit doesn't grow its deploy-failure surface area;
    // future tuning can split if observed metrics justify.
    const limiter = isOcr            ? env.OCR_RATE_LIMITER
                  : isTripCascade    ? env.TRIP_CASCADE_RATE_LIMITER
                  : isExpenseWrite   ? env.EXPENSE_RATE_LIMITER
                  : isUploadIntents  ? env.EXPENSE_RATE_LIMITER
                  : isWishCreate     ? env.EXPENSE_RATE_LIMITER
                  : isWishUpdate     ? env.EXPENSE_RATE_LIMITER
                  : isBookingCreate  ? env.EXPENSE_RATE_LIMITER
                  : isBookingUpdate  ? env.EXPENSE_RATE_LIMITER
                  : env.CASCADE_RATE_LIMITER
    const localResult = await limiter.limit({ key: uid })
    if (!localResult.success) {
      console.warn(`[rate-limit] L1 deny uid=${uidTag(uid)} route=${url.pathname}`)
      return json({ error: 'Rate limit exceeded' }, 429, cors)
    }

    // Scope name + L2 limit. trip-delete is the strictest. expense
    // matches OCR (60/min L2) -- both are user-facing rapid actions.
    const scope       = isOcr ? 'ocr'
                      : isTripCascade   ? 'trip-cascade'
                      : isExpenseWrite  ? 'expense'
                      : isUploadIntents ? 'upload-intent'
                      : isWishCreate    ? 'wish-write'
                      : isWishUpdate    ? 'wish-write'
                      : isBookingCreate ? 'booking-write'
                      : isBookingUpdate ? 'booking-write'
                      : 'cascade'
    const globalLimit = isOcr ? 60
                      : isTripCascade   ? 2
                      : isExpenseWrite  ? 60
                      : isUploadIntents ? 60
                      : isWishCreate    ? 60
                      : isWishUpdate    ? 60
                      : isBookingCreate ? 60
                      : isBookingUpdate ? 60
                      : 10
    const globalResult = await checkGlobalRateLimit(
      env.GLOBAL_LIMITER, scope, uid, globalLimit, 60_000,
    )
    if (!globalResult.allowed) {
      console.warn(
        `[rate-limit] L2 deny uid=${uidTag(uid)} route=${url.pathname} ` +
        `count=${globalResult.count} resetMs=${globalResult.resetMs}`,
      )
      return json({ error: 'Global rate limit exceeded' }, 429, cors)
    }

    // ─── Body parsing (shared) ────────────────────────────────────────
    let body: unknown
    try {
      body = await request.json()
    } catch {
      console.warn('[body] not valid JSON')
      return json({ error: 'Invalid JSON' }, 400, cors)
    }

    // ─── Per-route dispatch ──────────────────────────────────────────
    // Each route shares the same parse → handle → catch shape; see
    // route-dispatch.ts for the wrapper contract. Per-route variation
    // is captured by 4 callbacks: handle, formatLog, formatResponse,
    // catchDomain. Auth + rate-limit + body-size + CORS handled above.

    if (isExpenseCreate) return handleJsonRoute({
      endpoint:       'expense-create', body, cors, uid,
      schema:         ExpenseCreateRequestSchema,
      handle:         data => expenseCreate(uid, data, env.FIREBASE_SERVICE_ACCOUNT, env.FIREBASE_STORAGE_BUCKET),
      formatLog:      (data, result) => `trip=${data.tripId} exp=${result.expenseId}`,
      formatResponse: result => ({ ok: true, ...result }),
      catchDomain:    validationErrorCatcher(ExpenseValidationError),
    })

    if (isExpenseUpdate) return handleJsonRoute({
      endpoint:    'expense-update', body, cors, uid,
      schema:      ExpenseUpdateRequestSchema,
      handle:      data => expenseUpdate(uid, data, env.FIREBASE_SERVICE_ACCOUNT, env.FIREBASE_STORAGE_BUCKET),
      formatLog:   data => `trip=${data.tripId} exp=${data.expenseId}`,
      catchDomain: validationErrorCatcher(ExpenseValidationError),
    })

    if (isWishCreate) return handleJsonRoute({
      endpoint:       'wish-file-create', body, cors, uid,
      schema:         WishFileCreateRequestSchema,
      handle:         data => wishFileCreate(uid, data, env.FIREBASE_SERVICE_ACCOUNT, env.FIREBASE_STORAGE_BUCKET),
      formatLog:      (data, result) => `trip=${data.tripId} wish=${result.wishId}`,
      formatResponse: result => ({ ok: true, ...result }),
      catchDomain:    validationErrorCatcher(WishValidationError),
    })

    if (isWishUpdate) return handleJsonRoute({
      endpoint:    'wish-file-update', body, cors, uid,
      schema:      WishFileUpdateRequestSchema,
      handle:      data => wishFileUpdate(uid, data, env.FIREBASE_SERVICE_ACCOUNT, env.FIREBASE_STORAGE_BUCKET),
      formatLog:   data => `trip=${data.tripId} wish=${data.wishId}`,
      catchDomain: validationErrorCatcher(WishValidationError),
    })

    if (isBookingCreate) return handleJsonRoute({
      endpoint:       'booking-file-create', body, cors, uid,
      schema:         BookingFileCreateRequestSchema,
      handle:         data => bookingFileCreate(uid, data, env.FIREBASE_SERVICE_ACCOUNT, env.FIREBASE_STORAGE_BUCKET),
      formatLog:      (data, result) => `trip=${data.tripId} booking=${result.bookingId}`,
      formatResponse: result => ({ ok: true, ...result }),
      catchDomain:    validationErrorCatcher(BookingValidationError),
    })

    if (isBookingUpdate) return handleJsonRoute({
      endpoint:    'booking-file-update', body, cors, uid,
      schema:      BookingFileUpdateRequestSchema,
      handle:      data => bookingFileUpdate(uid, data, env.FIREBASE_SERVICE_ACCOUNT, env.FIREBASE_STORAGE_BUCKET),
      formatLog:   data => `trip=${data.tripId} booking=${data.bookingId}`,
      catchDomain: validationErrorCatcher(BookingValidationError),
    })

    if (isUploadIntents) return handleJsonRoute({
      endpoint:  'upload-intents', body, cors, uid,
      schema:    UploadIntentsRequestSchema,
      handle:    data => createUploadIntents(uid, data, env.FIREBASE_SERVICE_ACCOUNT),
      formatLog: (data, result) =>
        `trip=${data.tripId} entity=${data.entityType}/${data.entityId} count=${result.intents.length}`,
    })

    if (isTripCascade) return handleJsonRoute({
      endpoint:       'trip-cascade', body, cors, uid,
      schema:         TripDeleteRequestSchema,
      handle:         data => cascadeTripDelete(uid, data, env.FIREBASE_SERVICE_ACCOUNT, env.FIREBASE_STORAGE_BUCKET),
      formatLog:      (data, result) => `trip=${data.tripId} docs=${result.deletedDocs} objects=${result.deletedObjects}`,
      formatResponse: result => ({ ok: true, ...result }),
    })

    if (isCascade) return handleJsonRoute({
      endpoint:       'cascade', body, cors, uid,
      schema:         CascadeRequestSchema,
      handle:         data => cascadeMemberAdd(uid, data, env.FIREBASE_SERVICE_ACCOUNT),
      formatLog:      (data, result) => `trip=${data.tripId} updated=${result.updatedDocs}`,
      formatResponse: result => ({ ok: true, ...result }),
    })

    return handleJsonRoute({
      endpoint:  'ocr', body, cors, uid,
      schema:    OcrRequestSchema,
      handle:    data => extractReceiptItems(data.image, data.mimeType, data.currency, env.GEMINI_API_KEY),
      formatLog: (_data, result) => `items=${result.items.length}`,
      catchDomain: e => e instanceof GeminiError
        ? {
            log:    `GeminiError status=${e.status} msg=${e.message}`,
            body:   { error: e.message },
            status: e.status,
          }
        : null,
    })
  },

  // ─── Cron: 10-day receipt purge ───────────────────────────────────
  // Triggered daily UTC 03:00 (see wrangler.jsonc triggers.crons).
  // Soft deadline (~14min) lives inside purgeExpiredReceipts; whatever
  // doesn't process gets picked up tomorrow — the deletedAt < cutoff
  // filter is naturally idempotent across runs.
  async scheduled(_event, env, ctx): Promise<void> {
    console.log('[cron] receipt-purge starting')
    ctx.waitUntil(
      purgeExpiredReceipts(env.FIREBASE_SERVICE_ACCOUNT, env.FIREBASE_STORAGE_BUCKET)
        .then(report => {
          console.log(
            `[cron] receipt-purge done scanned=${report.scanned} ` +
            `receiptsDeleted=${report.receiptsDeleted} docsPatched=${report.docsPatched} ` +
            `deadlineHit=${report.deadlineHit}`,
          )
        })
        .catch(err => {
          // Don't throw — cron runs are best-effort; tomorrow's pass
          // re-converges on whatever this run missed. We still log the
          // error so observability picks up the failure mode.
          console.error(`[cron] receipt-purge failed: ${(err as Error).message}`)
        }),
    )
    // Orphan-blob queue drain. Independent from receipt-purge (different
    // invariant): receipt-purge sweeps soft-deleted-expense receipts
    // after the 10-day window; orphan-purge drains the _purges queue
    // written by best-effort cleanup paths that gave up. Runs in
    // parallel via separate waitUntil so a failure in one doesn't
    // starve the other.
    console.log('[cron] orphan-purge starting')
    ctx.waitUntil(
      drainOrphanPurges(env.FIREBASE_SERVICE_ACCOUNT, env.FIREBASE_STORAGE_BUCKET)
        .then(report => {
          console.log(
            `[cron] orphan-purge done scanned=${report.scanned} ` +
            `blobsDeleted=${report.blobsDeleted} falseOrphans=${report.falseOrphans} ` +
            `giveUps=${report.giveUps} deadlineHit=${report.deadlineHit}`,
          )
        })
        .catch(err => {
          console.error(`[cron] orphan-purge failed: ${(err as Error).message}`)
        }),
    )
    // Level 4 orphan-blob reconciliation. Independent from the queue-
    // driven orphan-purge: catches blobs uploaded outside the normal
    // service paths (editor SDK abuse, mid-upload process kills, manual
    // console writes). 24h grace window keeps the active flow safe.
    // Runs parallel to the other two via its own waitUntil so any
    // failure here doesn't starve them (or vice versa).
    console.log('[cron] storage-scan starting')
    ctx.waitUntil(
      scanOrphanStorage(
        env.FIREBASE_SERVICE_ACCOUNT,
        env.FIREBASE_STORAGE_BUCKET,
        // sentryEnv passed in so the scan's abuse-detection branch can
        // fire captureMessage; sentry.ts no-ops when SENTRY_DSN is
        // empty / unset, so this is safe to always wire up.
        { sentryEnv: env },
      )
        .then(report => {
          // Top-3 uids in the log line so operators can see attribution
          // at a glance without digging into Sentry. JSON.stringify of
          // the full map would balloon the log on a busy scan.
          const topUids = Object.entries(report.orphansByUid)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 3)
            .map(([uid, n]) => `${uid}=${n}`)
            .join(',') || 'none'
          console.log(
            `[cron] storage-scan done scanned=${report.scanned} ` +
            `deleted=${report.deleted} referenced=${report.referenced} ` +
            `freshSkipped=${report.freshSkipped} unparseable=${report.unparseable} ` +
            `readErrors=${report.readErrors} deleteErrors=${report.deleteErrors} ` +
            `deadlineHit=${report.deadlineHit} budgetHit=${report.budgetHit} ` +
            `topOrphanUids=${topUids}`,
          )
        })
        .catch(err => {
          console.error(`[cron] storage-scan failed: ${(err as Error).message}`)
        }),
    )
    // Phase 3.5 uploadIntents cleanup. Two-pass purge: expired pending
    // (TTL'd intents that never finalized) + stale used (retention
    // cleanup at 7d). Independent waitUntil so any failure here doesn't
    // starve the other three crons. See upload-intent-purge.ts for the
    // pass logic + the project-phase35-upload-intent memory for the
    // "why cron not Firestore TTL" rationale.
    console.log('[cron] upload-intent-purge starting')
    ctx.waitUntil(
      purgeExpiredUploadIntents(env.FIREBASE_SERVICE_ACCOUNT)
        .then(report => {
          console.log(
            `[cron] upload-intent-purge done scanned=${report.scanned} ` +
            `deletedPending=${report.deletedPending} deletedUsed=${report.deletedUsed} ` +
            `deleteErrors=${report.deleteErrors} ` +
            `deadlineHit=${report.deadlineHit} budgetHit=${report.budgetHit}`,
          )
        })
        .catch(err => {
          console.error(`[cron] upload-intent-purge failed: ${(err as Error).message}`)
        }),
    )
  },
} satisfies ExportedHandler<WorkerEnv>
