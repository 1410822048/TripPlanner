// workers/ocr/src/settlement-write.ts
// Worker-authoritative settlement create + delete.
//
// Why these run on the Worker instead of via firestore.rules:
//   1. The core invariant is `amountMinor <= pairwise[fromUid][toUid]` —
//      i.e. a settlement can only REDUCE existing debt, never CREATE
//      reverse debt. rules can't compute this: it requires summing
//      across every expense's splits AND every prior settlement on
//      the same pair, then running the 4-step normalize from
//      `@tripmate/settlement-core`. CEL has no array reduce / no
//      cross-doc sum.
//   2. Without the gate, a recipient could record a settlement larger
//      than the actual debt; the leftover surfaces later as an
//      `OVERPAYMENT` orphan, but the damage to chronological replay
//      classifications + transfer suggestions is already done. Strict
//      reject at write-time keeps the data clean.
//   3. Closing rule create/delete to `if false` (M4) requires that
//      every legitimate write goes through here. Side-effect: the
//      `keys().hasOnly()` gap in the rule (extras silently land) is
//      plugged by Zod `.strict()`.
//
// firestore.rules after M4:
//   `allow create: if false`
//   `allow delete: if false`
// Until then both Worker + rules accept legitimate writes (Worker
// gate is the tighter one); the cutover lands rules-side last so any
// regression here doesn't break user flows during deploy.
//
// Reads (all in the same tx as the write):
//   - trips/{tripId}                                  (existence, deletingAt, currency)
//   - trips/{tripId}/members/{callerUid}              (membership)
//   - trips/{tripId}/members/{fromUid}                (membership of payer)
//   - trips/{tripId}/expenses where deletedAt IS_NULL (active gross)
//   - trips/{tripId}/settlements                      (already-applied)
//   - trips/{tripId}/settlements/{settlementId}       (create-only check)
//   - trips/{tripId}/settlementPairLocks/{key}        (pair contention guard;
//     key encoded as `<lo.len>:<lo>:<hi.len>:<hi>` -- see pairLockKey)
// Per Firestore docs, tx contention is based on the *documents read*.
// Two concurrent settlement creates with different (client-minted)
// settlementIds each runQuery the settlements collection -- but neither's
// snapshot includes the other's brand-new doc, so the settlement docs
// alone DON'T conflict. We therefore read+write a deterministic
// per-unordered-pair guard doc inside the same tx; two concurrent
// creates on the same pair both touch this doc → Firestore aborts one,
// retry sees the now-committed settlement and reapplies the gate.
import { z }                                                from 'zod'
import { getAdminToken, getProjectId }                      from './admin'
import {
  readString,
  type FsValue,
}                                                           from './firestore'
import { withTokenRetry, CascadeError }                     from './cascade'
import {
  runFirestoreTransaction,
  docResourceName,
  type TxContext,
  type TxWrite,
  type TxReadDoc,
}                                                           from './firestore-tx'
import {
  computePairwiseRemaining,
  pairRemaining,
  SETTLEMENT_EPS,
  type CoreExpense,
  type CoreSettlement,
}                                                           from '@tripmate/settlement-core'

// ─── Request body schemas ─────────────────────────────────────────

const TripIdRe = /^[A-Za-z0-9_-]{1,60}$/
const UID_MAX  = 128

/** Defensive caps for the in-tx reads. A pathological trip can't
 *  hang a tx waiting on 10k expenses / settlements; matches the
 *  client-side `LIST_LIMIT` ceilings (200 settlements, 500 expenses
 *  per the expense service).
 *
 *  CRITICAL: cap MUST be fail-closed (not fail-open with a partial
 *  dataset). Either form of under-read can let an overpay slip past:
 *    - missed prior settlements → applied undercounted → remaining
 *      overstated → gate accepts amount that's actually overpay
 *    - missed reverse-direction expenses → normalize step under-cancels
 *      the forward edge → forward remaining overstated, same effect
 *  We request `limit + 1` and reject with 503 when truncation is
 *  detected so the client retries / surfaces an error -- never silently
 *  computes pair remaining off a partial view. */
const EXPENSE_READ_LIMIT    = 500
const SETTLEMENT_READ_LIMIT = 200

/** Settlement create request. `.strict()` rejects extras at the
 *  protocol layer so we don't rely solely on firestore.rules' missing
 *  `keys().hasOnly()` gate. settlementId is client-minted via
 *  `doc(collection(...))` so the Worker's `currentDocument.exists=false`
 *  gives genuine create-only semantics (retry-safe). */
export const SettlementCreateRequestSchema = z.object({
  tripId:       z.string().regex(TripIdRe),
  settlementId: z.string().regex(TripIdRe),
  fromUid:      z.string().min(1).max(UID_MAX),
  toUid:        z.string().min(1).max(UID_MAX),
  amountMinor:  z.number().int().positive().max(1_000_000_000),
  currency:     z.string().length(3),
  note:         z.string().max(200).optional(),
}).strict()
export type SettlementCreateRequest = z.infer<typeof SettlementCreateRequestSchema>

export const SettlementDeleteRequestSchema = z.object({
  tripId:       z.string().regex(TripIdRe),
  settlementId: z.string().regex(TripIdRe),
}).strict()
export type SettlementDeleteRequest = z.infer<typeof SettlementDeleteRequestSchema>

// ─── Validation error ─────────────────────────────────────────────

/** Thrown for any settlement validation failure. Mirrors the
 *  Expense/Wish/Booking shape so route-dispatch.validationErrorCatcher
 *  handles all four the same way. */
export class SettlementValidationError extends Error {
  readonly field: string
  constructor(field: string, message: string) {
    super(`${field}: ${message}`)
    this.name  = 'SettlementValidationError'
    this.field = field
  }
}

// ─── Pair-lock path ───────────────────────────────────────────────

/** Deterministic doc path for the per-unordered-pair contention guard.
 *  Two concurrent creates / deletes on the same pair both touch this
 *  doc inside their tx → Firestore aborts one, retry sees fresh state.
 *  Direction-agnostic via lexicographic min/max ordering (A→B and B→A
 *  share the same lock doc). Storage is bounded (one per participating
 *  pair; trip-cascade drains the subcollection).
 *
 *  Encoding: `<lo.length>:<lo>:<hi.length>:<hi>`. Firebase Auth UIDs
 *  use the base64url alphabet `[A-Za-z0-9_-]`, so a naive
 *  `${lo}_${hi}` (or `${lo}__${hi}`) would not be injective:
 *  `{a, b_c}` and `{a_b, c}` both collapse to `a_b_c`. Length prefixes
 *  make every key trivially parseable back to (lo, hi), so collision
 *  is impossible. Worst-case symptom of a collision would be false
 *  contention (unrelated pair serializes through the same lock and
 *  one tx retries) -- not overpay or auth bypass -- but we'd rather
 *  not leave that on the floor for a future reviewer to re-discover.
 *  `:` is a legal Firestore doc-id character (only `/` is banned). */
function pairLockKey(a: string, b: string): string {
  const [lo, hi] = a < b ? [a, b] : [b, a]
  return `${lo.length}:${lo}:${hi.length}:${hi}`
}
function pairLockPath(tripId: string, a: string, b: string): string {
  return `trips/${tripId}/settlementPairLocks/${pairLockKey(a, b)}`
}

/** Build the lock-doc write that "touches" the pair guard. Same shape
 *  for create + delete: stamp the latest settlement id + REQUEST_TIME.
 *  No `currentDocument` precondition -- the doc is lazily created on
 *  the first settlement for the pair and persists thereafter (cascade
 *  is responsible for cleanup). */
function buildLockWrite(projectId: string, lockPath: string, settlementId: string): TxWrite {
  return {
    document: docResourceName(projectId, lockPath),
    fields:   {
      lastSettlementId: { stringValue: settlementId },
    },
    updateTransforms: [
      { fieldPath: 'lastSettlementAt', setToServerValue: 'REQUEST_TIME' },
    ],
  }
}

// ─── Authorization helpers ────────────────────────────────────────

interface TripCurrencyContext {
  currency: string
}

/** Settlement create authz: caller must be a trip member (any role —
 *  matches the existing rule's `exists(memberPath)`). The receiver-
 *  only invariant (`toUid == callerUid`) is checked separately by
 *  the create flow so the failure can carry a precise field path.
 *  Returns the trip's currency for the cross-check. */
async function authorizeMemberTx(
  tx:        TxContext,
  tripId:    string,
  callerUid: string,
): Promise<TripCurrencyContext> {
  const [trip, member] = await Promise.all([
    tx.get(`trips/${tripId}`),
    tx.get(`trips/${tripId}/members/${callerUid}`),
  ])
  if (!trip.exists)                throw new CascadeError(404, 'trip not found')
  if ('deletingAt' in trip.fields) throw new CascadeError(410, 'trip is being deleted')
  if (!member.exists)              throw new CascadeError(403, 'caller is not a trip member')

  const currency = readString(trip.fields, 'currency')
  if (!currency) {
    // Defensive -- every trip created via createTrip carries a currency.
    // If it's missing we'd otherwise silently accept any settlement
    // currency since the cross-check below short-circuits.
    throw new CascadeError(500, 'trip.currency is missing')
  }
  return { currency }
}

// ─── Decoders: REST fields → domain shapes ────────────────────────

function decodeExpenseForDomain(fields: Record<string, FsValue>): CoreExpense {
  const amountMinor = Number(fields.amountMinor?.integerValue ?? 0)
  const paidBy = readString(fields, 'paidBy') ?? ''
  const splitArr = (fields.splits as { arrayValue?: { values?: FsValue[] } } | undefined)?.arrayValue?.values ?? []
  const splits = splitArr.map(v => {
    const inner = v.mapValue?.fields ?? {}
    return {
      memberId:    readString(inner, 'memberId') ?? '',
      amountMinor: Number(inner.amountMinor?.integerValue ?? 0),
    }
  })
  return { amountMinor, paidBy, splits }
}

function decodeSettlementForDomain(fields: Record<string, FsValue>): CoreSettlement {
  const fromUid = readString(fields, 'fromUid') ?? ''
  const toUid   = readString(fields, 'toUid')   ?? ''
  const amountMinor = Number(fields.amountMinor?.integerValue ?? 0)
  // createdAt arrives as Firestore Timestamp -> REST timestampValue ISO 8601.
  // Convert to ms epoch for computePairwiseRemaining's sort step.
  // The rules pin createdAt == request.time on every create so every
  // legitimately-recorded settlement carries one; missing/unparseable
  // falls back to 0 which sorts first deterministically.
  const iso = fields.createdAt?.timestampValue
  const createdAtMs = typeof iso === 'string' ? Date.parse(iso) : 0
  return {
    fromUid,
    toUid,
    amountMinor,
    createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : 0,
  }
}

// ─── Endpoint: settlement-create ──────────────────────────────────

export async function settlementCreate(
  callerUid:          string,
  req:                SettlementCreateRequest,
  serviceAccountJson: string,
): Promise<{ settlementId: string }> {
  return withTokenRetry(() => doCreate(callerUid, req, serviceAccountJson))
}

async function doCreate(
  callerUid:          string,
  req:                SettlementCreateRequest,
  serviceAccountJson: string,
): Promise<{ settlementId: string }> {
  // Receiver-only invariant -- mirrors the rule's `toUid == uid()` gate.
  // Checked before tx begins (pure input-shape failure, no point burning
  // a tx round-trip on it).
  if (req.toUid !== callerUid) {
    throw new SettlementValidationError(
      'toUid',
      'only the receiver may record a settlement (toUid must equal the caller uid)',
    )
  }
  if (req.fromUid === req.toUid) {
    throw new SettlementValidationError(
      'fromUid',
      'fromUid and toUid must differ (self-settlement is meaningless)',
    )
  }

  const accessToken = await getAdminToken(serviceAccountJson)
  const projectId   = getProjectId(serviceAccountJson)

  return runFirestoreTransaction(accessToken, projectId, async (tx) => {
    const ctx = await authorizeMemberTx(tx, req.tripId, callerUid)

    // Currency cross-check vs the trip. Rules only check
    // `currency.size() == 3` -- a raw-SDK writer could pin a settlement
    // in USD onto a JPY trip and the chronological replay would compare
    // mismatched units. Worker is the only chokepoint after M4; gate
    // here.
    if (req.currency !== ctx.currency) {
      throw new SettlementValidationError(
        'currency',
        `settlement currency (${req.currency}) does not match trip currency (${ctx.currency})`,
      )
    }

    // fromUid must be a real trip member. Same intent as the rule's
    // `exists(memberPath(fromUid))` — without it the receiver could
    // fabricate "Charlie 還我 ¥100" records that pollute the audit
    // log without Charlie's input.
    const fromMember = await tx.get(`trips/${req.tripId}/members/${req.fromUid}`)
    if (!fromMember.exists) {
      throw new SettlementValidationError(
        'fromUid',
        `${req.fromUid} is not a trip member`,
      )
    }

    const lockPath = pairLockPath(req.tripId, req.fromUid, req.toUid)

    // Read active expenses + all existing settlements + the existing-doc
    // probe + the pair lock — all in the same tx snapshot. Critical
    // bits:
    //   - `limit + 1` on the runQueries so truncation is *detectable*
    //     (see EXPENSE_READ_LIMIT docstring for the overpay scenario).
    //   - The pair-lock read is what gives us same-pair-concurrent-create
    //     serialization. Without it, two creates with different
    //     settlementIds see the same {expenses, settlements} snapshot and
    //     both commit -- each writes its own new doc that the other's
    //     runQuery snapshot never included → no Firestore conflict on
    //     settlements alone. Reading + writing this shared doc forces
    //     the conflict.
    const [expenseReads, settlementReads, existingDoc, _lockRead] = await Promise.all([
      tx.runQuery({
        parent:     `trips/${req.tripId}`,
        collection: 'expenses',
        filters:    [{ fieldPath: 'deletedAt', op: 'IS_NULL' }],
        limit:      EXPENSE_READ_LIMIT + 1,
      }),
      tx.runQuery({
        parent:     `trips/${req.tripId}`,
        collection: 'settlements',
        limit:      SETTLEMENT_READ_LIMIT + 1,
      }),
      tx.get(`trips/${req.tripId}/settlements/${req.settlementId}`),
      tx.get(lockPath),
    ])

    // Fail-closed on truncation. See EXPENSE_READ_LIMIT comment for
    // the overpay scenario this prevents. 503 (Service Unavailable)
    // rather than 400 because retry is the right semantics -- the
    // pathological-trip case may be transient (e.g. mid-bulk-import).
    if (expenseReads.length > EXPENSE_READ_LIMIT) {
      throw new CascadeError(503, 'trip has too many active expenses to compute pair remaining safely (retry later)')
    }
    if (settlementReads.length > SETTLEMENT_READ_LIMIT) {
      throw new CascadeError(503, 'trip has too many settlements to compute pair remaining safely (retry later)')
    }

    if (existingDoc.exists) {
      // Idempotency: legitimate retry case is "client got no response,
      // retried with the same minted id, doc landed on first attempt".
      // We treat that as success ONLY if every business field matches
      // the existing doc -- otherwise it's an id collision (or replay
      // attempt with a different payload) and the right answer is 409
      // so the caller surfaces the mismatch instead of silently being
      // told "ok" for a write that never reflected the latest payload.
      const existingFromUid     = readString(existingDoc.fields, 'fromUid')
      const existingToUid       = readString(existingDoc.fields, 'toUid')
      const existingCurrency    = readString(existingDoc.fields, 'currency')
      const existingSettledBy   = readString(existingDoc.fields, 'settledBy')
      const existingAmountMinor = Number(
        existingDoc.fields.amountMinor?.integerValue ?? Number.NaN,
      )
      // note: current write path omits the field entirely when the
      // request's note is empty/absent. Normalize both sides to '' so
      // a "no note both ways" retry doesn't false-positive a mismatch.
      const existingNote = readString(existingDoc.fields, 'note') ?? ''
      const requestNote  = req.note ?? ''
      const matches =
           existingFromUid     === req.fromUid
        && existingToUid       === req.toUid
        && existingAmountMinor === req.amountMinor
        && existingCurrency    === req.currency
        && existingSettledBy   === callerUid
        && existingNote        === requestNote
      if (!matches) {
        throw new SettlementValidationError(
          'settlementId',
          'settlementId already exists with a different payload (id collision or replay attempt)',
        )
      }
      return {
        writes: [],
        result: { settlementId: req.settlementId },
      }
    }

    const expenses    = expenseReads.map(d => decodeExpenseForDomain(d.fields))
    const settlements = settlementReads.map(d => decodeSettlementForDomain(d.fields))
    const pairwise    = computePairwiseRemaining(expenses, settlements)
    const remaining   = pairRemaining(pairwise, req.fromUid, req.toUid)

    // Strict OVERPAY reject -- matches the locked design decision.
    // No soft warning; bounce the request so the client UI shows a
    // clear "amount exceeds remaining debt" error and the user
    // either reduces the amount or refreshes (data may have moved).
    // EPS guard mirrors `computeBalancesFull` step 3's edge threshold
    // (`rest > EPS` to produce a remaining edge); within EPS is
    // effectively zero debt.
    if (req.amountMinor > remaining + SETTLEMENT_EPS) {
      throw new SettlementValidationError(
        'amountMinor',
        `amountMinor (${req.amountMinor}) exceeds remaining debt (${remaining}) from ${req.fromUid} to ${req.toUid}`,
      )
    }

    // Build the doc. `note` is conditionally added (matches the
    // existing client `addDoc` pattern — empty/absent note means omit
    // the field, not write '').
    const fields: Record<string, FsValue> = {
      tripId:      { stringValue: req.tripId },
      fromUid:     { stringValue: req.fromUid },
      toUid:       { stringValue: req.toUid },
      // amountMinor goes in as integerValue -- the doc schema is
      // `z.number().int().positive()` so client-side reads expect an
      // integer-shaped value (Firestore SDK decodes integerValue to
      // number). REST integerValue is a string per proto convention.
      amountMinor: { integerValue: String(req.amountMinor) },
      currency:    { stringValue: req.currency },
      settledBy:   { stringValue: callerUid },
    }
    if (req.note != null && req.note !== '') {
      fields.note = { stringValue: req.note }
    }
    // createdAt via REQUEST_TIME transform -- using CF Workers'
    // Date.now() would drift relative to Firestore server clock and
    // re-order settlements relative to expenses in the chronological
    // replay (buildOrphanReasonMap), flipping orphan reasons between
    // OVERPAYMENT and EXPENSE_DELETED at the boundary. Mirrors the
    // rule's `createdAt == request.time` invariant.
    const write: TxWrite = {
      document:        docResourceName(projectId, `trips/${req.tripId}/settlements/${req.settlementId}`),
      fields,
      currentDocument: { exists: false },
      updateTransforms: [
        { fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' },
      ],
    }
    // Lock write paired with the lock read at the top of the tx.
    // Touching the same doc from two concurrent creates forces Firestore
    // to ABORT one tx; the retry sees the freshly-committed settlement
    // and the pair gate re-runs against accurate `applied` data.
    const lockWrite = buildLockWrite(projectId, lockPath, req.settlementId)
    return {
      writes: [write, lockWrite],
      result: { settlementId: req.settlementId },
    }
  })
}

// ─── Endpoint: settlement-delete ──────────────────────────────────

export async function settlementDelete(
  callerUid:          string,
  req:                SettlementDeleteRequest,
  serviceAccountJson: string,
): Promise<{ ok: true }> {
  return withTokenRetry(() => doDelete(callerUid, req, serviceAccountJson))
}

async function doDelete(
  callerUid:          string,
  req:                SettlementDeleteRequest,
  serviceAccountJson: string,
): Promise<{ ok: true }> {
  const accessToken = await getAdminToken(serviceAccountJson)
  const projectId   = getProjectId(serviceAccountJson)

  await runFirestoreTransaction(accessToken, projectId, async (tx) => {
    // Read trip + caller's member doc + the target settlement, all in
    // one tx snapshot. trip read enforces the same `deletingAt` gate
    // applied at create -- in-flight cascade should bounce delete
    // attempts so the cascade doesn't race with user-driven deletes.
    const settlementPath = `trips/${req.tripId}/settlements/${req.settlementId}`
    const [trip, member, settlement] = await Promise.all([
      tx.get(`trips/${req.tripId}`),
      tx.get(`trips/${req.tripId}/members/${callerUid}`),
      tx.get(settlementPath),
    ])
    if (!trip.exists)                  throw new CascadeError(404, 'trip not found')
    if ('deletingAt' in trip.fields)   throw new CascadeError(410, 'trip is being deleted')
    if (!member.exists)                throw new CascadeError(403, 'caller is not a trip member')
    if (!settlement.exists) {
      // Idempotent: delete-of-missing returns ok. Matches the existing
      // client `deleteDoc` behaviour (Firestore SDK silently no-ops on
      // missing doc deletes) so a double-tap doesn't surface a 404.
      return { writes: [], result: undefined }
    }

    // Recorder-or-owner gate. Mirrors the existing rule's
    // `resource.data.settledBy == uid() || isTripOwner(tripId)`.
    const settledBy = readString(settlement.fields, 'settledBy')
    const role      = readString(member.fields, 'role')
    const isOwner   = role === 'owner'
    const isRecorder = settledBy === callerUid
    if (!isOwner && !isRecorder) {
      throw new CascadeError(
        403,
        'only the recorder (settledBy) or trip owner may delete a settlement',
      )
    }

    // Read+write the same per-pair lock doc that `doCreate` touches.
    // Delete already naturally conflicts with a concurrent create that
    // includes this settlement in its runQuery snapshot, but touching
    // the lock here keeps the invariant symmetric and protects against
    // future read-pattern refactors silently breaking the guard.
    const fromUid = readString(settlement.fields, 'fromUid') ?? ''
    const toUid   = readString(settlement.fields, 'toUid')   ?? ''
    const lockPath = pairLockPath(req.tripId, fromUid, toUid)
    await tx.get(lockPath)

    const deleteWrite: TxWrite = {
      op:              'delete',
      document:        docResourceName(projectId, settlementPath),
      // `exists: true` makes a concurrent delete-then-our-delete race
      // surface as a 412 -> TxRetryExhausted instead of a silent
      // double-delete. With the recheck above (settlement.exists) the
      // common case is covered; this guards the gap between read and
      // commit.
      currentDocument: { exists: true },
    }
    const lockWrite = buildLockWrite(projectId, lockPath, req.settlementId)
    return { writes: [deleteWrite, lockWrite], result: undefined }
  })

  return { ok: true }
}

// Re-export the TxReadDoc type for tests that program the tx mock.
// Mirrors the cross-test-symmetry pattern used by expense-write.
export type { TxReadDoc }
