// workers/ocr/src/settlement-write.ts
// Worker-authoritative settlement create + delete.
//
// Design (Phase 4.1 rearchitecture, 2026-06-02):
//   「済み」 is "clear the suggested debt", not "post an arbitrary
//   amount". The request payload is a stale-confirmed intent:
//     - TRIP:    {from, to, expectedRemainingMinor, note}
//     - FOREIGN: {from, to, expectedRemainingMinor, sourceCurrency, settledOn, note}
//   Worker computes pair-remaining inside the tx, rejects if there's no
//   debt left or if it differs from expectedRemainingMinor, and writes
//   amountMinor = remaining for BOTH modes — the ledger MUST clear the
//   entire pair balance regardless of how the receiver was actually paid.
//   FX is decoupled:
//     - FOREIGN: source = atMost(remaining, rate) for display + audit;
//                fxSnapshot.convertedAmountMinor = forward(source, rate)
//                ≤ remaining. May diverge from amountMinor by a few
//                minor units due to half-even rounding plateaus —
//                settlement still clears the full remaining.
//   Eliminates the entire OVERPAY class of bug (client can't ship a
//   too-large amount because client doesn't ship an amount at all) AND
//   the partial-clear class (foreign settlements always zero the pair
//   balance, never leave a few-yen tail).
//
// Why these run on the Worker instead of via firestore.rules:
//   1. Computing pair-remaining requires summing every expense's
//      splits AND every prior settlement on the same pair, then
//      running the 4-step normalize from `@tripmate/settlement-core`.
//      CEL has no array reduce / no cross-doc sum.
//   2. The canonical amount is now Worker-derived (not client-supplied),
//      so rules can't validate it either way.
//   3. Closing rule create/delete to `if false` requires every
//      legitimate write goes through here. Side-effect: the
//      `keys().hasOnly()` gap in the rule (extras silently land) is
//      plugged by Zod `.strict()`.
//
// firestore.rules current state:
//   `allow create: if false`
//   `allow delete: if false`
//
// Reads (all in the same tx as the write):
//   - trips/{tripId}                                  (existence, deletingAt, currency)
//   - trips/{tripId}/members/{callerUid}              (membership)
//   - trips/{tripId}/members/{fromUid}                (membership of payer)
//   - trips/{tripId}/expenses where paidBy IN [from,to]  (active gross; soft-deleted dropped in-memory)
//   - trips/{tripId}/settlements where (fromUid,toUid)==(from,to) and the reverse (already-applied, exact pair)
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
  type TxUpdateWrite,
  type TxReadDoc,
  type TxResult,
}                                                           from './firestore-tx'
import {
  computePairwiseRemaining,
  pairRemaining,
  SETTLEMENT_EPS,
  type CoreExpense,
  type CoreSettlement,
}                                                           from '@tripmate/settlement-core'
import {
  type MaterializeAdjustment,
}                                                           from '@tripmate/expense-materialize'
import {
  buildSettlementLineage,
  type PairExpenseForSettlement,
  type SettlementAppliedSource,
}                                                           from './settlement-lineage'
import {
  SettlementValidationError,
  type TripCurrencyContext,
  type SettlementCreateRequest,
  type SettlementDeleteRequest,
}                                                           from './settlement-write-shared'
import {
  resolveForeignRate,
  deriveForeignArtifacts,
  encodeFxSnapshot,
  type ForeignRate,
  type ForeignSettlementArtifacts,
}                                                           from './settlement-fx-write'
import {
  pairLockPath,
  buildLockWrite,
  buildExpenseSettlementLockWrites,
  buildExpenseUnlockWrites,
  encodeStringArray,
  decodeStringArrayField,
}                                                           from './settlement-lock-write'

// Keep the pre-extraction public surface stable: index.ts and
// settlement-write.spec.ts import these from settlement-write. The
// definitions now live in settlement-write-shared (schemas / error / types).
export {
  SettlementCreateRequestSchema,
  SettlementDeleteRequestSchema,
}                                                           from './settlement-write-shared'
export { SettlementValidationError }
export type {
  SettlementCreateRequest,
  SettlementCreateTripRequest,
  SettlementCreateForeignRequest,
  SettlementDeleteRequest,
}                                                           from './settlement-write-shared'

// ─── In-tx read caps (fail-closed) ────────────────────────────────

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

// ─── Authorization helpers ────────────────────────────────────────

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

const MAX_APPLIED_SOURCES = 80

function docIdFromName(name: string): string {
  return name.split('/').pop() ?? ''
}

function parseCreatedAtMs(fields: Record<string, FsValue>): number {
  const iso = fields.createdAt?.timestampValue
  const ms = typeof iso === 'string' ? Date.parse(iso) : 0
  return Number.isFinite(ms) ? ms : 0
}

function readStringArray(value: FsValue | undefined): string[] {
  const values = (value as { arrayValue?: { values?: FsValue[] } } | undefined)?.arrayValue?.values ?? []
  return values
    .map(v => v.stringValue)
    .filter((s): s is string => typeof s === 'string' && s !== '')
}

function decodePairExpenseForSettlement(doc: TxReadDoc): PairExpenseForSettlement {
  const core = decodeExpenseForDomain(doc.fields)
  const itemArr = (doc.fields.items as { arrayValue?: { values?: FsValue[] } } | undefined)?.arrayValue?.values
  const items = itemArr?.map(v => {
    const inner = v.mapValue?.fields ?? {}
    return {
      id:          readString(inner, 'id') ?? '',
      name:        readString(inner, 'name') ?? '',
      amountMinor: Number(inner.amountMinor?.integerValue ?? 0),
      assignees:   readStringArray(inner.assignees),
    }
  })
  const adjArr = (doc.fields.adjustments as { arrayValue?: { values?: FsValue[] } } | undefined)?.arrayValue?.values ?? []
  const adjustments = adjArr.map(v => {
    const inner = v.mapValue?.fields ?? {}
    const targetItemId = readString(inner, 'targetItemId')
    const out: MaterializeAdjustment & { label: string } = {
      id:          readString(inner, 'id')    ?? '',
      label:       readString(inner, 'label') ?? '',
      kind:        (readString(inner, 'kind')  ?? '') as MaterializeAdjustment['kind'],
      scope:       (readString(inner, 'scope') ?? '') as MaterializeAdjustment['scope'],
      amountMinor: Number(inner.amountMinor?.integerValue ?? 0),
    }
    if (targetItemId !== undefined) out.targetItemId = targetItemId
    return out
  })
  return {
    ...core,
    id:          docIdFromName(doc.name),
    title:       readString(doc.fields, 'title') ?? docIdFromName(doc.name),
    createdAtMs: parseCreatedAtMs(doc.fields),
    items,
    adjustments,
  }
}

function encodeAppliedSources(sources: SettlementAppliedSource[]): FsValue {
  return {
    arrayValue: {
      values: sources.map(source => {
        const fields: Record<string, FsValue> = {
          expenseId:    { stringValue:  source.expenseId },
          expenseTitle: { stringValue:  source.expenseTitle },
          amountMinor:  { integerValue: String(source.amountMinor) },
        }
        if (source.itemId !== undefined && source.itemName !== undefined) {
          fields.itemId = { stringValue: source.itemId }
          fields.itemName = { stringValue: source.itemName }
        }
        return { mapValue: { fields } }
      }),
    },
  }
}

function readInteger(fields: Record<string, FsValue> | undefined, key: string): number | null {
  const raw = fields?.[key]
  if (!raw || !('integerValue' in raw)) return null
  const n = Number(raw.integerValue)
  return Number.isSafeInteger(n) ? n : null
}

export async function settlementCreate(
  callerUid:          string,
  req:                SettlementCreateRequest,
  serviceAccountJson: string,
): Promise<{ settlementId: string }> {
  return withTokenRetry(() => doCreate(callerUid, req, serviceAccountJson))
}

/** Idempotent-retry check for a pre-existing settlement at the same id.
 *
 *  Legitimate retry: client got no response (network blip / Worker
 *  cold-start timeout) and re-sent the SAME settlementId with the SAME
 *  intent payload. We return success without re-writing.
 *
 *  Post-rearchitecture the request payload is a stale-confirmed intent:
 *    - TRIP:    {from, to, expectedRemainingMinor, note}
 *    - FOREIGN: {from, to, expectedRemainingMinor, sourceCurrency, settledOn, note}
 *  `expectedRemainingMinor` is not a user-entered settlement amount; it
 *  is the UI's view of pair-remaining when the sheet opened. A retry
 *  only short-circuits when persisted amountMinor still equals that
 *  confirmed remaining. FOREIGN sourceAmountMinor remains excluded
 *  because it is Worker-derived from pair-remaining + rate at the
 *  original write time.
 *
 *  Cross-mode retry (request mode disagrees with the persisted shape)
 *  is an id collision -- the persisted shape decides which comparison
 *  applies, no auto-cast.
 *
 *  This helper is side-effect free and does NOT touch FX. It runs in
 *  the doCreate fast-path before any rate resolve / expense-read fan-out,
 *  so a legitimate retry succeeds even when Frankfurter is down. */
function idempotencyShortCircuit(
  existingDoc: TxReadDoc,
  req:         SettlementCreateRequest,
  callerUid:   string,
): TxResult<{ settlementId: string }> {
  const existingFromUid   = readString(existingDoc.fields, 'fromUid')
  const existingToUid     = readString(existingDoc.fields, 'toUid')
  const existingSettledBy = readString(existingDoc.fields, 'settledBy')
  const existingHasSource = existingDoc.fields.sourceCurrency !== undefined
  const existingAmountMinor = readInteger(existingDoc.fields, 'amountMinor')
  const existingNote = readString(existingDoc.fields, 'note') ?? ''
  const requestNote  = req.note ?? ''

  const reqIsForeign = req.mode === 'FOREIGN_CURRENCY'
  if (existingHasSource !== reqIsForeign) {
    throw new SettlementValidationError(
      'settlementId',
      'settlementId already exists with a different payload (id collision or replay attempt)',
    )
  }

  let payloadMatches: boolean
  if (req.mode === 'FOREIGN_CURRENCY') {
    const existingSourceCurrency = readString(existingDoc.fields, 'sourceCurrency')
    const existingSettledOn      = readString(existingDoc.fields, 'settledOn')
    payloadMatches =
         existingFromUid        === req.fromUid
      && existingToUid          === req.toUid
      && existingSourceCurrency === req.sourceCurrency
      && existingSettledOn      === req.settledOn
      && existingSettledBy      === callerUid
      && existingAmountMinor    === req.expectedRemainingMinor
      && existingNote           === requestNote
  } else {
    payloadMatches =
         existingFromUid   === req.fromUid
      && existingToUid     === req.toUid
      && existingSettledBy === callerUid
      && existingAmountMinor === req.expectedRemainingMinor
      && existingNote      === requestNote
  }
  if (!payloadMatches) {
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

    // ----- Idempotent-retry fast-path (read existing settlement first) -----
    //
    // Critical ordering decision: the existing-settlement probe (and the
    // from-member existence check) happens BEFORE the FX network call
    // for FOREIGN_CURRENCY and BEFORE the heavy expense + settlement
    // runQuery fan-out for the overpay gate. Why:
    //
    //   The whole point of the stale-confirmed idempotency contract is
    //   that a retry of the SAME settlementId with the SAME
    //   {fromUid, toUid, expectedRemainingMinor, sourceCurrency,
    //   settledOn, note} should return success even when the FX provider
    //   is down, because the original commit already landed. If we called FX
    //   first, a Frankfurter degraded window would turn legitimate
    //   retries (after a client-timeout + retry) into 502s -- a regression
    //   the stale-confirmed comparison contract was designed to prevent.
    //
    //   Same logic for the expense/settlement reads: those are pure
    //   overpay-gate inputs, only meaningful on the new-write path. For
    //   a retry we don't write anything; the existing doc is already
    //   the authoritative answer.
    //
    //   The full tx still re-reads the existing doc on the new-write
    //   path implicitly via the `currentDocument: { exists: false }`
    //   precondition on the write -- the fast-path is a perf + retry-
    //   robustness optimization, NOT the safety boundary.
    const existingDocPath = `trips/${req.tripId}/settlements/${req.settlementId}`
    const [existingDoc, fromMember] = await Promise.all([
      tx.get(existingDocPath),
      tx.get(`trips/${req.tripId}/members/${req.fromUid}`),
    ])

    if (existingDoc.exists) {
      // Stale-confirmed payload comparison. No FX lookup, no pair-remaining
      // recompute -- the persisted doc is the authoritative record, but
      // persisted amountMinor must still match expectedRemainingMinor.
      // Cross-mode retry (existing shape mismatches request mode) is an
      // id collision.
      return idempotencyShortCircuit(existingDoc, req, callerUid)
    }

    // ----- New-write path -----

    // fromUid must be a real trip member. Same intent as the rule's
    // `exists(memberPath(fromUid))` — without it the receiver could
    // fabricate "Charlie 還我 ¥100" records that pollute the audit
    // log without Charlie's input.
    if (!fromMember.exists) {
      throw new SettlementValidationError(
        'fromUid',
        `${req.fromUid} is not a trip member`,
      )
    }

    // FOREIGN: resolve the FX rate HERE — AFTER the idempotency + auth
    // checks (so a retry of an already-recorded settlement never hits FX,
    // preserving "retry succeeds even when Frankfurter is down") but BEFORE
    // the pair fan-out below, so the HOT pair expense/settlement docs are
    // NOT yet in this tx's read/conflict set while we wait on the FX
    // provider (cache miss → up to ~8s). Keeping the network I/O out of the
    // pair-docs window is the point of the contention fix: a concurrent
    // same-pair /expense-update must not race an open tx that's blocked on
    // Frankfurter. The `remaining`-dependent source derivation stays
    // pure-CPU after the fan-out (deriveForeignArtifacts). An FX failure
    // (provider down / future date) throws here, before any pair doc is
    // read — definitively pre-commit, nothing written.
    let foreignRate: ForeignRate | undefined
    if (req.mode === 'FOREIGN_CURRENCY') {
      foreignRate = await resolveForeignRate(req, ctx, serviceAccountJson)
    }

    const lockPath = pairLockPath(req.tripId, req.fromUid, req.toUid)

    // Read the PAIR-SCOPED expenses + settlements + the pair lock in the
    // same tx snapshot. Scoping is both correctness-preserving and the
    // contention fix:
    //   - Only expenses paid by fromUid or toUid contribute to the
    //     (from,to) pair gross (X owes P only via an expense P paid), and
    //     only settlements between exactly this pair touch its applied
    //     debt. So `paidBy IN [from,to]` for expenses + two exact-DIRECTION
    //     equality reads for settlements (from→to AND to→from) are
    //     SUFFICIENT for pairRemaining(from,to) — both settlement
    //     directions are read, so the no-overpay invariant holds in full.
    //   - The previous WHOLE-collection reads put every expense in the
    //     trip into this tx's conflict set, so ANY concurrent expense
    //     edit anywhere aborted this commit (and vice versa) — a wide
    //     contention surface that timed unrelated /expense-updates out.
    //     Pair-scoping shrinks the conflict set to docs that genuinely
    //     affect this settlement.
    //   - Settlements are read by (fromUid,toUid) EQUALITY, NOT a
    //     denormalized pairKey field. This is deliberately migration-safe:
    //     fromUid/toUid exist on EVERY settlement doc (including any
    //     recorded before this code shipped), whereas a brand-new
    //     `pairKey ==` query would silently skip pre-existing docs →
    //     `applied` undercounted → remaining overstated → permanent
    //     409-stale on any pair that already had a settlement. Two `==`
    //     filters need NO composite index (Firestore single-field index
    //     merging), and each direction's query returns ONLY this exact
    //     pair, so unrelated A→thirdParty rows never enter the conflict set
    //     or count toward the read limit.
    //   - `limit + 1` keeps truncation *detectable* (fail-closed below).
    //   - The pair-lock read serializes same-pair concurrent creates:
    //     two creates with different settlementIds would otherwise each
    //     snapshot a set excluding the other's brand-new doc → no
    //     conflict on settlements alone. Reading + writing this shared
    //     doc forces the conflict.
    //   - Soft-deleted expenses are dropped in-memory (below) rather than
    //     via a `deletedAt IS_NULL` filter, so we don't pull in a composite
    //     (paidBy, deletedAt) index requirement.
    const pairUidsValue: FsValue = {
      arrayValue: { values: [{ stringValue: req.fromUid }, { stringValue: req.toUid }] },
    }
    const [expenseReads, settlementFwd, settlementRev, _lockRead] = await Promise.all([
      tx.runQuery({
        parent:     `trips/${req.tripId}`,
        collection: 'expenses',
        filters:    [{ fieldPath: 'paidBy', op: 'IN', value: pairUidsValue }],
        limit:      EXPENSE_READ_LIMIT + 1,
      }),
      tx.runQuery({
        parent:     `trips/${req.tripId}`,
        collection: 'settlements',
        filters: [
          { fieldPath: 'fromUid', op: 'EQUAL', value: { stringValue: req.fromUid } },
          { fieldPath: 'toUid',   op: 'EQUAL', value: { stringValue: req.toUid } },
        ],
        limit: SETTLEMENT_READ_LIMIT + 1,
      }),
      tx.runQuery({
        parent:     `trips/${req.tripId}`,
        collection: 'settlements',
        filters: [
          { fieldPath: 'fromUid', op: 'EQUAL', value: { stringValue: req.toUid } },
          { fieldPath: 'toUid',   op: 'EQUAL', value: { stringValue: req.fromUid } },
        ],
        limit: SETTLEMENT_READ_LIMIT + 1,
      }),
      tx.get(lockPath),
    ])
    // Both exact-direction reads already scope to this pair, so their
    // union IS the complete settlement set for pairRemaining — no in-memory
    // pair filter needed (a doc is from→to OR to→from, never both, so the
    // two result sets are disjoint).
    const settlementReads = [...settlementFwd, ...settlementRev]

    // Fail-closed on truncation. See EXPENSE_READ_LIMIT comment for the
    // overpay scenario this prevents. 503 rather than 400 because retry
    // is the right semantics -- a pathological pair (500+ expenses paid
    // by the same two people) may be transient (mid-bulk-import). Check
    // the RAW read length (pre soft-delete filter) so truncation can't
    // hide behind in-memory dropping.
    if (expenseReads.length > EXPENSE_READ_LIMIT) {
      throw new CascadeError(503, 'too many expenses for this pair to compute remaining safely (retry later)')
    }
    if (settlementReads.length > SETTLEMENT_READ_LIMIT) {
      throw new CascadeError(503, 'too many settlements for this pair to compute remaining safely (retry later)')
    }

    // Drop soft-deleted expenses in-memory (the query no longer filters
    // deletedAt — see scoping note). A tombstoned expense must not count
    // toward gross, matching the active-only semantics the previous
    // `deletedAt IS_NULL` query filter enforced.
    const activeExpenseReads = expenseReads
      .filter(d => !(d.fields.deletedAt as { timestampValue?: string } | undefined)?.timestampValue)
    const pairExpenses = activeExpenseReads.map(decodePairExpenseForSettlement)
    const expenses = pairExpenses.map(e => ({
      amountMinor: e.amountMinor,
      paidBy:      e.paidBy,
      splits:      e.splits,
    }))
    const settlements = settlementReads.map(d => decodeSettlementForDomain(d.fields))
    const pairwise    = computePairwiseRemaining(expenses, settlements)
    const remaining   = pairRemaining(pairwise, req.fromUid, req.toUid)

    // No-debt reject. The whole point of the rearchitecture: 「済み」
    // is "clear the suggested debt", not "post an arbitrary number".
    // If pair-remaining is effectively zero (no edge, or already
    // cleared by a concurrent settlement landing first), there's
    // nothing to settle — bounce so the UI can re-fetch and the
    // suggestion row disappears. EPS guard mirrors computeBalancesFull
    // step 3's edge threshold (`rest > EPS` to produce a remaining
    // edge); within EPS is effectively zero debt.
    if (remaining <= SETTLEMENT_EPS) {
      throw new SettlementValidationError(
        'fromUid',
        `no remaining debt from ${req.fromUid} to ${req.toUid} (it may have been settled already)`,
      )
    }

    // Phase 4.1 ledger semantics: amountMinor ≡ remaining for BOTH modes.
    // 「済み」 is "clear the suggested debt" — the receiver expects the
    // entire pair balance to be zeroed regardless of which currency they
    // happened to receive in. FX is decoupled from the ledger: it only
    // populates the source-side display + fxSnapshot.convertedAmountMinor
    // for audit, and may diverge from amountMinor by a few minor units
    // due to half-even rounding plateaus (e.g. rate 1.5 + remaining=5003
    // → sourceAmountMinor=3335 forwards to 5002 < 5003; settlement still
    // writes amountMinor=5003 to clear the debt fully).
    if (Math.abs(remaining - req.expectedRemainingMinor) > SETTLEMENT_EPS) {
      throw new CascadeError(409, 'settlement suggestion is stale; refresh balances and retry')
    }

    const canonicalAmountMinor: number = remaining
    let foreign: ForeignSettlementArtifacts | undefined
    const lineage = buildSettlementLineage(
      pairExpenses,
      settlements,
      req.fromUid,
      req.toUid,
      canonicalAmountMinor,
    )
    const appliedSources = lineage.appliedSources.slice(0, MAX_APPLIED_SOURCES)
    // The persisted appliedExpenseIds is the LOCK set (forward sources ∪
    // reverse offset expenses), NOT just the displayed sources — so delete
    // unlocks exactly what create locked, and a net settlement locks its
    // reverse inputs too. See buildSettlementLineage.
    const appliedExpenseIds = lineage.lockExpenseIds

    if (req.mode === 'FOREIGN_CURRENCY') {
      // Pure-CPU: the rate was already resolved before the pair fan-out
      // (foreignRate). This only inverse-derives the source amount from the
      // freshly-computed `remaining` and forward-converts it for the audit
      // snapshot — no network, so the tx is NOT held open here.
      foreign = deriveForeignArtifacts(req, ctx, remaining, foreignRate!)
      // Source-side round-to-zero guard. Tiny remaining + weak
      // source-to-trip rate can inverse to 0 source minor units, which
      // (a) fails SettlementDocSchema's `sourceAmountMinor.positive()`
      // on the client read parser and (b) makes the "≈ 0 USD" display
      // nonsense. Reject with field=sourceCurrency so the form
      // surfaces "pick a different currency" as the actionable nudge —
      // the user can use TRIP_CURRENCY mode to clear the tiny remainder.
      if (foreign.sourceAmountMinor <= 0) {
        throw new SettlementValidationError(
          'sourceCurrency',
          'remaining debt is too small to settle in the chosen source currency',
        )
      }
    }

    // Build the doc. `note` is conditionally added (matches the
    // existing client `addDoc` pattern — empty/absent note means omit
    // the field, not write '').
    const fields: Record<string, FsValue> = {
      tripId:      { stringValue: req.tripId },
      fromUid:     { stringValue: req.fromUid },
      toUid:       { stringValue: req.toUid },
      // amountMinor ≡ remaining (Phase 4.1 ledger truth) for BOTH modes.
      // currency is always the trip currency (Worker-derived from ctx,
      // never accepted from the request). On FOREIGN, fxSnapshot.
      // convertedAmountMinor is what the FX forward produced — may be
      // ≤ amountMinor and that's expected, schema no longer enforces
      // equality between the two.
      amountMinor: { integerValue: String(canonicalAmountMinor) },
      currency:    { stringValue: ctx.currency },
      settledBy:   { stringValue: callerUid },
    }
    if (appliedSources.length > 0) {
      fields.appliedSources = encodeAppliedSources(appliedSources)
    }
    if (appliedExpenseIds.length > 0) {
      fields.appliedExpenseIds = encodeStringArray(appliedExpenseIds)
    }
    if (req.note != null && req.note !== '') {
      fields.note = { stringValue: req.note }
    }
    if (foreign) {
      // FX group all-or-none: write the full 4-field group together so
      // SettlementDocSchema.superRefine (src/types/settlement.ts) never
      // sees a half-populated doc on read. fetchedAt is null here and
      // REQUEST_TIME-stamped via updateTransforms below.
      fields.sourceCurrency    = { stringValue:  foreign.sourceCurrency }
      fields.sourceAmountMinor = { integerValue: String(foreign.sourceAmountMinor) }
      fields.settledOn         = { stringValue:  foreign.settledOn }
      fields.fxSnapshot        = encodeFxSnapshot(foreign.fxSnapshot)
    }

    // createdAt via REQUEST_TIME transform -- using CF Workers'
    // Date.now() would drift relative to Firestore server clock and
    // re-order settlements relative to expenses in the chronological
    // replay (buildOrphanReasonMap), flipping orphan reasons between
    // OVERPAYMENT and EXPENSE_DELETED at the boundary. Mirrors the
    // rule's `createdAt == request.time` invariant.
    const updateTransforms: NonNullable<TxUpdateWrite['updateTransforms']> = [
      { fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' },
    ]
    if (foreign) {
      // Server-stamp fxSnapshot.fetchedAt at commit time. The field is
      // written as null in encodeFxSnapshot so the parent map exists
      // for the nested transform to target; Firestore applies the
      // transform AFTER the field write within the same Write, so the
      // final stored value is REQUEST_TIME-stamped.
      updateTransforms.push({ fieldPath: 'fxSnapshot.fetchedAt', setToServerValue: 'REQUEST_TIME' })
    }
    const write: TxWrite = {
      document:        docResourceName(projectId, `trips/${req.tripId}/settlements/${req.settlementId}`),
      fields,
      currentDocument: { exists: false },
      updateTransforms,
    }
    // Lock write paired with the lock read at the top of the tx.
    // Touching the same doc from two concurrent creates forces Firestore
    // to ABORT one tx; the retry sees the freshly-committed settlement
    // and the pair gate re-runs against accurate `applied` data.
    const lockWrite = buildLockWrite(projectId, lockPath, req.settlementId)
    // Current lock-ref sets for the applied expenses, read straight from the
    // docs already in this tx's snapshot (no extra round-trip). The union
    // happens in buildExpenseSettlementLockWrites; the tx conflict set
    // covers these expenses so concurrent same-expense settlements serialize.
    const currentLockIds = new Map<string, string[]>(
      activeExpenseReads.map(d => [
        docIdFromName(d.name),
        decodeStringArrayField(d.fields, 'settlementLockIds'),
      ]),
    )
    const expenseLockWrites = buildExpenseSettlementLockWrites(
      projectId,
      req.tripId,
      appliedExpenseIds,
      req.settlementId,
      currentLockIds,
    )
    return {
      writes: [write, lockWrite, ...expenseLockWrites],
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
    // `resource.data.settledBy == uid() || isTripOwner(tripId)`. Owner is
    // determined by trip.ownerId === callerUid — the SAME source of truth
    // as expense-write.ts (admin SDK bypasses rules, and members/{uid}.role
    // could drift from trips/{id}.ownerId; aligning avoids wrongly
    // allowing/denying a delete on that drift). `member.exists` above
    // already gates membership.
    const settledBy = readString(settlement.fields, 'settledBy')
    const ownerId   = readString(trip.fields, 'ownerId')
    const isOwner   = ownerId === callerUid
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

    // Release this settlement's lock on every expense it referenced. Read
    // each applied expense IN-TX (so a concurrent settlement create/delete
    // on the same expense conflicts + retries — no lost update), drop this
    // settlementId from its `settlementLockIds`, and write the trimmed set
    // back. The expense stays locked while OTHER settlements still reference
    // it (their ids remain in the set) — cross-pair correct with NO global
    // ARRAY_CONTAINS scan, because each settlement only ever owns its own id.
    const appliedExpenseIds = decodeStringArrayField(settlement.fields, 'appliedExpenseIds')
    const lockedExpenseReads = await Promise.all(
      appliedExpenseIds.map(eid => tx.get(`trips/${req.tripId}/expenses/${eid}`)),
    )
    // Pure write-builder (settlement-lock-write) is the delete-side mirror
    // of buildExpenseSettlementLockWrites — the tx reads stay here, the
    // lock-set release math lives next to the create-side union so the
    // symmetry is auditable in one module.
    const expenseUnlockWrites = buildExpenseUnlockWrites(
      projectId,
      req.tripId,
      req.settlementId,
      appliedExpenseIds,
      lockedExpenseReads,
    )

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
    return { writes: [deleteWrite, lockWrite, ...expenseUnlockWrites], result: undefined }
  })

  return { ok: true }
}

// Re-export the TxReadDoc type for tests that program the tx mock.
// Mirrors the cross-test-symmetry pattern used by expense-write.
export type { TxReadDoc }
