// workers/ocr/src/firestore-tx.ts
// Firestore REST transaction wrapper. Closes a class of races that
// the previous "read snapshot → validate → admin PATCH" sequence
// left open:
//
//   - expense-create read trip.deletingAt absent → concurrent
//     cascade stamps deletingAt → expense PATCH lands → orphan
//   - expense-update read expense as alive → concurrent client
//     soft-deletes the expense → Worker writes content patch onto
//     tombstoned doc → bypasses rules-layer tombstone-freeze
//     (rules don't see admin SDK writes)
//
// Inside a Firestore transaction, the reads under the tx return
// stable snapshots that the commit step verifies haven't changed.
// If anything we read was concurrently modified, the commit aborts
// with `ABORTED`; the wrapper re-runs the body up to N times.
//
// Why REST + admin token instead of firebase-admin SDK: the SDK
// doesn't run on CF Workers' V8 isolate (no Node fs / net). We
// already use REST + jose-signed service-account JWTs throughout
// this Worker.
import { invalidateAdminToken }     from './admin'
import type { FsValue }             from './firestore'

const BASE = 'https://firestore.googleapis.com/v1'

/** A single write in a transaction commit. Mirrors the Firestore
 *  REST `Write` proto subset we actually use. */
export interface TxWrite {
  /** Full document resource name:
   *  `projects/<id>/databases/(default)/documents/trips/.../...` */
  document:        string
  /** Field map for setDoc semantics. Omit fields you want
   *  preserved -- use `updateMask` to scope the write. */
  fields:          Record<string, FsValue>
  /** When present, only these field paths are written; everything
   *  else on the doc is preserved. Required for partial updates. */
  updateMask?:     string[]
  /** Precondition. Use `{ exists: false }` for create-only writes
   *  (rejects if the doc already exists). `{ exists: true }`
   *  ensures the doc still exists at commit time (paired with the
   *  tx mechanism this is belt-and-suspenders). */
  currentDocument?: {
    exists?:     boolean
    updateTime?: string
  }
  /** Field-level server-side transforms applied atomically alongside
   *  the field write. Today we only need `REQUEST_TIME` for audit
   *  timestamps (`createdAt` / `updatedAt`) -- using CF Workers'
   *  Date.now() instead would drift relative to Firestore server
   *  clock and break the settlement engine's chronological replay,
   *  which sorts by Firestore-stamped createdAt. updateTransforms
   *  fieldPaths are SEPARATE from updateMask -- they don't appear
   *  in `fields` and don't need to be in the mask. */
  updateTransforms?: Array<{
    fieldPath:        string
    setToServerValue: 'REQUEST_TIME'
  }>
}

/** Doc resource ready to feed back into a TxWrite, OR null if the
 *  doc didn't exist at the time of the read. */
export interface TxReadDoc {
  exists:     boolean
  /** Empty when exists=false. */
  fields:     Record<string, FsValue>
  /** Full doc resource name including the project + db prefix. */
  name:       string
  /** Server-side updateTime. Useful when callers want to express
   *  "only commit if this doc hasn't changed since I read it" via
   *  the TxWrite.currentDocument.updateTime precondition on a
   *  DIFFERENT doc (e.g. a read of trip while writing expense). */
  updateTime: string | null
}

export interface TxContext {
  /** Read a doc within the transaction. Returns null when the doc
   *  doesn't exist. Reads tracked by Firestore for the commit-time
   *  conflict check. */
  get: (path: string) => Promise<TxReadDoc>
}

export interface TxResult<T> {
  /** Writes to attempt at commit. Empty array is valid (read-only
   *  tx; the helper still runs the commit RPC for symmetry). */
  writes: TxWrite[]
  /** Caller's return value; surfaced from runFirestoreTransaction
   *  on successful commit. */
  result: T
}

/**
 * Thrown when the transaction body explicitly chooses to abort
 * (e.g., validation failure that should NOT trigger a retry).
 * Different from the implicit retry-on-ABORTED path -- this is
 * the caller saying "stop trying, return this error to the user".
 */
export class TxAbort extends Error {
  readonly cause: unknown
  constructor(cause: unknown) {
    super('transaction body aborted')
    this.name = 'TxAbort'
    this.cause = cause
  }
}

const MAX_RETRIES = 5
/** Base + cap + jitter for retry backoff. Without backoff a contended
 *  doc (e.g. two near-simultaneous expense updates on the same trip)
 *  would burn all 5 attempts within milliseconds and surface as a
 *  spurious "exhausted retries" error to the user, even though waiting
 *  a few hundred ms would let the conflicting writer win and our
 *  retry succeed. Exponential 50ms → 100 → 200 → 400 → 800 + ±0-50ms
 *  jitter, capped at 2s, gives the contender room to commit. */
const BACKOFF_BASE_MS = 50
const BACKOFF_CAP_MS  = 2_000

function backoffDelay(attempt: number): number {
  const exp = BACKOFF_BASE_MS * 2 ** attempt
  const jitter = Math.random() * 50
  return Math.min(exp + jitter, BACKOFF_CAP_MS)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Run `body` inside a Firestore transaction. The body reads docs
 * (via `tx.get`), validates, and returns writes. The helper
 * commits the writes atomically -- if any of the read docs was
 * modified concurrently, the commit fails with ABORTED and the
 * helper re-runs the body (up to MAX_RETRIES).
 *
 * Throw `TxAbort` from the body to surface a non-retryable error
 * (e.g., validation failure). Any other throw is rethrown after
 * the in-progress transaction's implicit rollback.
 *
 * Note: this is a READ-WRITE transaction (`options.readWrite`).
 * Reads via tx.get are taken at the transaction's snapshot point
 * and consumed by the commit's conflict check.
 */
export async function runFirestoreTransaction<T>(
  accessToken: string,
  projectId:   string,
  body:        (tx: TxContext) => Promise<TxResult<T>>,
): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let txId: string
    try {
      txId = await beginTransaction(accessToken, projectId)
    } catch (e) {
      if (isUnauthorized(e)) {
        invalidateAdminToken()
        throw e
      }
      throw e
    }

    let bodyResult: TxResult<T>
    try {
      const ctx: TxContext = {
        get: path => readDocInTransaction(accessToken, projectId, path, txId),
      }
      bodyResult = await body(ctx)
    } catch (e) {
      // Body threw -- discard the tx (no explicit rollback RPC
      // needed; uncommitted transactions are dropped server-side
      // after their deadline). Re-raise.
      throw e
    }

    try {
      await commitTransaction(accessToken, projectId, txId, bodyResult.writes)
      return bodyResult.result
    } catch (e) {
      lastError = e
      if (isAborted(e)) {
        // Conflict -- one of the docs we read was modified between
        // read and commit. Wait a jittered backoff so a contender can
        // commit before we re-read, then retry the whole body with a
        // fresh tx. Without the sleep all 5 attempts burn through in
        // ms and the user sees a spurious "exhausted retries" error.
        // Log to Worker console so `wrangler tail` surfaces contention
        // patterns -- without this, retry behaviour was a silent black
        // box and we couldn't tell whether ABORTED was actually firing
        // in production.
        console.warn(`[firestore-tx] ABORTED attempt ${attempt + 1}/${MAX_RETRIES}: ${(e as Error)?.message ?? e}`)
        if (attempt < MAX_RETRIES - 1) {
          await sleep(backoffDelay(attempt))
        }
        continue
      }
      if (isUnauthorized(e)) {
        invalidateAdminToken()
        throw e
      }
      throw e
    }
  }
  // Retry exhausted -- pack the attempt count into the message so
  // upstream Sentry / error logs can group on "max-retry" separately
  // from one-shot transaction failures.
  throw new TxRetryExhausted(MAX_RETRIES, lastError)
}

/** Thrown when ABORTED retry budget is exhausted. Distinct from a
 *  one-shot transaction failure so upstream observability can group
 *  on it and triage contention spikes separately. */
export class TxRetryExhausted extends Error {
  readonly attempts: number
  readonly lastError: unknown
  constructor(attempts: number, lastError: unknown) {
    const lastMsg = (lastError as Error)?.message ?? String(lastError)
    super(`runFirestoreTransaction exhausted ${attempts} retries: ${lastMsg}`)
    this.name = 'TxRetryExhausted'
    this.attempts = attempts
    this.lastError = lastError
  }
}

// ─── REST primitives ──────────────────────────────────────────────

async function beginTransaction(accessToken: string, projectId: string): Promise<string> {
  const url = `${BASE}/projects/${projectId}/databases/(default)/documents:beginTransaction`
  const res = await fetch(url, {
    cache: 'no-store',
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ options: { readWrite: {} } }),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new TxRestError(res.status, `beginTransaction → ${res.status}: ${detail.slice(0, 200)}`)
  }
  const data = await res.json() as { transaction: string }
  return data.transaction
}

async function readDocInTransaction(
  accessToken: string,
  projectId:   string,
  path:        string,
  txId:        string,
): Promise<TxReadDoc> {
  // Single-doc read within a transaction uses documents:batchGet,
  // NOT the GET endpoint (the GET endpoint accepts `?transaction=`
  // for read but ergonomics are messier and batchGet is the more
  // common pattern in Firestore docs / Admin SDK source).
  const url = `${BASE}/projects/${projectId}/databases/(default)/documents:batchGet`
  const fullName = `projects/${projectId}/databases/(default)/documents/${path}`
  const res = await fetch(url, {
    cache: 'no-store',
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      documents: [fullName],
      transaction: txId,
    }),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new TxRestError(res.status, `tx.get ${path} → ${res.status}: ${detail.slice(0, 200)}`)
  }
  const rows = await res.json() as Array<{
    found?:   { name: string; fields?: Record<string, FsValue>; updateTime?: string }
    missing?: string
    readTime?: string
  }>
  const row = rows[0]
  if (!row) {
    throw new TxRestError(500, `tx.get ${path} → empty batchGet response`)
  }
  if (row.missing) {
    return { exists: false, fields: {}, name: row.missing, updateTime: null }
  }
  if (!row.found) {
    throw new TxRestError(500, `tx.get ${path} → row has neither found nor missing`)
  }
  return {
    exists:     true,
    fields:     row.found.fields ?? {},
    name:       row.found.name,
    updateTime: row.found.updateTime ?? null,
  }
}

async function commitTransaction(
  accessToken: string,
  projectId:   string,
  txId:        string,
  writes:      TxWrite[],
): Promise<void> {
  const url = `${BASE}/projects/${projectId}/databases/(default)/documents:commit`
  const restWrites = writes.map(w => ({
    update: {
      name:   w.document,
      fields: w.fields,
    },
    ...(w.updateMask     ? { updateMask:     { fieldPaths: w.updateMask } } : {}),
    ...(w.currentDocument ? { currentDocument: w.currentDocument } : {}),
    ...(w.updateTransforms && w.updateTransforms.length > 0
        ? { updateTransforms: w.updateTransforms }
        : {}),
  }))
  const res = await fetch(url, {
    cache: 'no-store',
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      transaction: txId,
      writes:      restWrites,
    }),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new TxRestError(res.status, `commit → ${res.status}: ${detail.slice(0, 300)}`)
  }
}

// ─── Error classification ─────────────────────────────────────────

class TxRestError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'TxRestError'
    this.status = status
  }
}

function isAborted(e: unknown): boolean {
  if (!(e instanceof TxRestError)) return false
  // Firestore returns 409 CONFLICT or 400 with ABORTED in the body
  // for transaction-aborted-due-to-concurrent-write. 412 FAILED_
  // PRECONDITION is also possible if a write precondition fails.
  if (e.status === 409) return true
  if (e.status === 400 && e.message.includes('ABORTED')) return true
  if (e.status === 412) return true
  return false
}

function isUnauthorized(e: unknown): boolean {
  return e instanceof TxRestError && e.status === 401
}

// ─── Convenience: doc name builder ────────────────────────────────

/** Build the full `projects/<id>/databases/(default)/documents/<path>`
 *  resource name. TxWrite.document needs this format. */
export function docResourceName(projectId: string, path: string): string {
  return `projects/${projectId}/databases/(default)/documents/${path}`
}
