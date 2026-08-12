// TripMate OCR Worker — entry point.
//
// Endpoints:
//   POST /ocr                  — Qwen receipt OCR (default product path)
//   POST /booking-pdf-extract  — Qwen structured extraction from
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
//   POST /upload-intents       — mint Worker-issued canonical R2 upload intents.
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
  RECEIPT_OCR_PROVIDERS,
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
import { sweepWishVotingDeadlines }               from './wish-deadline-sweep'
import {
  expenseCreate, expenseUpdate,
  ExpenseCreateRequestSchema, ExpenseUpdateRequestSchema,
}                                                 from './expense-write'
import { ExpenseValidationError }                 from './expense-validate'
import {
  wishFileCreate,
  wishFileUpdate,
  wishDelete,
  WishFileCreateRequestSchema,
  WishFileUpdateRequestSchema,
  WishDeleteRequestSchema,
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
  pdfPageLimitMessage,
  pdfPageLimitStatus,
}                                                 from '@tripmate/pdf-page-limit'
import {
  handleAttachmentUpload,
  handleAttachmentContent,
  handleAttachmentDelete,
  ATTACHMENT_PATH_HEADER,
  ATTACHMENT_TRIP_HEADER,
}                                                 from './attachment-content'
import { checkGlobalRateLimit }                   from './rate-limiter'
import {
  autocompleteRoutePlace,
  previewRoute,
  resolveRoutePlaceForTrip,
  routeProviderErrorCatcher,
  routeValidationErrorCatcher,
}                                                 from './route-preview'
import { applyRoute, routeApplyErrorCatcher, routeApplyStatus } from './route-apply'
import {
  RouteApplyRequestSchema,
  RouteApplyStatusRequestSchema,
  RouteAutocompleteRequestSchema,
  RoutePreviewRequestSchema,
  RouteResolvePlaceRequestSchema,
}                                                 from './route-schema'
import {
  handleJsonRoute,
  validationErrorCatcher,
  fxErrorCatcher,
  chainCatchers,
  extractTraceId,
  UPLOAD_TRACE_HEADER,
  json,
  uidTag,
}                                                 from './route-dispatch'
import { captureMessage, serializeErrorChain, type ReportWorkerError } from './sentry'

export { GlobalRateLimiter } from './rate-limiter'

type WorkerEnv = Env & {
  ANTHROPIC_FOUNDRY_API_KEY: string // secret — Microsoft Foundry (Azure AI Foundry) Claude API key
  FIREBASE_SERVICE_ACCOUNT: string  // secret — JSON string of service account key
  QWEN_API_KEY:             string  // secret; OpenAI-compatible Qwen provider API key
  GEOAPIFY_API_KEY?:        string  // secret
  ORS_API_KEY?:             string  // secret
  ROUTE_PREVIEW_HMAC_SECRET?: string // secret
  /** Sentry DSN for Worker-side telemetry (abuse alerts + the generic-500
   *  and cron-failure reporting). Same DSN as the frontend's
   *  VITE_SENTRY_DSN -- events land in the same project, filterable by
   *  `server_name: 'tripmate-ocr'`. Optional because it is a SECRET, not a
   *  var (`wrangler secret put SENTRY_DSN`): absent in local dev and
   *  preview, where captureMessage no-ops. */
  SENTRY_DSN?:              string
  /** Per-PoP per-uid rate limiter for the OCR endpoint. Cheap first-line
   *  filter (~0ms). Counters are local to each Cloudflare location. */
  /** Per-PoP per-uid rate limiter for the member-cascade endpoint. */
  /** Per-PoP per-uid rate limiter for the trip-delete endpoint.
   *  Tighter than member cascade because trip-delete is heavy
   *  (O(100) docs + R2 purge per call). */
  /** Per-PoP per-uid rate limiter for expense create/update. Same
   *  cap as OCR (30/min) -- one expense per ~2s sustained covers
   *  rapid form retries without blowing through Firestore admin
   *  write quotas. */
  /** Per-PoP per-uid rate limiter for settlement create/delete.
   *  Tighter (5/min) than expense -- settlement is a clicked-button
   *  rare event, and create runs a full pairwise debt computation
   *  (tx + 2 runQuery reads) per request. */
  /** Cross-PoP global rate limiter. Durable Object — strongly
   *  consistent counter per-uid that catches multi-PoP abuse that
   *  would slip past the per-PoP binding. ~10-50ms latency cost. */
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
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    // UPLOAD_TRACE_HEADER is a custom (non-CORS-safelisted) request
    // header set by mintAndUploadEntityIntents; without it on this
    // allow-list, browsers reject the preflight for every upload-flow
    // endpoint (/upload-intents, /expense-*, /booking-file-*,
    // /wish-file-*). Sourced from the same constant the server uses
    // to read the header so the two stay in lockstep.
    'Access-Control-Allow-Headers': [
      'Authorization', 'Content-Type', UPLOAD_TRACE_HEADER,
      ATTACHMENT_TRIP_HEADER, ATTACHMENT_PATH_HEADER,
    ].join(', '),
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
 *  re-buckets live counters, so treat these strings as a wire contract.
 *
 *  Effective capacity is the intersection of both layers, not the L2 number
 *  alone. In particular attachment-content is L1 600/min per PoP + L2
 *  900/min cross-PoP; attachment-delete is L1 60/min + L2 120/min. The
 *  tighter per-PoP cap is intentional abuse containment. */
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
  'attachment-upload': { limiter: 'ATTACHMENT_UPLOAD_RATE_LIMITER', scope: 'attachment-upload', globalLimit: 60 },
  'attachment-content': { limiter: 'ATTACHMENT_CONTENT_RATE_LIMITER', scope: 'attachment-content', globalLimit: 900 },
  'attachment-delete': { limiter: 'ATTACHMENT_DELETE_RATE_LIMITER', scope: 'attachment-delete', globalLimit: 120 },
  'route-search':     { limiter: 'ROUTE_SEARCH_RATE_LIMITER',    scope: 'route-search',     globalLimit: 60 },
  'route-preview':    { limiter: 'ROUTE_PREVIEW_RATE_LIMITER',   scope: 'route-preview',    globalLimit: 10 },
  'route-write':      { limiter: 'ROUTE_WRITE_RATE_LIMITER',     scope: 'route-write',      globalLimit: 10 },
  membership:         { limiter: 'CASCADE_RATE_LIMITER',        scope: 'cascade',          globalLimit: 10 },
} as const satisfies Record<string, RateClass>

type RateClassKey = keyof typeof RATE_CLASSES

/** Request-scoped values threaded into each route's dispatch closure. */
interface DispatchCtx {
  body:    unknown
  request: Request
  cors:    Record<string, string>
  uid:     string
  traceId: string | undefined
  env:     WorkerEnv
  executionCtx: ExecutionContext
  requestUrl: string
  /** Pre-bound to this request's endpoint / uid / trace. Routes call it
   *  without touching env or executionCtx. */
  report:  ReportWorkerError
}

interface RouteDescriptor {
  /** Exact pathname. Existing routes default to POST. */
  path:     string
  method?:  'GET' | 'POST'
  /** Existing routes default to JSON. Raw/none routes never consume JSON. */
  bodyMode?: 'json' | 'raw' | 'none'
  /** Rate class → (L1 binding, L2 scope, L2 cap). */
  rate:     RateClassKey
  /** Per-route parse → handle → catch, wrapped by handleJsonRoute. */
  dispatch: (c: DispatchCtx) => Response | Promise<Response>
}

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

function runConfiguredOcrProvider(env: WorkerEnv, provider: OcrProvider, data: OcrRequest): Promise<OcrResponse> {
  return runOcrProvider(provider, data.image, data.mimeType, data.currency, ocrProviderConfig(env))
}

function clientSafeOcrError(status: number): string {
  if (status === 400) return 'OCR request was rejected'
  if (status === 429) return 'OCR provider is rate limited'
  if (status === 422) return 'OCR provider could not parse the input'
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
          error: pdfPageLimitMessage(e.code, MAX_PDF_PAGES),
          code: e.code,
          maxPages: MAX_PDF_PAGES,
          ...(e.pageCount !== undefined ? { pageCount: e.pageCount } : {}),
          retryable: false,
        },
        status: pdfPageLimitStatus(e.code),
      }
    : null
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
    path: '/attachment-upload', rate: 'attachment-upload', bodyMode: 'raw',
    dispatch: c => handleAttachmentUpload({
      request: c.request, uid: c.uid, cors: c.cors, traceId: c.traceId, env: c.env, report: c.report,
    }),
  },
  {
    path: '/attachment-content', method: 'GET', bodyMode: 'none', rate: 'attachment-content',
    dispatch: c => handleAttachmentContent({
      request: c.request, uid: c.uid, cors: c.cors, traceId: c.traceId, env: c.env, report: c.report,
    }),
  },
  {
    path: '/attachment-delete', rate: 'attachment-delete',
    dispatch: c => handleAttachmentDelete({
      body: c.body, uid: c.uid, cors: c.cors, traceId: c.traceId, env: c.env, report: c.report,
    }),
  },
  {
    path: '/expense-create', rate: 'expense',
    dispatch: c => handleJsonRoute({
      endpoint:       'expense-create', body: c.body, cors: c.cors, uid: c.uid, report: c.report, traceId: c.traceId,
      schema:         ExpenseCreateRequestSchema,
      handle:         data => expenseCreate(c.uid, data, c.env.FIREBASE_SERVICE_ACCOUNT, c.env.ATTACHMENTS),
      formatLog:      (data, result) => `trip=${data.tripId} exp=${result.expenseId}`,
      formatResponse: result => ({ ok: true, ...result }),
      // FOREIGN_CURRENCY path calls getFxSnapshot → FxError on future
      // settledOn / Frankfurter degraded; chain in fxErrorCatcher so the
      // route returns the actionable 4xx/5xx instead of a generic 500.
      catchDomain: chainCatchers(
        validationErrorCatcher(ExpenseValidationError),
        fxErrorCatcher(),
        pdfPageLimitErrorCatcher(),
      ),
    }),
  },
  {
    path: '/expense-update', rate: 'expense',
    dispatch: c => handleJsonRoute({
      endpoint:    'expense-update', body: c.body, cors: c.cors, uid: c.uid, report: c.report, traceId: c.traceId,
      schema:      ExpenseUpdateRequestSchema,
      handle:      data => expenseUpdate(c.uid, data, c.env.FIREBASE_SERVICE_ACCOUNT, c.env.ATTACHMENTS),
      formatLog:   data => `trip=${data.tripId} exp=${data.expenseId}`,
      // Same FX-touch + chain as expense-create above.
      catchDomain: chainCatchers(
        validationErrorCatcher(ExpenseValidationError),
        fxErrorCatcher(),
        pdfPageLimitErrorCatcher(),
      ),
    }),
  },
  {
    path: '/wish-file-create', rate: 'wish-write',
    dispatch: c => handleJsonRoute({
      endpoint:       'wish-file-create', body: c.body, cors: c.cors, uid: c.uid, report: c.report, traceId: c.traceId,
      schema:         WishFileCreateRequestSchema,
      handle:         data => wishFileCreate(c.uid, data, c.env.FIREBASE_SERVICE_ACCOUNT, c.env.ATTACHMENTS),
      formatLog:      (data, result) => `trip=${data.tripId} wish=${result.wishId}`,
      formatResponse: result => ({ ok: true, ...result }),
      catchDomain:    validationErrorCatcher(WishValidationError),
    }),
  },
  {
    path: '/wish-file-update', rate: 'wish-write',
    dispatch: c => handleJsonRoute({
      endpoint:    'wish-file-update', body: c.body, cors: c.cors, uid: c.uid, report: c.report, traceId: c.traceId,
      schema:      WishFileUpdateRequestSchema,
      handle:      data => wishFileUpdate(c.uid, data, c.env.FIREBASE_SERVICE_ACCOUNT, c.env.ATTACHMENTS),
      formatLog:   data => `trip=${data.tripId} wish=${data.wishId}`,
      catchDomain: validationErrorCatcher(WishValidationError),
    }),
  },
  {
    // No cascadePrecommit: the R2 purge runs AFTER the transaction commits,
    // so a failure there is not proof the wish survived. The generic 500
    // keeps the client's optimistic removal in place for the listener to
    // confirm, which is the correct reading — the delete did happen.
    path: '/wish-delete', rate: 'wish-write',
    dispatch: c => handleJsonRoute({
      endpoint:    'wish-delete', body: c.body, cors: c.cors, uid: c.uid, report: c.report, traceId: c.traceId,
      schema:      WishDeleteRequestSchema,
      handle:      data => wishDelete(c.uid, data, c.env.FIREBASE_SERVICE_ACCOUNT, c.env.ATTACHMENTS),
      formatLog:   data => `trip=${data.tripId} wish=${data.wishId}`,
      catchDomain: validationErrorCatcher(WishValidationError),
    }),
  },
  {
    path: '/booking-file-create', rate: 'booking-write',
    dispatch: c => handleJsonRoute({
      endpoint:       'booking-file-create', body: c.body, cors: c.cors, uid: c.uid, report: c.report, traceId: c.traceId,
      schema:         BookingFileCreateRequestSchema,
      handle:         data => bookingFileCreate(c.uid, data, c.env.FIREBASE_SERVICE_ACCOUNT, c.env.ATTACHMENTS),
      formatLog:      (data, result) => `trip=${data.tripId} booking=${result.bookingId}`,
      formatResponse: result => ({ ok: true, ...result }),
      catchDomain:    chainCatchers(
        validationErrorCatcher(BookingValidationError),
        pdfPageLimitErrorCatcher(),
      ),
    }),
  },
  {
    path: '/booking-file-update', rate: 'booking-write',
    dispatch: c => handleJsonRoute({
      endpoint:    'booking-file-update', body: c.body, cors: c.cors, uid: c.uid, report: c.report, traceId: c.traceId,
      schema:      BookingFileUpdateRequestSchema,
      handle:      data => bookingFileUpdate(c.uid, data, c.env.FIREBASE_SERVICE_ACCOUNT, c.env.ATTACHMENTS),
      formatLog:   data => `trip=${data.tripId} booking=${data.bookingId}`,
      catchDomain: chainCatchers(
        validationErrorCatcher(BookingValidationError),
        pdfPageLimitErrorCatcher(),
      ),
    }),
  },
  {
    path: '/settlement-create', rate: 'settlement-write',
    dispatch: c => handleJsonRoute({
      endpoint:       'settlement-create', body: c.body, cors: c.cors, uid: c.uid, report: c.report,
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
      endpoint:    'settlement-delete', body: c.body, cors: c.cors, uid: c.uid, report: c.report,
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
      endpoint:  'upload-intents', body: c.body, cors: c.cors, uid: c.uid, report: c.report, traceId: c.traceId,
      schema:    UploadIntentsRequestSchema,
      handle:    data => createUploadIntents(c.uid, data, c.env.FIREBASE_SERVICE_ACCOUNT),
      formatLog: (data, result) =>
        `trip=${data.tripId} entity=${data.entityType}/${data.entityId} count=${result.intents.length}`,
    }),
  },
  {
    path: '/cascade-trip-delete', rate: 'trip-cascade',
    dispatch: c => handleJsonRoute({
      endpoint:       'trip-cascade', body: c.body, cors: c.cors, uid: c.uid, report: c.report,
      schema:         TripDeleteRequestSchema,
      handle:         data => cascadeTripDelete(c.uid, data, c.env.FIREBASE_SERVICE_ACCOUNT, c.env.ATTACHMENTS),
      formatLog:      (data, result) => `trip=${data.tripId} docs=${result.deletedDocs} objects=${result.deletedObjects}`,
      formatResponse: result => ({ ok: true, ...result }),
    }),
  },
  {
    path: '/invite-create', rate: 'membership',
    dispatch: c => handleJsonRoute({
      endpoint:       'invite-create', body: c.body, cors: c.cors, uid: c.uid, report: c.report,
      schema:         InviteCreateRequestSchema,
      handle:         data => inviteCreate(c.uid, data, c.env.FIREBASE_SERVICE_ACCOUNT),
      // Token is a fresh bearer secret -- never log it. Trip + role are
      // enough to correlate the request.
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
      endpoint:    'invite-revoke', body: c.body, cors: c.cors, uid: c.uid, report: c.report,
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
      endpoint:       'invite-redeem', body: c.body, cors: c.cors, uid: c.uid, report: c.report,
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
      endpoint:    'member-remove', body: c.body, cors: c.cors, uid: c.uid, report: c.report,
      schema:      MemberRemoveRequestSchema,
      handle:      data => memberRemove(c.uid, data, c.env.FIREBASE_SERVICE_ACCOUNT),
      formatLog:   data => `trip=${data.tripId} member=${uidTag(data.memberUid)}`,
      catchDomain: validationErrorCatcher(MembershipValidationError),
    }),
  },
  {
    path: '/member-leave', rate: 'membership',
    dispatch: c => handleJsonRoute({
      endpoint:    'member-leave', body: c.body, cors: c.cors, uid: c.uid, report: c.report,
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
      endpoint:    'member-role-update', body: c.body, cors: c.cors, uid: c.uid, report: c.report,
      schema:      MemberRoleUpdateRequestSchema,
      handle:      data => memberRoleUpdate(c.uid, data, c.env.FIREBASE_SERVICE_ACCOUNT),
      formatLog:   data => `trip=${data.tripId} member=${uidTag(data.memberUid)} role=${data.role}`,
      catchDomain: validationErrorCatcher(MembershipValidationError),
    }),
  },
  {
    path: '/owner-transfer', rate: 'membership',
    dispatch: c => handleJsonRoute({
      endpoint:    'owner-transfer', body: c.body, cors: c.cors, uid: c.uid, report: c.report,
      schema:      OwnerTransferRequestSchema,
      handle:      data => ownerTransfer(c.uid, data, c.env.FIREBASE_SERVICE_ACCOUNT),
      formatLog:   data => `trip=${data.tripId} target=${uidTag(data.targetUid)}`,
      catchDomain: validationErrorCatcher(MembershipValidationError),
    }),
  },
  {
    path: '/expense-receipt-ocr', rate: 'ocr',
    dispatch: c => handleJsonRoute({
      endpoint:  'expense-receipt-ocr', body: c.body, cors: c.cors, uid: c.uid, report: c.report,
      schema:    ExpenseReceiptOcrRequestSchema,
      // Re-OCR an EXISTING expense receipt: Worker reads receipt.path from
      // the doc (client can't name the object), mirrors /expense-update auth
      // (owner/editor; settlement-locked ⇒ owner), reads the image from
      // Storage, and runs the SAME extractReceiptItems core as /ocr.
      handle:    data => {
        const provider = RECEIPT_OCR_PROVIDERS.primary
        return expenseReceiptOcr(
          c.uid,
          data,
          c.env.FIREBASE_SERVICE_ACCOUNT,
          c.env.ATTACHMENTS,
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
      endpoint:  'expense-receipt-ocr-fallback', body: c.body, cors: c.cors, uid: c.uid, report: c.report,
      schema:    ExpenseReceiptOcrRequestSchema,
      handle:    data => {
        const provider = RECEIPT_OCR_PROVIDERS.fallback
        return expenseReceiptOcr(
          c.uid,
          data,
          c.env.FIREBASE_SERVICE_ACCOUNT,
          c.env.ATTACHMENTS,
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
      endpoint:  'booking-pdf-extract', body: c.body, cors: c.cors, uid: c.uid, report: c.report,
      schema:    BookingPdfExtractRequestSchema,
      // Booking confirmation import shares the primary Qwen deployment while
      // keeping its own strict schema, evidence checks, and normalization.
      handle:    data => extractBookingPdfFields(data, ocrProviderConfig(c.env).qwen),
      formatLog: (_data, result) =>
        `candidates=${result.bookings.length} types=${result.bookings.map(b => b.bookingType).join(',')} fields=${bookingPdfFieldCount(result)} warnings=${result.warnings.length}`,
      catchDomain: ocrErrorCatcher,
    }),
  },
  {
    path: '/ocr', rate: 'ocr',
    dispatch: c => handleJsonRoute({
      endpoint:  'ocr', body: c.body, cors: c.cors, uid: c.uid, report: c.report,
      schema:    OcrRequestSchema,
      handle:    data => runConfiguredOcrProvider(c.env, RECEIPT_OCR_PROVIDERS.primary, data),
      formatLog: (_data, result) => `items=${result.items.length}`,
      catchDomain: ocrErrorCatcher,
    }),
  },
  {
    path: '/ocr-fallback', rate: 'ocr',
    dispatch: c => handleJsonRoute({
      endpoint:  'ocr-fallback', body: c.body, cors: c.cors, uid: c.uid, report: c.report,
      schema:    OcrRequestSchema,
      handle:    data => runConfiguredOcrProvider(c.env, RECEIPT_OCR_PROVIDERS.fallback, data),
      formatLog: (_data, result) => `items=${result.items.length}`,
      catchDomain: ocrErrorCatcher,
    }),
  },
  {
    path: '/route-autocomplete', rate: 'route-search',
    dispatch: c => handleJsonRoute({
      endpoint: 'route-autocomplete', body: c.body, cors: c.cors, uid: c.uid, report: c.report,
      schema: RouteAutocompleteRequestSchema,
      handle: data => autocompleteRoutePlace(c.uid, data, c.env.FIREBASE_SERVICE_ACCOUNT, c.env.FIREBASE_PROJECT_ID, c.env),
      formatLog: (_data, result) => `candidates=${result.length}`,
      catchDomain: chainCatchers(
        routeProviderErrorCatcher,
        routeValidationErrorCatcher,
      ),
    }),
  },
  {
    path: '/route-resolve-place', rate: 'route-search',
    dispatch: c => handleJsonRoute({
      endpoint: 'route-resolve-place', body: c.body, cors: c.cors, uid: c.uid, report: c.report,
      schema: RouteResolvePlaceRequestSchema,
      handle: data => resolveRoutePlaceForTrip(c.uid, data, c.env.FIREBASE_SERVICE_ACCOUNT, c.env.FIREBASE_PROJECT_ID, c.env),
      formatLog: (_data, result) => `candidates=${result.candidates.length}`,
      catchDomain: chainCatchers(
        routeProviderErrorCatcher,
        routeValidationErrorCatcher,
      ),
    }),
  },
  {
    path: '/route-preview', rate: 'route-preview',
    dispatch: c => handleJsonRoute({
      endpoint: 'route-preview', body: c.body, cors: c.cors, uid: c.uid, report: c.report,
      schema: RoutePreviewRequestSchema,
      handle: data => previewRoute(
        c.uid,
        data,
        c.env.FIREBASE_SERVICE_ACCOUNT,
        c.env.FIREBASE_PROJECT_ID,
        c.env,
        {
          cache: caches.default,
          cacheOrigin: c.requestUrl,
          waitUntil: promise => c.executionCtx.waitUntil(promise),
        },
      ),
      formatLog: (_data, result) => `revision=${result.previewRevision} legs=${result.legs.length} canApply=${result.canApply}`,
      catchDomain: chainCatchers(
        routeProviderErrorCatcher,
        routeValidationErrorCatcher,
      ),
    }),
  },
  {
    path: '/route-apply', rate: 'route-write',
    dispatch: c => handleJsonRoute({
      endpoint: 'route-apply', body: c.body, cors: c.cors, uid: c.uid, report: c.report,
      schema: RouteApplyRequestSchema,
      handle: data => applyRoute(c.uid, data, c.env.FIREBASE_SERVICE_ACCOUNT, c.env.FIREBASE_PROJECT_ID, c.env.ROUTE_PREVIEW_HMAC_SECRET),
      formatLog: (_data, result) => `revision=${result.revision} status=${result.status}`,
      catchDomain: routeApplyErrorCatcher,
      cascadePrecommit: true,
    }),
  },
  {
    path: '/route-apply-status', rate: 'route-write',
    dispatch: c => handleJsonRoute({
      endpoint: 'route-apply-status', body: c.body, cors: c.cors, uid: c.uid, report: c.report,
      schema: RouteApplyStatusRequestSchema,
      handle: data => routeApplyStatus(c.uid, data, c.env.FIREBASE_SERVICE_ACCOUNT, c.env.FIREBASE_PROJECT_ID),
      formatLog: (_data, result) => `revision=${result.revision} status=${result.status}`,
      catchDomain: routeApplyErrorCatcher,
      cascadePrecommit: true,
    }),
  },
]

// Two independent schedules on the same Worker (wrangler.jsonc
// triggers.crons) — scheduled() below branches on event.cron so the
// 5-min Wish-deadline sweep never also fires the daily maintenance jobs
// (and vice versa).
const DAILY_MAINTENANCE_CRON = '0 3 * * *'
const WISH_DEADLINE_SWEEP_CRON = '*/5 * * * *'

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url     = new URL(request.url)
    const cors    = corsHeaders(env, request.headers.get('Origin'))

    // ─── CORS preflight ────────────────────────────────────────────────
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors })
    }

    // ─── Routing ──────────────────────────────────────────────────────
    // One descriptor per endpoint (see ROUTES). A known path with a non-
    // POST method falls through to 404, same as the old isXxx + big-OR.
    const route = ROUTES.find(r =>
      r.path === url.pathname && (r.method ?? 'POST') === request.method,
    )
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
    let body: unknown = undefined
    if ((route.bodyMode ?? 'json') === 'json') {
      try {
        body = await request.json()
      } catch {
        console.warn(`[body] not valid JSON${trace}`)
        return json({ error: 'Invalid JSON' }, 400, cors)
      }
    }

    // ─── Dispatch ─────────────────────────────────────────────────────
    // Per-route variation (schema / handle / formatLog / catchDomain /
    // cascadePrecommit) lives in the descriptor; auth + rate-limit + body
    // size were handled above. See route-dispatch.ts for the wrapper.
    // Bound once here so every route reports with the same tags and the
    // POST survives the response via waitUntil. captureMessage no-ops on
    // an unset DSN, so local dev and preview stay silent without a branch.
    const report: ReportWorkerError = (message, extra) => {
      ctx.waitUntil(captureMessage(env, message, 'error', {
        endpoint: url.pathname,
        uid:      uidTag(uid),
        ...(traceId ? { trace: traceId } : {}),
      }, extra))
    }

    return route.dispatch({
      body, request, cors, uid, traceId, env, executionCtx: ctx, requestUrl: request.url, report,
    })
  },

  // ─── Cron dispatch ──────────────────────────────────────────────────
  // Two schedules share this Worker (see wrangler.jsonc triggers.crons):
  // the 5-min Wish-deadline sweep and the daily maintenance batch below.
  // Branch on event.cron so neither ever runs the other's jobs.
  async scheduled(event, env, ctx): Promise<void> {
    // Crons stay best-effort — a failure never throws, because tomorrow's
    // pass re-converges on whatever this one missed. That also means the
    // console line was the only trace a failing job left, and nobody reads
    // it unless they are already tailing. Every job funnels its failure
    // through here so the log line and the Sentry event stay in step.
    const reportCronFailure = (job: string, err: unknown): void => {
      const e = err instanceof Error ? err : new Error(String(err))
      console.error(`[cron] ${job} failed: ${e.message}`)
      ctx.waitUntil(captureMessage(
        env, `[cron] ${job} ${e.message}`, 'error',
        { endpoint: `cron:${job}` }, { error: serializeErrorChain(e) },
      ))
    }

    if (event.cron === WISH_DEADLINE_SWEEP_CRON) {
      console.log('[cron] wish-deadline-sweep starting')
      ctx.waitUntil(
        sweepWishVotingDeadlines(env.FIREBASE_SERVICE_ACCOUNT)
          .then(report => {
            console.log(
              `[cron] wish-deadline-sweep done scanned=${report.scanned} ` +
              `notified=${report.notified} deadlineHit=${report.deadlineHit}`,
            )
          })
          .catch(err => reportCronFailure('wish-deadline-sweep', err)),
      )
      return
    }

    if (event.cron !== DAILY_MAINTENANCE_CRON) {
      console.warn(`[cron] unrecognized cron trigger: ${event.cron}`)
      return
    }

    // ─── Cron: 10-day receipt purge ───────────────────────────────────
    // Triggered daily UTC 03:00 (see wrangler.jsonc triggers.crons).
    // Soft deadline (~14min) lives inside purgeExpiredReceipts; whatever
    // doesn't process gets picked up tomorrow — the deletedAt < cutoff
    // filter is naturally idempotent across runs.
    console.log('[cron] receipt-purge starting')
    ctx.waitUntil(
      purgeExpiredReceipts(env.FIREBASE_SERVICE_ACCOUNT, env.ATTACHMENTS)
        .then(report => {
          console.log(
            `[cron] receipt-purge done scanned=${report.scanned} ` +
            `receiptsDeleted=${report.receiptsDeleted} docsPatched=${report.docsPatched} ` +
            `deadlineHit=${report.deadlineHit}`,
          )
        })
        .catch(err => reportCronFailure('receipt-purge', err)),
    )
    // Orphan-blob queue drain. Independent from receipt-purge (different
    // invariant): receipt-purge sweeps soft-deleted-expense receipts
    // after the 10-day window; orphan-purge drains the _purges queue
    // written by best-effort cleanup paths that gave up. Runs in
    // parallel via separate waitUntil so a failure in one doesn't
    // starve the other.
    console.log('[cron] orphan-purge starting')
    ctx.waitUntil(
      drainOrphanPurges(env.FIREBASE_SERVICE_ACCOUNT, env.ATTACHMENTS)
        .then(report => {
          console.log(
            `[cron] orphan-purge done scanned=${report.scanned} ` +
            `blobsDeleted=${report.blobsDeleted} falseOrphans=${report.falseOrphans} ` +
            `giveUps=${report.giveUps} deadlineHit=${report.deadlineHit}`,
          )
        })
        .catch(err => reportCronFailure('orphan-purge', err)),
    )
    // Storage-class maintenance: token scrubber + Level 4 orphan-blob
    // reconciliation, run SEQUENTIALLY inside one waitUntil so they share
    // a single subrequest-budget envelope rather than parallel tasks racing
    // the invocation's ~1000-subrequest pool. R2 has no Firebase download
    // tokens, so maintenance only performs verify-before-delete orphan scan.
    console.log('[cron] storage-maintenance starting')
    ctx.waitUntil(
      // sentryEnv passed through to the orphan scan's abuse-detection
      // branch; sentry.ts no-ops when SENTRY_DSN is empty, so always safe.
      runStorageMaintenance(env.FIREBASE_SERVICE_ACCOUNT, env.ATTACHMENTS, { sentryEnv: env })
        .then(({ orphan }) => {
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
          console.log(`[cron] storage-maintenance done ${orphanLine}`)
        })
        .catch(err => reportCronFailure('storage-maintenance', err)),
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
            `deletedPending=${report.deletedPending} deletedUploaded=${report.deletedUploaded} ` +
            `deletedUsed=${report.deletedUsed} ` +
            `deleteErrors=${report.deleteErrors} ` +
            `deadlineHit=${report.deadlineHit} budgetHit=${report.budgetHit}`,
          )
        })
        .catch(err => reportCronFailure('upload-intent-purge', err)),
    )
  },
} satisfies ExportedHandler<WorkerEnv>
