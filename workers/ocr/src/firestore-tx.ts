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
 *  REST `Write` proto subset we actually use.
 *
 *  Discriminated by `op`:
 *    - `op` absent or `'update'` → upsert-with-updateMask semantics
 *      (the historical default; preserved so existing call-sites
 *      that omit `op` still type-check)
 *    - `op: 'delete'` → hard-delete the document at `document`
 *
 *  Both branches accept `currentDocument` for optimistic concurrency
 *  (e.g. `{ exists: true }` to reject a delete-before-read race). */
export type TxWrite = TxUpdateWrite | TxDeleteWrite

export interface TxUpdateWrite {
  op?:             'update'
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

export interface TxDeleteWrite {
  op:              'delete'
  /** Full document resource name -- same shape as TxUpdateWrite.document.
   *  The settlement-delete endpoint uses this to hard-delete a settlement
   *  inside the same tx that authorized + read it, so a concurrent
   *  cascade-trip-delete OR a competing delete-by-owner ends up as a
   *  single Firestore conflict (412/409) the wrapper retries -- not a
   *  silent double-delete. */
  document:        string
  /** Same precondition options as update. `{ exists: true }` on a
   *  delete asserts the doc was still present at commit time; commit
   *  fails with 412 if a concurrent writer already deleted it. */
  currentDocument?: {
    exists?:     boolean
    updateTime?: string
  }
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

/** Field-level filter for runQuery. `op` mirrors Firestore REST
 *  `FieldFilter.op` enum subset we actually need. `value` is a single
 *  FsValue, encoded by the caller (e.g. `{ stringValue: 'JPY' }`).
 *
 *  `IN` matches when the field equals any element of an ARRAY value:
 *  the caller MUST pass `value: { arrayValue: { values: [...] } }`
 *  (≤30 elements per Firestore). `IN` on a single field uses the
 *  automatic single-field index, so no composite index is needed --
 *  settlement-write relies on this to scope its in-tx reads to the
 *  settling pair without a deploy-time index dependency. */
export interface TxFieldFilter {
  fieldPath: string
  op:        'EQUAL' | 'LESS_THAN' | 'LESS_THAN_OR_EQUAL' | 'GREATER_THAN' | 'GREATER_THAN_OR_EQUAL' | 'IN' | 'ARRAY_CONTAINS'
  value:     FsValue
}

/** Unary filter (`IS_NULL` / `IS_NOT_NULL`). MUST be used instead of
 *  `FieldFilter EQUAL {nullValue}` because the REST API silently
 *  returns ZERO matches for the latter against null-valued docs --
 *  same Admin-SDK-mandated shape documented in firestore.ts's
 *  queryReceiptPurgeCandidates comment. */
export interface TxUnaryFilter {
  fieldPath: string
  op:        'IS_NULL' | 'IS_NOT_NULL'
}

export type TxFilter = TxFieldFilter | TxUnaryFilter

function isUnaryFilter(f: TxFilter): f is TxUnaryFilter {
  return f.op === 'IS_NULL' || f.op === 'IS_NOT_NULL'
}

/** Sub-collection query under a parent path. Combined with the
 *  transaction's id at runtime so the returned docs participate in
 *  the commit-time conflict check, same as `tx.get`. Scope kept tight
 *  (single parent, single subcollection, AND filters only) to match
 *  what the in-tree callers actually need -- settlement-write reads
 *  active expenses + all settlements under a trip. Generalising to
 *  collection-group / OR / startAt was punted; the current
 *  /upload-intent-purge + /receipt-purge crons that do those things
 *  don't need transactional reads. */
export interface TxQuery {
  /** Parent path (e.g. `trips/abc`). Empty string scopes to the
   *  database root -- collection-group queries are NOT supported here
   *  (no `allDescendants`); use the non-tx helpers in firestore.ts. */
  parent:     string
  /** Subcollection id directly under `parent` (e.g. `expenses`). */
  collection: string
  /** AND-combined filters. Omit for "every doc". */
  filters?:   TxFilter[]
  /** Default ordering is by `__name__` ascending, matching Firestore's
   *  implicit order. Provide explicit orderBy when callers need
   *  deterministic createdAt-based reads (settlement engine sorts by
   *  createdAt for the replay -- but the Worker computes pair remaining
   *  forward-cap-only and doesn't need that ordering). */
  orderBy?:   Array<{ fieldPath: string; direction: 'ASCENDING' | 'DESCENDING' }>
  /** Bounded read so a pathological trip can't hang a tx waiting on
   *  10k expenses. Callers pass the same defensive cap they'd use for
   *  the client-side getDocs equivalent (see settlement-write). */
  limit?:     number
}

export interface TxContext {
  /** Read a doc within the transaction. Returns null when the doc
   *  doesn't exist. Reads tracked by Firestore for the commit-time
   *  conflict check. */
  get:      (path: string) => Promise<TxReadDoc>
  /** Query a subcollection within the transaction. Returns the docs in
   *  the order Firestore returned them (post-orderBy / post-limit).
   *  Reads tracked for commit-time conflict check just like `get` --
   *  if any doc in the read result set is modified before commit, the
   *  tx aborts and retries. This is the property that lets settlement-
   *  write read "all settlements + expenses for this trip" and trust
   *  that no concurrent write slipped in between read and commit. */
  runQuery: (query: TxQuery) => Promise<TxReadDoc[]>
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

/** Per-RPC wall-clock cap on each Firestore REST call (begin / read /
 *  runQuery / commit). Under heavy document contention a single commit
 *  can sit open for many seconds before Firestore returns ABORTED; left
 *  uncapped, ~5 such commits blow past the client's 30s write budget
 *  (workerBase.WORKER_FETCH_TIMEOUT_MS) and the client aborts into an
 *  ambiguous "did not receive response". Capping each call lets the
 *  retry loop cycle and the total-deadline guard fire.
 *
 *  Timeout handling is PHASE-AWARE (see runFirestoreTransaction):
 *  begin / read / runQuery timeouts are pre-commit (nothing written) →
 *  retry-eligible; a COMMIT timeout is AMBIGUOUS (the write may have
 *  applied) → surfaced as TxCommitAmbiguous and NEVER blind-retried. */
const TX_RPC_TIMEOUT_MS = 9_000

/** Total wall-clock budget for the whole retry loop. We bail well under
 *  the client's 30s write timeout so the Worker returns a DEFINITIVE
 *  (retry-eligible) result BEFORE the client gives up -- the client
 *  then surfaces a "still confirming" state instead of a hard failure.
 *  Date.now() advances across the fetch awaits in the CF Workers
 *  runtime, so elapsed measured here is real wall-clock. */
const TX_TOTAL_DEADLINE_MS = 20_000

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
  const startMs = Date.now()
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const txId = await beginTransaction(accessToken, projectId)
      const ctx: TxContext = {
        get:      path  => readDocInTransaction (accessToken, projectId, path,  txId),
        runQuery: query => runQueryInTransaction(accessToken, projectId, query, txId),
      }
      // The body only READS + computes + returns writes -- the actual
      // writes land in commitTransaction below. So re-running the body
      // on a retry is always safe: nothing has been written yet.
      const bodyResult = await body(ctx)
      await commitTransaction(accessToken, projectId, txId, bodyResult.writes)
      return bodyResult.result
    } catch (e) {
      lastError = e

      // Commit response lost to the per-RPC timeout -> AMBIGUOUS. The
      // write MAY have applied server-side. We deliberately do NOT
      // blind-retry: a create-only caller (expense / booking / wish
      // create with currentDocument.exists=false, or intent
      // consumption) would see its own committed doc / used intents on
      // the second pass and reject 409 -- turning a SUCCESSFUL write
      // into a user-visible failure (the exact false-failure class this
      // whole change set is fixing). Propagate so the route returns a
      // 5xx the client classifies as WorkerAmbiguous, keeping optimistic
      // state for the realtime listener to reconcile. (settlement-
      // create's id-probe short-circuit makes a *client* retry safe, but
      // that is the client's call, not a blind tx re-run here.)
      if (e instanceof TxCommitAmbiguous) throw e

      // Expired admin token -- refresh and let the caller retry.
      if (isUnauthorized(e)) {
        invalidateAdminToken()
        throw e
      }

      // Retry-eligible, all DEFINITIVELY pre-commit (nothing written):
      //   - commit conflict (409 ABORTED / 412 FAILED_PRECONDITION):
      //     Firestore rejected the commit, so no write landed.
      //   - begin / read / runQuery RPC timeout: the failure is before
      //     the commit RPC, so no write landed either.
      // Both are safe to re-run from a fresh tx. Bounded by BOTH the
      // attempt cap AND a wall-clock deadline so the Worker surfaces
      // TxRetryExhausted (5xx) BEFORE the client's 30s write timeout
      // degrades into an ambiguous "did not receive response".
      if (isAborted(e) || isRpcTimeout(e)) {
        // Log to Worker console so `wrangler tail` surfaces contention
        // patterns -- retry behaviour was otherwise a silent black box.
        console.warn(`[firestore-tx] ${isRpcTimeout(e) ? 'RPC_TIMEOUT' : 'ABORTED'} attempt ${attempt + 1}/${MAX_RETRIES}: ${(e as Error)?.message ?? e}`)
        const elapsed = Date.now() - startMs
        if (attempt < MAX_RETRIES - 1 && elapsed < TX_TOTAL_DEADLINE_MS) {
          await sleep(backoffDelay(attempt))
          continue
        }
        throw new TxRetryExhausted(attempt + 1, e)
      }

      // Anything else (body validation throw, CascadeError, non-conflict
      // commit 5xx, genuine network failure) is not retry-eligible.
      throw e
    }
  }
  // Defensive: the in-loop deadline/count guard is the normal exit for
  // retry exhaustion; this covers the theoretically-unreachable
  // fall-through so the function never returns undefined.
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

/** A COMMIT RPC that overran its per-call timeout. Distinct from every
 *  other tx failure because it is AMBIGUOUS: Firestore may have applied
 *  the write before the response was lost. runFirestoreTransaction never
 *  blind-retries this (a create-only caller would 409 on its own
 *  already-applied doc / used intents); it propagates to the route as a
 *  generic 5xx, which the client classifies as WorkerAmbiguous and
 *  reconciles via the realtime listener instead of rolling back. Callers
 *  with genuine same-id replay semantics (settlement-create) can retry
 *  at the application layer, but that is an explicit caller decision. */
export class TxCommitAmbiguous extends Error {
  readonly cause: unknown
  constructor(cause: unknown) {
    super('commit response lost (timeout); the write may or may not have applied')
    this.name  = 'TxCommitAmbiguous'
    this.cause = cause
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
    signal: AbortSignal.timeout(TX_RPC_TIMEOUT_MS),
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
    signal: AbortSignal.timeout(TX_RPC_TIMEOUT_MS),
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

async function runQueryInTransaction(
  accessToken: string,
  projectId:   string,
  query:       TxQuery,
  txId:        string,
): Promise<TxReadDoc[]> {
  // Firestore's :runQuery accepts an arbitrary parent prefix; the
  // structuredQuery's `from.collectionId` selects the child collection
  // under it. Empty parent → database root (we don't expose that to
  // callers but keep the encoding correct).
  const parentPath = query.parent ? `documents/${query.parent}` : 'documents'
  const url = `${BASE}/projects/${projectId}/databases/(default)/${parentPath}:runQuery`

  const filters = (query.filters ?? []).map(f => {
    if (isUnaryFilter(f)) {
      return { unaryFilter: { field: { fieldPath: f.fieldPath }, op: f.op } }
    }
    return { fieldFilter: { field: { fieldPath: f.fieldPath }, op: f.op, value: f.value } }
  })

  const structuredQuery: Record<string, unknown> = {
    from: [{ collectionId: query.collection }],
  }
  if (filters.length === 1) {
    structuredQuery.where = filters[0]
  } else if (filters.length > 1) {
    structuredQuery.where = { compositeFilter: { op: 'AND', filters } }
  }
  if (query.orderBy && query.orderBy.length > 0) {
    structuredQuery.orderBy = query.orderBy.map(o => ({
      field: { fieldPath: o.fieldPath }, direction: o.direction,
    }))
  }
  if (query.limit != null) {
    structuredQuery.limit = query.limit
  }

  const res = await fetch(url, {
    cache: 'no-store',
    method: 'POST',
    headers: {
      Authorization:  `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    // `transaction` at the request body's top level (NOT inside
    // structuredQuery) tells Firestore to take these reads as part of
    // the open tx so their snapshots feed the commit-time conflict
    // check -- same protocol as :batchGet's `transaction` field.
    body: JSON.stringify({ structuredQuery, transaction: txId }),
    signal: AbortSignal.timeout(TX_RPC_TIMEOUT_MS),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new TxRestError(
      res.status,
      `tx.runQuery ${query.parent}/${query.collection} → ${res.status}: ${detail.slice(0, 200)}`,
    )
  }
  // :runQuery streams an array. Each row has EITHER `document` (a
  // matching doc), or just `readTime` + `skippedResults` for the
  // "tx-only first row" empty marker. We keep only rows with a real
  // document field -- same filter as the cron-side helpers in
  // firestore.ts (queryReceiptPurgeCandidates etc.).
  const rows = await res.json() as Array<{
    document?: { name: string; fields?: Record<string, FsValue>; updateTime?: string }
  }>
  return rows
    .filter(r => r.document)
    .map(r => ({
      exists:     true,
      fields:     r.document!.fields ?? {},
      name:       r.document!.name,
      updateTime: r.document!.updateTime ?? null,
    }))
}

async function commitTransaction(
  accessToken: string,
  projectId:   string,
  txId:        string,
  writes:      TxWrite[],
): Promise<void> {
  const url = `${BASE}/projects/${projectId}/databases/(default)/documents:commit`
  const restWrites = writes.map(w => {
    if (w.op === 'delete') {
      // REST Write supports either {update}, {delete}, or {transform};
      // we only emit one per array element. updateMask + transforms
      // don't apply to deletes -- a hard delete drops the whole doc.
      return {
        delete: w.document,
        ...(w.currentDocument ? { currentDocument: w.currentDocument } : {}),
      }
    }
    return {
      update: {
        name:   w.document,
        fields: w.fields,
      },
      ...(w.updateMask     ? { updateMask:     { fieldPaths: w.updateMask } } : {}),
      ...(w.currentDocument ? { currentDocument: w.currentDocument } : {}),
      ...(w.updateTransforms && w.updateTransforms.length > 0
          ? { updateTransforms: w.updateTransforms }
          : {}),
    }
  })
  let res: Response
  try {
    res = await fetch(url, {
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
      signal: AbortSignal.timeout(TX_RPC_TIMEOUT_MS),
    })
  } catch (e) {
    // A commit that overran the per-RPC timeout is AMBIGUOUS -- Firestore
    // may have applied the write before we stopped waiting for the
    // response. Tag it so the wrapper never blind-retries (see the
    // TxCommitAmbiguous handling in runFirestoreTransaction). Other
    // fetch rejections (genuine network failure) propagate as-is: they
    // predate this timeout, are also non-retried, and surface as a
    // generic 5xx -> client ambiguous, which is the original behaviour.
    if (isRpcTimeout(e)) throw new TxCommitAmbiguous(e)
    throw e
  }
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

/** A Firestore REST call that overran its per-RPC AbortSignal.timeout.
 *  `AbortSignal.timeout` rejects fetch with a DOMException named
 *  'TimeoutError'; some runtimes surface 'AbortError'. We treat either
 *  as a retry-eligible conflict (see the runFirestoreTransaction commit
 *  catch) -- a stuck commit under contention should cycle, not hard-fail. */
function isRpcTimeout(e: unknown): boolean {
  const name = (e as { name?: string } | undefined)?.name
  return name === 'TimeoutError' || name === 'AbortError'
}

// ─── Convenience: doc name builder ────────────────────────────────

/** Build the full `projects/<id>/databases/(default)/documents/<path>`
 *  resource name. TxWrite.document needs this format. */
export function docResourceName(projectId: string, path: string): string {
  return `projects/${projectId}/databases/(default)/documents/${path}`
}
