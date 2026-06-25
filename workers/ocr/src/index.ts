// TripMate OCR Worker — entry point.
//
// Endpoints:
//   POST /ocr                  — primary configured receipt OCR provider
//   POST /booking-pdf-extract  — Claude-only structured extraction from
//                                client-side PDF text/layout digest.
//   POST /invite-create        — owner mints a reusable invite link.
//                                Worker mints the 256-bit token, caps the
//                                expiry, and atomically rotates the
//                                single-active pointer (inviteState/current)
//                                so concurrent owner tabs can't leave two
//                                live invites (see membership-write.ts).
//   POST /invite-revoke        — owner revokes the active invite. 409s a
//                                stale token (already rotated by a newer
//                                /invite-create) instead of silent-ok.
//   POST /invite-redeem        — invitee accepts a trip invite (atomic
//                                member doc create + trip.memberIds
//                                bump via Firestore REST tx), gated on the
//                                inviteState/current pointer, then runs the
//                                ACL cascade.
//   POST /member-remove        — owner kicks a member. ACL projection
//                                stripped BEFORE the member doc is
//                                deleted -- the order is load-bearing
//                                for the "no kicked-but-still-reading"
//                                invariant (see membership-write.ts).
//   POST /member-role-update   — owner flips a member between
//                                'editor' / 'viewer'.
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
//   POST /settlement-create    — Worker-authoritative settlement create
//   POST /settlement-delete      + delete, with full pairwise debt
//                                computation in tx for the amountMinor<=remaining
//                                gate that firestore.rules cannot express.
//
// Scheduled:
//   Daily UTC 03:00 — purge expense receipts that have been soft-
//                     deleted for more than 10 days, drain orphan
//                     purges, scan orphan Storage, purge expired
//                     upload intents.
//
// All non-matching requests get a 404. CORS preflight (OPTIONS) is
// handled inline. Dispatch is a flat endpoint descriptor table (ROUTES);
// not a router lib — each endpoint keeps its bespoke auth/rate-limit/Zod
// pipeline explicit in its `dispatch` closure.
//
// Observability: upload-flow callers send `X-Upload-Trace-Id: <uuid>`
// minted client-side by `mintAndUploadEntityIntents`. Validated by
// `extractTraceId` and appended as `trace=<id>` to every log line
// (req / auth / rate-limit / dispatch success+warn+error) so the same
// id correlates `/upload-intents`, the parallel storage SDK uploads
// (visible only in Sentry breadcrumbs), and the entity-write call
// (`/expense-{create,update}`, `/wish-file-*`, `/booking-file-*`).
// Cascade / OCR endpoints don't set the header; their log lines omit
// the suffix.
import { verifyFirebaseToken, extractBearerToken } from './auth'
import { OcrError }                               from './claude'
import { OcrRequestSchema, type OcrRequest, type OcrResponse } from './schema'
import {
  parseBooleanEnv,
  parseOcrProvider,
  parseOptionalOcrProvider,
  runOcrProvider,
  type OcrProvider,
  type OcrProviderConfig,
}                                                 from './ocr-providers'
import { expenseReceiptOcr, ExpenseReceiptOcrRequestSchema } from './expense-receipt-ocr'
import {
  extractBookingPdfFields,
  BookingPdfExtractRequestSchema,
  type BookingPdfExtractResponse,
}                                                 from './booking-pdf-extract'
import { cascadeTripDelete, TripDeleteRequestSchema } from './trip-cascade'
import { purgeExpiredReceipts }                   from './receipt-purge'
import { drainOrphanPurges }                      from './orphan-purge'
import { runStorageMaintenance }                  from './storage-scan'
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
  settlementCreate,
  settlementDelete,
  SettlementCreateRequestSchema,
  SettlementDeleteRequestSchema,
  SettlementValidationError,
}                                                 from './settlement-write'
import {
  inviteCreate,
  inviteRevoke,
  inviteRedeem,
  memberRemove,
  memberLeave,
  memberRoleUpdate,
  ownerTransfer,
  InviteCreateRequestSchema,
  InviteRevokeRequestSchema,
  InviteRedeemRequestSchema,
  MemberRemoveRequestSchema,
  MemberLeaveRequestSchema,
  MemberRoleUpdateRequestSchema,
  OwnerTransferRequestSchema,
  MembershipValidationError,
}                                                 from './membership-write'
import {
  createUploadIntents,
  UploadIntentsRequestSchema,
}                                                 from './upload-intent'
import {
  MAX_PDF_PAGES,
  PdfPageLimitError,
  pdfPageLimitMessageJa,
  pdfPageLimitStatus,
}                                                 from '@tripmate/pdf-page-limit'
import {
  signEntityUrl,
  AttachmentUrlRequestSchema,
}                                                 from './attachment-url'
import { checkGlobalRateLimit }                   from './rate-limiter'
import {
  handleJsonRoute,
  validationErrorCatcher,
  fxErrorCatcher,
  attachmentHardeningErrorCatcher,
  chainCatchers,
  extractTraceId,
  UPLOAD_TRACE_HEADER,
  json,
  uidTag,
}                                                 from './route-dispatch'

export { GlobalRateLimiter } from './rate-limiter'

interface WorkerEnv {
  FIREBASE_PROJECT_ID:      string
  FIREBASE_STORAGE_BUCKET:  string
  ALLOWED_ORIGINS:          string  // comma-separated
  ANTHROPIC_FOUNDRY_API_KEY: string // secret — Microsoft Foundry (Azure AI Foundry) Claude API key
  ANTHROPIC_FOUNDRY_RESOURCE: string // var — Foundry resource name (e.g. aic-claude-eus2)
  CLAUDE_DEPLOYMENT:        string  // var — Foundry deployment name (e.g. claude-haiku-4-5-2)
  BOOKING_CLAUDE_DEPLOYMENT?: string // var — optional faster deployment for booking PDF import
  FIREBASE_SERVICE_ACCOUNT: string  // secret — JSON string of service account key
  QWEN_API_KEY:             string  // secret; OpenAI-compatible Qwen provider API key
  QWEN_BASE_URL:            string  // var; without /chat/completions
  QWEN_MODEL:               string  // var; e.g. qwen3-vl-flash / qwen3.6-flash
  OCR_PRIMARY_PROVIDER?:    string  // var; qwen | claude, default qwen
  OCR_FALLBACK_PROVIDER?:   string  // var; claude | qwen | none, default claude
  OCR_COMPARE_ENABLED?:     string  // var; true only for dev / QA environments
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
  /** Per-PoP per-uid rate limiter for settlement create/delete.
   *  Tighter (5/min) than expense -- settlement is a clicked-button
   *  rare event, and create runs a full pairwise debt computation
   *  (tx + 2 runQuery reads) per request. */
  SETTLEMENT_RATE_LIMITER:  RateLimit
  /** Per-PoP per-uid rate limiter for the attachment signed-URL endpoint
   *  (/attachment-url, full/pdf entity-ref). Looser (120/min) than expense
   *  -- the work is a local RSA sign (no OCR / no Firestore write). */
  ATTACHMENT_URL_RATE_LIMITER: RateLimit
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
    // UPLOAD_TRACE_HEADER is a custom (non-CORS-safelisted) request
    // header set by mintAndUploadEntityIntents; without it on this
    // allow-list, browsers reject the preflight for every upload-flow
    // endpoint (/upload-intents, /expense-*, /booking-file-*,
    // /wish-file-*). Sourced from the same constant the server uses
    // to read the header so the two stay in lockstep.
    'Access-Control-Allow-Headers': `Authorization, Content-Type, ${UPLOAD_TRACE_HEADER}`,
    'Access-Control-Max-Age':       '86400',
    'Vary':                          'Origin',
  }
}

// ─── Endpoint descriptor table ────────────────────────────────────
// One row per endpoint, replacing the old parallel `isXxx` booleans +
// limiter/scope/globalLimit ternaries + per-route `if` chain. Adding an
// endpoint is now one ROUTES row (+ a RATE_CLASSES entry only if it needs
// a new rate class) instead of editing four separate places. Deliberately
// NOT a generic router: a flat table + linear path match, no middleware
// framework — each endpoint's auth/Zod/error shape stays explicit in its
// `dispatch`.

/** Keys of WorkerEnv whose binding is a per-PoP RateLimit (the L1 layer). */
type RateLimiterBinding = {
  [K in keyof WorkerEnv]: WorkerEnv[K] extends RateLimit ? K : never
}[keyof WorkerEnv]

/** L1 binding + L2 scope + L2 cap for a class of endpoints. The L1 binding
 *  and the L2 scope are deliberately NOT 1:1: expense / upload-intent /
 *  wish-write / booking-write all share the EXPENSE_RATE_LIMITER per-PoP
 *  counter but keep distinct L2 scopes (separate cross-PoP ceilings). A
 *  scope string is the Durable Object counter namespace — changing it
 *  re-buckets live counters, so treat these strings as a wire contract. */
interface RateClass {
  limiter:     RateLimiterBinding
  scope:       string
  globalLimit: number
}

// Exported for the rate-class golden test (workers/ocr/test/index.spec.ts):
// it pins every endpoint's (binding, scope, cap) so a future table edit
// that silently weakens abuse protection fails loudly.
export const RATE_CLASSES = {
  ocr:                { limiter: 'OCR_RATE_LIMITER',            scope: 'ocr',              globalLimit: 60 },
  'trip-cascade':     { limiter: 'TRIP_CASCADE_RATE_LIMITER',   scope: 'trip-cascade',     globalLimit: 2 },
  expense:            { limiter: 'EXPENSE_RATE_LIMITER',        scope: 'expense',          globalLimit: 60 },
  'upload-intent':    { limiter: 'EXPENSE_RATE_LIMITER',        scope: 'upload-intent',    globalLimit: 60 },
  'wish-write':       { limiter: 'EXPENSE_RATE_LIMITER',        scope: 'wish-write',       globalLimit: 60 },
  'booking-write':    { limiter: 'EXPENSE_RATE_LIMITER',        scope: 'booking-write',    globalLimit: 60 },
  'settlement-write': { limiter: 'SETTLEMENT_RATE_LIMITER',     scope: 'settlement-write', globalLimit: 10 },
  'attachment-url':   { limiter: 'ATTACHMENT_URL_RATE_LIMITER', scope: 'attachment-url',   globalLimit: 300 },
  membership:         { limiter: 'CASCADE_RATE_LIMITER',        scope: 'cascade',          globalLimit: 10 },
} as const satisfies Record<string, RateClass>

type RateClassKey = keyof typeof RATE_CLASSES

/** Request-scoped values threaded into each route's dispatch closure. */
interface DispatchCtx {
  body:    unknown
  cors:    Record<string, string>
  uid:     string
  traceId: string | undefined
  env:     WorkerEnv
}

interface RouteDescriptor {
  /** Exact pathname; POST only (every endpoint is POST). */
  path:     string
  /** Rate class → (L1 binding, L2 scope, L2 cap). */
  rate:     RateClassKey
  /** Per-route parse → handle → catch, wrapped by handleJsonRoute. */
  dispatch: (c: DispatchCtx) => Response | Promise<Response>
}

type OcrCompareResult =
  | { provider: OcrProvider; ok: true;  elapsedMs: number; result: OcrResponse }
  | { provider: OcrProvider; ok: false; elapsedMs: number; error: { message: string; status: number } }

function ocrProviderConfig(env: WorkerEnv): OcrProviderConfig {
  return {
    claude: {
      apiKey:   env.ANTHROPIC_FOUNDRY_API_KEY,
      resource: env.ANTHROPIC_FOUNDRY_RESOURCE,
      model:    env.CLAUDE_DEPLOYMENT,
    },
    qwen: {
      apiKey:  env.QWEN_API_KEY,
      baseUrl: env.QWEN_BASE_URL,
      model:   env.QWEN_MODEL,
    },
  }
}

function bookingPdfClaudeConfig(env: WorkerEnv): OcrProviderConfig['claude'] {
  return {
    apiKey:   env.ANTHROPIC_FOUNDRY_API_KEY,
    resource: env.ANTHROPIC_FOUNDRY_RESOURCE,
    model:    env.BOOKING_CLAUDE_DEPLOYMENT?.trim() || env.CLAUDE_DEPLOYMENT,
  }
}

function primaryOcrProvider(env: WorkerEnv): OcrProvider {
  return parseOcrProvider(env.OCR_PRIMARY_PROVIDER, 'OCR_PRIMARY_PROVIDER', 'qwen')
}

function fallbackOcrProvider(env: WorkerEnv): OcrProvider | 'none' {
  return parseOptionalOcrProvider(env.OCR_FALLBACK_PROVIDER, 'OCR_FALLBACK_PROVIDER', 'claude')
}

function compareEnabled(env: WorkerEnv): boolean {
  return parseBooleanEnv(env.OCR_COMPARE_ENABLED, false)
}

function runConfiguredOcrProvider(env: WorkerEnv, provider: OcrProvider, data: OcrRequest): Promise<OcrResponse> {
  return runOcrProvider(provider, data.image, data.mimeType, data.currency, ocrProviderConfig(env))
}

function clientSafeOcrError(status: number): string {
  if (status === 400) return 'OCR request was rejected'
  if (status === 404) return 'OCR route is disabled'
  if (status === 429) return 'OCR provider is rate limited'
  if (status === 422) return 'OCR provider could not parse this receipt'
  if (status === 503 || status === 504) return 'OCR provider is temporarily unavailable'
  return 'OCR provider failed'
}

function ocrErrorCatcher(e: unknown) {
  return e instanceof OcrError
    ? {
        log:    `OcrError status=${e.status} msg=${e.message}`,
        body:   { error: clientSafeOcrError(e.status) },
        status: e.status,
      }
    : null
}

function pdfPageLimitErrorCatcher() {
  return (e: unknown) => e instanceof PdfPageLimitError
    ? {
        log: `pdf-page-limit: ${e.code} ${e.message}`,
        body: {
          error: pdfPageLimitMessageJa(e.code, MAX_PDF_PAGES),
          code: e.code,
          maxPages: MAX_PDF_PAGES,
          ...(e.pageCount !== undefined ? { pageCount: e.pageCount } : {}),
          retryable: false,
        },
        status: pdfPageLimitStatus(e.code),
      }
    : null
}

function clientSafeCompareError(status: number): string {
  return clientSafeOcrError(status)
}

async function timedOcrProvider(
  provider: OcrProvider,
  run: () => Promise<OcrResponse>,
): Promise<OcrCompareResult> {
  const started = Date.now()
  try {
    const result = await run()
    return { provider, ok: true, elapsedMs: Date.now() - started, result }
  } catch (e) {
    const err = e as Error
    const status = e instanceof OcrError ? e.status : 500
    console.error(`[ocr-compare] ${provider} failed: status=${status} msg=${err.message}`)
    return {
      provider,
      ok: false,
      elapsedMs: Date.now() - started,
      error: {
        message: clientSafeCompareError(status),
        status,
      },
    }
  }
}

function formatCompareResult(r: OcrCompareResult): string {
  return r.ok
    ? `${r.provider}:ok items=${r.result.items.length} adjustments=${r.result.adjustments.length} ignored=${r.result.ignoredLines.length} ms=${r.elapsedMs}`
    : `${r.provider}:err status=${r.error.status} ms=${r.elapsedMs}`
}

function bookingPdfFieldCount(result: BookingPdfExtractResponse): number {
  return result.bookings
    .flatMap(booking => [
      booking.title,
      booking.provider,
      booking.confirmationCode,
      booking.origin,
      booking.destination,
      booking.checkIn,
      booking.checkOut,
      booking.address,
      booking.link,
    ])
    .filter(field => field.value.trim()).length
}

export const ROUTES: RouteDescriptor[] = [
  {
    path: '/expense-create', rate: 'expense',
    dispatch: c => handleJsonRoute({
      endpoint:       'expense-create', body: c.body, cors: c.cors, uid: c.uid, traceId: c.traceId,
      schema:         ExpenseCreateRequestSchema,
      handle:         data => expenseCreate(c.uid, data, c.env.FIREBASE_SERVICE_ACCOUNT, c.env.FIREBASE_STORAGE_BUCKET),
      formatLog:      (data, result) => `trip=${data.tripId} exp=${result.expenseId}`,
      formatResponse: result => ({ ok: true, ...result }),
      // FOREIGN_CURRENCY path calls getFxSnapshot → FxError on future
      // settledOn / Frankfurter degraded; chain in fxErrorCatcher so the
      // route returns the actionable 4xx/5xx instead of a generic 500.
      catchDomain: chainCatchers(
        validationErrorCatcher(ExpenseValidationError),
        fxErrorCatcher(),
        pdfPageLimitErrorCatcher(),
        attachmentHardeningErrorCatcher(),
      ),
    }),
  },
  {
    path: '/expense-update', rate: 'expense',
    dispatch: c => handleJsonRoute({
      endpoint:    'expense-update', body: c.body, cors: c.cors, uid: c.uid, traceId: c.traceId,
      schema:      ExpenseUpdateRequestSchema,
      handle:      data => expenseUpdate(c.uid, data, c.env.FIREBASE_SERVICE_ACCOUNT, c.env.FIREBASE_STORAGE_BUCKET),
      formatLog:   data => `trip=${data.tripId} exp=${data.expenseId}`,
      // Same FX-touch + chain as expense-create above.
      catchDomain: chainCatchers(
        validationErrorCatcher(ExpenseValidationError),
        fxErrorCatcher(),
        pdfPageLimitErrorCatcher(),
        attachmentHardeningErrorCatcher(),
      ),
    }),
  },
  {
    path: '/wish-file-create', rate: 'wish-write',
    dispatch: c => handleJsonRoute({
      endpoint:       'wish-file-create', body: c.body, cors: c.cors, uid: c.uid, traceId: c.traceId,
      schema:         WishFileCreateRequestSchema,
      handle:         data => wishFileCreate(c.uid, data, c.env.FIREBASE_SERVICE_ACCOUNT, c.env.FIREBASE_STORAGE_BUCKET),
      formatLog:      (data, result) => `trip=${data.tripId} wish=${result.wishId}`,
      formatResponse: result => ({ ok: true, ...result }),
      catchDomain:    chainCatchers(
        validationErrorCatcher(WishValidationError),
        attachmentHardeningErrorCatcher(),
      ),
    }),
  },
  {
    path: '/wish-file-update', rate: 'wish-write',
    dispatch: c => handleJsonRoute({
      endpoint:    'wish-file-update', body: c.body, cors: c.cors, uid: c.uid, traceId: c.traceId,
      schema:      WishFileUpdateRequestSchema,
      handle:      data => wishFileUpdate(c.uid, data, c.env.FIREBASE_SERVICE_ACCOUNT, c.env.FIREBASE_STORAGE_BUCKET),
      formatLog:   data => `trip=${data.tripId} wish=${data.wishId}`,
      catchDomain: chainCatchers(
        validationErrorCatcher(WishValidationError),
        attachmentHardeningErrorCatcher(),
      ),
    }),
  },
  {
    path: '/booking-file-create', rate: 'booking-write',
    dispatch: c => handleJsonRoute({
      endpoint:       'booking-file-create', body: c.body, cors: c.cors, uid: c.uid, traceId: c.traceId,
      schema:         BookingFileCreateRequestSchema,
      handle:         data => bookingFileCreate(c.uid, data, c.env.FIREBASE_SERVICE_ACCOUNT, c.env.FIREBASE_STORAGE_BUCKET),
      formatLog:      (data, result) => `trip=${data.tripId} booking=${result.bookingId}`,
      formatResponse: result => ({ ok: true, ...result }),
      catchDomain:    chainCatchers(
        validationErrorCatcher(BookingValidationError),
        pdfPageLimitErrorCatcher(),
        attachmentHardeningErrorCatcher(),
      ),
    }),
  },
  {
    path: '/booking-file-update', rate: 'booking-write',
    dispatch: c => handleJsonRoute({
      endpoint:    'booking-file-update', body: c.body, cors: c.cors, uid: c.uid, traceId: c.traceId,
      schema:      BookingFileUpdateRequestSchema,
      handle:      data => bookingFileUpdate(c.uid, data, c.env.FIREBASE_SERVICE_ACCOUNT, c.env.FIREBASE_STORAGE_BUCKET),
      formatLog:   data => `trip=${data.tripId} booking=${data.bookingId}`,
      catchDomain: chainCatchers(
        validationErrorCatcher(BookingValidationError),
        pdfPageLimitErrorCatcher(),
        attachmentHardeningErrorCatcher(),
      ),
    }),
  },
  {
    path: '/settlement-create', rate: 'settlement-write',
    dispatch: c => handleJsonRoute({
      endpoint:       'settlement-create', body: c.body, cors: c.cors, uid: c.uid,
      schema:         SettlementCreateRequestSchema,
      handle:         data => settlementCreate(c.uid, data, c.env.FIREBASE_SERVICE_ACCOUNT),
      // Mode-aware log line: no branch carries a user-entered ledger or
      // source amount. `expectedRemainingMinor` is the stale-confirmation
      // guard; Worker recomputes pair-remaining in the tx and writes
      // amountMinor = remaining.
      formatLog: (data, result) =>
        data.mode === 'FOREIGN_CURRENCY'
          ? `trip=${data.tripId} settlement=${result.settlementId} from=${data.fromUid} mode=FOREIGN expectedRemainingMinor=${data.expectedRemainingMinor} sourceCurrency=${data.sourceCurrency} settledOn=${data.settledOn}`
          : `trip=${data.tripId} settlement=${result.settlementId} from=${data.fromUid} mode=TRIP expectedRemainingMinor=${data.expectedRemainingMinor}`,
      formatResponse: result => ({ ok: true, ...result }),
      // FOREIGN_CURRENCY calls getFxSnapshot which throws FxError on
      // future-date / provider-down / etc; without the FxError catcher the
      // route's generic catch maps it to 500 and the client UI can't
      // distinguish "FX provider down, retry later" from a real server bug.
      catchDomain: chainCatchers(
        validationErrorCatcher(SettlementValidationError),
        fxErrorCatcher(),
      ),
      // Whole body runs in one tx → every CascadeError (read-cap 503,
      // trip.currency 500) is pre-commit; stamp precommit so the client
      // rolls back instead of keeping a phantom settlement on a 5xx.
      cascadePrecommit: true,
    }),
  },
  {
    path: '/settlement-delete', rate: 'settlement-write',
    dispatch: c => handleJsonRoute({
      endpoint:    'settlement-delete', body: c.body, cors: c.cors, uid: c.uid,
      schema:      SettlementDeleteRequestSchema,
      handle:      data => settlementDelete(c.uid, data, c.env.FIREBASE_SERVICE_ACCOUNT),
      formatLog:   data => `trip=${data.tripId} settlement=${data.settlementId}`,
      catchDomain: validationErrorCatcher(SettlementValidationError),
      cascadePrecommit: true,
    }),
  },
  {
    path: '/upload-intents', rate: 'upload-intent',
    dispatch: c => handleJsonRoute({
      endpoint:  'upload-intents', body: c.body, cors: c.cors, uid: c.uid, traceId: c.traceId,
      schema:    UploadIntentsRequestSchema,
      handle:    data => createUploadIntents(c.uid, data, c.env.FIREBASE_SERVICE_ACCOUNT),
      formatLog: (data, result) =>
        `trip=${data.tripId} entity=${data.entityType}/${data.entityId} count=${result.intents.length}`,
    }),
  },
  {
    path: '/attachment-url', rate: 'attachment-url',
    dispatch: c => handleJsonRoute({
      endpoint:  'attachment-url', body: c.body, cors: c.cors, uid: c.uid,
      schema:    AttachmentUrlRequestSchema,
      handle:    data => signEntityUrl(c.uid, data, c.env.FIREBASE_SERVICE_ACCOUNT, c.env.FIREBASE_STORAGE_BUCKET),
      // entity coordinates + variant only; the minted URL is never logged.
      formatLog: data => `trip=${data.tripId} entity=${data.entityType}/${data.entityId} variant=${data.variant}`,
    }),
  },
  {
    path: '/cascade-trip-delete', rate: 'trip-cascade',
    dispatch: c => handleJsonRoute({
      endpoint:       'trip-cascade', body: c.body, cors: c.cors, uid: c.uid,
      schema:         TripDeleteRequestSchema,
      handle:         data => cascadeTripDelete(c.uid, data, c.env.FIREBASE_SERVICE_ACCOUNT, c.env.FIREBASE_STORAGE_BUCKET),
      formatLog:      (data, result) => `trip=${data.tripId} docs=${result.deletedDocs} objects=${result.deletedObjects}`,
      formatResponse: result => ({ ok: true, ...result }),
    }),
  },
  {
    path: '/invite-create', rate: 'membership',
    dispatch: c => handleJsonRoute({
      endpoint:       'invite-create', body: c.body, cors: c.cors, uid: c.uid,
      schema:         InviteCreateRequestSchema,
      handle:         data => inviteCreate(c.uid, data, c.env.FIREBASE_SERVICE_ACCOUNT),
      // Token is a fresh bearer secret -- never logged (mirrors attachment-url
      // "minted URL is never logged"). trip + role are enough to correlate.
      formatLog:      data => `trip=${data.tripId} role=${data.role}`,
      formatResponse: result => ({ ok: true, ...result }),
      catchDomain:    validationErrorCatcher(MembershipValidationError),
      // Whole body runs in one tx → every CascadeError is pre-commit; stamp
      // precommit so a 5xx rolls the optimistic invite row back.
      cascadePrecommit: true,
    }),
  },
  {
    path: '/invite-revoke', rate: 'membership',
    dispatch: c => handleJsonRoute({
      endpoint:    'invite-revoke', body: c.body, cors: c.cors, uid: c.uid,
      schema:      InviteRevokeRequestSchema,
      handle:      data => inviteRevoke(c.uid, data, c.env.FIREBASE_SERVICE_ACCOUNT),
      formatLog:   data => `trip=${data.tripId}`,
      catchDomain: validationErrorCatcher(MembershipValidationError),
      cascadePrecommit: true,
    }),
  },
  {
    path: '/invite-redeem', rate: 'membership',
    dispatch: c => handleJsonRoute({
      endpoint:       'invite-redeem', body: c.body, cors: c.cors, uid: c.uid,
      schema:         InviteRedeemRequestSchema,
      handle:         data => inviteRedeem(c.uid, data, c.env.FIREBASE_SERVICE_ACCOUNT),
      formatLog:      (data, result) => `trip=${data.tripId} outcome=${result.outcome} role=${result.role}`,
      formatResponse: result => ({ ok: true, ...result }),
      catchDomain:    validationErrorCatcher(MembershipValidationError),
    }),
  },
  {
    path: '/member-remove', rate: 'membership',
    dispatch: c => handleJsonRoute({
      endpoint:    'member-remove', body: c.body, cors: c.cors, uid: c.uid,
      schema:      MemberRemoveRequestSchema,
      handle:      data => memberRemove(c.uid, data, c.env.FIREBASE_SERVICE_ACCOUNT),
      formatLog:   data => `trip=${data.tripId} member=${uidTag(data.memberUid)}`,
      catchDomain: validationErrorCatcher(MembershipValidationError),
    }),
  },
  {
    path: '/member-leave', rate: 'membership',
    dispatch: c => handleJsonRoute({
      endpoint:    'member-leave', body: c.body, cors: c.cors, uid: c.uid,
      // Caller leaves themselves; the verified token's uid is the target.
      handle:      data => memberLeave(c.uid, data, c.env.FIREBASE_SERVICE_ACCOUNT),
      schema:      MemberLeaveRequestSchema,
      formatLog:   data => `trip=${data.tripId} member=${uidTag(c.uid)}`,
      catchDomain: validationErrorCatcher(MembershipValidationError),
    }),
  },
  {
    path: '/member-role-update', rate: 'membership',
    dispatch: c => handleJsonRoute({
      endpoint:    'member-role-update', body: c.body, cors: c.cors, uid: c.uid,
      schema:      MemberRoleUpdateRequestSchema,
      handle:      data => memberRoleUpdate(c.uid, data, c.env.FIREBASE_SERVICE_ACCOUNT),
      formatLog:   data => `trip=${data.tripId} member=${uidTag(data.memberUid)} role=${data.role}`,
      catchDomain: validationErrorCatcher(MembershipValidationError),
    }),
  },
  {
    path: '/owner-transfer', rate: 'membership',
    dispatch: c => handleJsonRoute({
      endpoint:    'owner-transfer', body: c.body, cors: c.cors, uid: c.uid,
      schema:      OwnerTransferRequestSchema,
      handle:      data => ownerTransfer(c.uid, data, c.env.FIREBASE_SERVICE_ACCOUNT),
      formatLog:   data => `trip=${data.tripId} target=${uidTag(data.targetUid)}`,
      catchDomain: validationErrorCatcher(MembershipValidationError),
    }),
  },
  {
    path: '/expense-receipt-ocr', rate: 'ocr',
    dispatch: c => handleJsonRoute({
      endpoint:  'expense-receipt-ocr', body: c.body, cors: c.cors, uid: c.uid,
      schema:    ExpenseReceiptOcrRequestSchema,
      // Re-OCR an EXISTING expense receipt: Worker reads receipt.path from
      // the doc (client can't name the object), mirrors /expense-update auth
      // (owner/editor; settlement-locked ⇒ owner), reads the image from
      // Storage, and runs the SAME extractReceiptItems core as /ocr.
      handle:    data => {
        const provider = primaryOcrProvider(c.env)
        return expenseReceiptOcr(
          c.uid,
          data,
          c.env.FIREBASE_SERVICE_ACCOUNT,
          c.env.FIREBASE_STORAGE_BUCKET,
          (image, mimeType, currency) =>
            runOcrProvider(provider, image, mimeType, currency, ocrProviderConfig(c.env)),
        )
      },
      formatLog: (data, result) => `trip=${data.tripId} exp=${data.expenseId} items=${result.result.items.length}`,
      catchDomain: ocrErrorCatcher,
    }),
  },
  {
    path: '/expense-receipt-ocr-fallback', rate: 'ocr',
    dispatch: c => handleJsonRoute({
      endpoint:  'expense-receipt-ocr-fallback', body: c.body, cors: c.cors, uid: c.uid,
      schema:    ExpenseReceiptOcrRequestSchema,
      handle:    data => {
        const provider = fallbackOcrProvider(c.env)
        if (provider === 'none') throw new OcrError('OCR fallback is disabled', 404)
        return expenseReceiptOcr(
          c.uid,
          data,
          c.env.FIREBASE_SERVICE_ACCOUNT,
          c.env.FIREBASE_STORAGE_BUCKET,
          (image, mimeType, currency) =>
            runOcrProvider(provider, image, mimeType, currency, ocrProviderConfig(c.env)),
        )
      },
      formatLog: (data, result) => `trip=${data.tripId} exp=${data.expenseId} items=${result.result.items.length}`,
      catchDomain: ocrErrorCatcher,
    }),
  },
  {
    path: '/booking-pdf-extract', rate: 'ocr',
    dispatch: c => handleJsonRoute({
      endpoint:  'booking-pdf-extract', body: c.body, cors: c.cors, uid: c.uid,
      schema:    BookingPdfExtractRequestSchema,
      // Booking confirmation import is intentionally Claude-only. Receipt OCR
      // can swap primary/fallback providers, but booking PDFs need stricter
      // document-level reasoning over labels, addresses, and evidence.
      handle:    data => extractBookingPdfFields(data, bookingPdfClaudeConfig(c.env)),
      formatLog: (_data, result) =>
        `candidates=${result.bookings.length} types=${result.bookings.map(b => b.bookingType).join(',')} fields=${bookingPdfFieldCount(result)} warnings=${result.warnings.length}`,
      catchDomain: ocrErrorCatcher,
    }),
  },
  {
    path: '/ocr', rate: 'ocr',
    dispatch: c => handleJsonRoute({
      endpoint:  'ocr', body: c.body, cors: c.cors, uid: c.uid,
      schema:    OcrRequestSchema,
      handle:    data => runConfiguredOcrProvider(c.env, primaryOcrProvider(c.env), data),
      formatLog: (_data, result) => `items=${result.items.length}`,
      catchDomain: ocrErrorCatcher,
    }),
  },
  {
    path: '/ocr-fallback', rate: 'ocr',
    dispatch: c => handleJsonRoute({
      endpoint:  'ocr-fallback', body: c.body, cors: c.cors, uid: c.uid,
      schema:    OcrRequestSchema,
      handle:    data => {
        const provider = fallbackOcrProvider(c.env)
        if (provider === 'none') throw new OcrError('OCR fallback is disabled', 404)
        return runConfiguredOcrProvider(c.env, provider, data)
      },
      formatLog: (_data, result) => `items=${result.items.length}`,
      catchDomain: ocrErrorCatcher,
    }),
  },
  {
    path: '/ocr-compare', rate: 'ocr',
    dispatch: c => handleJsonRoute({
      endpoint:  'ocr-compare', body: c.body, cors: c.cors, uid: c.uid,
      schema:    OcrRequestSchema,
      handle:    async data => {
        if (!compareEnabled(c.env)) throw new OcrError('OCR comparison is disabled', 404)
        const cfg = ocrProviderConfig(c.env)
        const [claude, qwen] = await Promise.all([
          timedOcrProvider('claude', () => runOcrProvider('claude', data.image, data.mimeType, data.currency, cfg)),
          timedOcrProvider('qwen', () => runOcrProvider('qwen', data.image, data.mimeType, data.currency, cfg)),
        ])
        return { claude, qwen }
      },
      formatLog: (_data, result) =>
        `${formatCompareResult(result.claude)} ${formatCompareResult(result.qwen)}`,
      catchDomain: ocrErrorCatcher,
    }),
  },
]

export default {
  async fetch(request, env): Promise<Response> {
    const url     = new URL(request.url)
    const cors    = corsHeaders(env, request.headers.get('Origin'))

    // ─── CORS preflight ────────────────────────────────────────────────
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors })
    }

    // ─── Routing ──────────────────────────────────────────────────────
    // One descriptor per endpoint (see ROUTES). A known path with a non-
    // POST method falls through to 404, same as the old isXxx + big-OR.
    const route = request.method === 'POST'
      ? ROUTES.find(r => r.path === url.pathname)
      : undefined
    if (!route) {
      return json({ error: 'Not found' }, 404, cors)
    }

    // Pre-validated upload-flow correlation id. Read once so every log line
    // in this request carries the same `trace=<id>` suffix. Missing or
    // malformed → undefined → no suffix; we don't reject for it
    // (observability is best-effort and a stale client shouldn't be denied).
    const traceId = extractTraceId(request)
    const trace   = traceId ? ` trace=${traceId}` : ''

    console.log(`[req] ${request.method} ${url.pathname} origin=${request.headers.get('Origin') ?? '?'}${trace}`)

    // ─── Body size guard ──────────────────────────────────────────────
    // Before auth so a 100MB unauthenticated body is rejected without
    // burning CPU on JWT verification. 9MB covers an 8MB base64 image +
    // JSON envelope; cascade / membership bodies are <1KB.
    const contentLength = Number(request.headers.get('content-length') ?? '0')
    if (contentLength > 9 * 1024 * 1024) {
      console.warn(`[body] too large: contentLength=${contentLength}${trace}`)
      return json({ error: 'Body too large' }, 413, cors)
    }

    // ─── Auth ─────────────────────────────────────────────────────────
    const token = extractBearerToken(request)
    if (!token) {
      console.warn(`[auth] no bearer token${trace}`)
      return json({ error: 'Missing Authorization' }, 401, cors)
    }
    let uid: string
    try {
      const claims = await verifyFirebaseToken(token, env.FIREBASE_PROJECT_ID)
      uid = claims.sub
      console.log(`[auth] ok uid=${uidTag(uid)}${trace}`)
    } catch (e) {
      console.warn(`[auth] invalid token: ${(e as Error).message}${trace}`)
      return json({ error: `Invalid token: ${(e as Error).message}` }, 401, cors)
    }

    // ─── Rate limit (per-uid, two-layer) ──────────────────────────────
    // L1: per-PoP binding (~0ms, single-location abuse). L2: cross-PoP
    // Durable Object (~10-50ms, strongly consistent cluster ceiling). The
    // (binding, scope, cap) triple is the route's rate class — note the
    // binding and scope are NOT 1:1 (expense / upload-intent / wish-write /
    // booking-write share EXPENSE_RATE_LIMITER but keep distinct L2 scopes).
    // After auth so unauthenticated noise doesn't burn counter slots.
    const rc = RATE_CLASSES[route.rate]
    const localResult = await env[rc.limiter].limit({ key: uid })
    if (!localResult.success) {
      console.warn(`[rate-limit] L1 deny uid=${uidTag(uid)} route=${url.pathname}${trace}`)
      return json({ error: 'Rate limit exceeded' }, 429, cors)
    }
    const globalResult = await checkGlobalRateLimit(
      env.GLOBAL_LIMITER, rc.scope, uid, rc.globalLimit, 60_000,
    )
    if (!globalResult.allowed) {
      console.warn(
        `[rate-limit] L2 deny uid=${uidTag(uid)} route=${url.pathname} ` +
        `count=${globalResult.count} resetMs=${globalResult.resetMs}${trace}`,
      )
      return json({ error: 'Global rate limit exceeded' }, 429, cors)
    }

    // ─── Body parsing ─────────────────────────────────────────────────
    let body: unknown
    try {
      body = await request.json()
    } catch {
      console.warn(`[body] not valid JSON${trace}`)
      return json({ error: 'Invalid JSON' }, 400, cors)
    }

    // ─── Dispatch ─────────────────────────────────────────────────────
    // Per-route variation (schema / handle / formatLog / catchDomain /
    // cascadePrecommit) lives in the descriptor; auth + rate-limit + body
    // size were handled above. See route-dispatch.ts for the wrapper.
    return route.dispatch({ body, cors, uid, traceId, env })
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
    // Storage-class maintenance: token scrubber + Level 4 orphan-blob
    // reconciliation, run SEQUENTIALLY inside one waitUntil so they share
    // a single subrequest-budget envelope rather than two parallel tasks
    // racing the invocation's ~1000-subrequest pool. The scrubber strips
    // leftover firebaseStorageDownloadTokens (never-consumed / bypass
    // backstop, no 24h grace); the orphan scan deletes unreferenced blobs
    // (24h grace + entity recheck). Each pass is independently best-effort.
    console.log('[cron] storage-maintenance starting')
    ctx.waitUntil(
      // sentryEnv passed through to the orphan scan's abuse-detection
      // branch; sentry.ts no-ops when SENTRY_DSN is empty, so always safe.
      runStorageMaintenance(env.FIREBASE_SERVICE_ACCOUNT, env.FIREBASE_STORAGE_BUCKET, { sentryEnv: env })
        .then(({ scrub, orphan }) => {
          const scrubLine = scrub
            ? `scrub{scanned=${scrub.scanned} scrubbed=${scrub.scrubbed} ` +
              `errors=${scrub.scrubErrors} budgetHit=${scrub.budgetHit} deadlineHit=${scrub.deadlineHit}}`
            : 'scrub{failed}'
          let orphanLine = 'orphan{failed}'
          if (orphan) {
            // Top-3 uids so operators see attribution without digging Sentry.
            const topUids = Object.entries(orphan.orphansByUid)
              .sort(([, a], [, b]) => b - a)
              .slice(0, 3)
              .map(([uid, n]) => `${uid}=${n}`)
              .join(',') || 'none'
            orphanLine =
              `orphan{scanned=${orphan.scanned} deleted=${orphan.deleted} ` +
              `referenced=${orphan.referenced} freshSkipped=${orphan.freshSkipped} ` +
              `unparseable=${orphan.unparseable} readErrors=${orphan.readErrors} ` +
              `deleteErrors=${orphan.deleteErrors} deadlineHit=${orphan.deadlineHit} ` +
              `budgetHit=${orphan.budgetHit} topUids=${topUids}}`
          }
          console.log(`[cron] storage-maintenance done ${scrubLine} ${orphanLine}`)
        })
        .catch(err => {
          console.error(`[cron] storage-maintenance failed: ${(err as Error).message}`)
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
