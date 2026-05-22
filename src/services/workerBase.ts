// src/services/workerBase.ts
// Cloudflare Worker access surface. Two related concerns live here:
//
//   1. Base URL resolution (read vs write) -- env-config preflight
//      with separate strictness per failure-mode class.
//   2. `workerFetch` HTTP wrapper -- single chokepoint for every
//      Worker write call (expense create/update, cascade-trip-delete,
//      cascade-member). Centralises: auth-token-as-explicit-param,
//      AbortSignal.timeout, WorkerRejected vs WorkerAmbiguous error
//      discrimination. Each caller's catch routes on these typed
//      errors to decide rollback vs cron-deferred verify.
//
// Cloudflare Worker base URL access. Split into two surfaces because
// the failure modes differ:
//
//   1. Read-only OCR (Gemini extraction). Hitting prod from a preview
//      build is a minor cost / rate-limit pollution issue -- no data
//      mutation. Fallback to prod is acceptable.
//
//   2. Mutating endpoints (expense-create / expense-update / cascade-
//      trip-delete / cascade-member). These use the
//      Worker's admin service-account to write Firestore directly,
//      BYPASSING firestore.rules. If a preview deploy forgets to set
//      VITE_WORKER_BASE_URL, falling back to the prod Worker means
//      preview-branch UI writes through the prod admin SDK against
//      prod Firestore -- the exact cross-environment data risk the
//      single-Firebase-project setup leaves open. Mutating calls
//      MUST go through requireWorkerWriteBase(), which throws when
//      the env is unset.
//
// Trailing slash is normalised away: CF Workers route on exact path
// match, so `https://x.dev/` + `/expense-create` would become
// `//expense-create` and 404. Strip both the env value and the
// hardcoded fallback so `'/' + endpoint` always lands cleanly.

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s
}

const FALLBACK = stripTrailingSlash('https://tripmate-ocr.tripmate.workers.dev')

/** Strict source for WRITE endpoints. Reads ONLY `VITE_WORKER_BASE_URL`
 *  -- the legacy `VITE_OCR_API_URL` is deliberately not consulted here.
 *  A stale preview env that still has `VITE_OCR_API_URL=<prod>` left
 *  over from the pre-rename setup would otherwise sneak past the
 *  no-fallback gate and route admin-SDK writes against prod data. */
const WRITE_RAW = stripTrailingSlash(
  ((import.meta.env.VITE_WORKER_BASE_URL as string | undefined)?.trim() ?? ''),
)

/** Permissive source for READ-ONLY OCR. Honors the legacy
 *  `VITE_OCR_API_URL` so existing dev / preview envs that haven't
 *  flipped to the new name still get a working OCR endpoint. The
 *  worst case here is OCR pollution against the prod Worker (cost /
 *  rate-limit, no Firestore writes), which we accept. */
const READ_RAW = WRITE_RAW || stripTrailingSlash(
  ((import.meta.env.VITE_OCR_API_URL as string | undefined)?.trim() ?? ''),
)

/** Read-only Worker base URL (OCR). Falls back to the prod URL if env
 *  is unset -- safe for Gemini receipt extraction, which doesn't touch
 *  Firestore. */
export const WORKER_BASE_URL: string = READ_RAW || FALLBACK

/**
 * Worker base URL for MUTATING endpoints. Throws when
 * `VITE_WORKER_BASE_URL` is unset so a misconfigured preview / staging
 * deploy cannot silently fall back to production and issue admin-SDK
 * writes against prod data.
 *
 * The legacy `VITE_OCR_API_URL` is intentionally NOT consulted as a
 * fallback here -- a preview env that still has the old name set to
 * the prod URL (from a pre-rename deploy) would otherwise bypass the
 * gate and corrupt prod Firestore.
 *
 * Honest deploys never see this throw: dev has `VITE_WORKER_BASE_URL`
 * in `.env`, prod / staging Cloudflare Pages set it as an env var. A
 * thrown config error surfaces as a mutation onError → toast → user
 * sees the error and retries; no data is mutated against the wrong
 * Worker.
 */
export function requireWorkerWriteBase(): string {
  if (!WRITE_RAW) {
    throw new Error(
      'VITE_WORKER_BASE_URL is not set. Refusing to issue Worker write ' +
      'against the default URL -- this would route preview/staging traffic ' +
      'to the production Worker (which uses the production service-account ' +
      'to write Firestore). Set the env var explicitly for this deploy. ' +
      'Note: the legacy VITE_OCR_API_URL is NOT consulted as a fallback ' +
      'for write endpoints, only for the read-only OCR path.',
    )
  }
  return WRITE_RAW
}

// ─── Worker write call helper ─────────────────────────────────────

/**
 * Worker returned an explicit rejection BEFORE any Firestore admin
 * write could happen. Validation error, auth missing, rate limit,
 * doc-already-exists, etc. Caller can safely roll back any
 * client-side side effects (uploaded blob, etc.) because the
 * transaction never committed.
 */
export class WorkerRejected extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'WorkerRejected'
    this.status = status
  }
}

/**
 * Worker may or may not have committed -- the response was lost
 * (timeout / network / 5xx) and the caller has no way to tell from
 * the HTTP layer alone. Rolling back blob state would corrupt a
 * possibly-already-committed doc; the caller MUST read back doc
 * state (or route through the orphan-purge cron's verify-before-
 * delete logic) before deciding whether to purge.
 */
export class WorkerAmbiguous extends Error {
  readonly cause: unknown
  constructor(message: string, cause: unknown) {
    super(message)
    this.name = 'WorkerAmbiguous'
    this.cause = cause
  }
}

/** HTTP statuses where the Worker is guaranteed to have returned
 *  BEFORE any Firestore admin commit. Sourced from
 *  `workers/ocr/src/index.ts` route-error mapping:
 *    400 ExpenseValidationError + Zod parse fail
 *    401 missing / invalid Firebase token (auth middleware)
 *    403/404/409/410 CascadeError (authorize / tombstone / exists)
 *    413 body too large (request-shape gate)
 *    429 rate limit (per-uid PoP + global Durable Object)
 *  Everything else (500 internal, 502/503/504 CF gateway) is
 *  ambiguous -- could fire pre-commit OR mid-commit. */
const DEFINITIVE_REJECT_STATUSES = new Set([400, 401, 403, 404, 409, 410, 413, 429])

/** Wall-clock cap on a single Worker write call. 30s comfortably
 *  covers the Worker's p99 (~1-2s for Firestore admin writes; up to
 *  ~10s for trip-cascade on a trip with many subcollection docs) but
 *  bails out before the mutation onError UX stalls indefinitely. */
export const WORKER_FETCH_TIMEOUT_MS = 30_000

/**
 * Issue a Worker write call. Single chokepoint for every service
 * that hits a mutating Worker endpoint -- centralises auth, timeout,
 * and error discrimination so the failure modes are uniform across
 * `expenseCreate/Update` / `tripCascade.deleteTrip` /
 * `inviteService.acceptInvite`.
 *
 * Token MUST be pre-fetched by the caller (see `preflightIdToken`)
 * -- a missing or rejected token is a preflight failure that should
 * fail closed BEFORE any Storage / Firestore side effect, not slip
 * into the ambiguous-rollback branch with bytes already on disk.
 *
 * Error discrimination: 400/401/403/404/409/410/413/429 → throw
 * `WorkerRejected` (safe to roll back inline). AbortError / network /
 * 5xx → throw `WorkerAmbiguous` (caller MUST verify state before
 * inline rollback; defer to `_purges` cron is the canonical pattern).
 */
export async function workerFetch(
  base:     string,
  idToken:  string,
  endpoint: string,
  body:     unknown,
): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(`${base}${endpoint}`, {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${idToken}`,
        'Content-Type': 'application/json',
      },
      body:    JSON.stringify(body),
      signal:  AbortSignal.timeout(WORKER_FETCH_TIMEOUT_MS),
    })
  } catch (e) {
    // fetch() throws on AbortError (timeout), CORS preflight fail,
    // DNS, TLS, hard network failure. The Worker may or may not
    // have processed the request before the connection dropped.
    throw new WorkerAmbiguous(
      `${endpoint}: did not receive response (${(e as Error)?.message ?? 'unknown'})`,
      e,
    )
  }

  if (res.ok) return res.json()

  const detail = await res.text().catch(() => '<unreadable>')
  const message = `${endpoint} -> ${res.status}: ${detail.slice(0, 300)}`
  if (DEFINITIVE_REJECT_STATUSES.has(res.status)) {
    throw new WorkerRejected(res.status, message)
  }
  // 5xx / unknown -- Worker may have partially committed.
  throw new WorkerAmbiguous(message, undefined)
}

/**
 * Resolve the current Firebase ID token BEFORE any Storage / Firestore
 * side effect. Callers should invoke this at the top of any function
 * that uploads a blob or writes a Firestore doc; the thrown error
 * propagates to mutation onError → toast → user re-auth + retry.
 *
 * Lives here (not in firebase.ts) because it's specifically the
 * preflight gate for Worker write calls -- pairs with workerFetch
 * which expects the resolved token as an explicit parameter.
 */
export async function preflightIdToken(): Promise<string> {
  const { getFirebaseAuth } = await import('./firebase')
  const { auth } = await getFirebaseAuth()
  const idToken = await auth.currentUser?.getIdToken()
  if (!idToken) {
    throw new Error('not signed in: cannot perform Worker write')
  }
  return idToken
}
