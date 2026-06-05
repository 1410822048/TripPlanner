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
  resolveFxRate,
  type FxSnapshot,
}                                                           from './fx-rate'
import {
  currencyFractionDigits,
  convertMinorHalfEven,
  estimateSourceMinorAtMostTargetHalfEven,
}                                                           from '@tripmate/fx-core'
import {
  materializeExpenseSplitContributions,
  type MaterializeAdjustment,
  type MaterializeItem,
}                                                           from '@tripmate/expense-materialize'

// ─── Request body schemas ─────────────────────────────────────────

const TripIdRe = /^[A-Za-z0-9_-]{1,60}$/
const UID_MAX  = 128
const AMOUNT_MINOR_MAX = 999_999_999_999

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

/** Settlement create request. Discriminated by `mode`:
 *
 *    - TRIP_CURRENCY (degenerate): client just declares "clear the
 *      remaining debt from fromUid to toUid in trip currency".
 *      No amount on the wire — Worker computes pair-remaining and
 *      writes it as the canonical amountMinor.
 *    - FOREIGN_CURRENCY: client picks the currency the payee actually
 *      received + the date that pins the FX rate. Worker resolves the
 *      rate, inverse-derives the source amount whose forward conversion
 *      does NOT exceed remaining (at-most-target policy), persists the
 *      forward-converted canonical alongside the source-domain trio +
 *      fxSnapshot.
 *
 *  Key shape change from the pre-rearchitecture design: the wire body
 *  no longer carries `amountMinor` / `currency` / `sourceAmountMinor`.
 *  Removing them eliminates the OVERPAY class of bug entirely — the
 *  client can no longer specify a value the Worker has to reject. The
 *  Worker is the sole authority for the canonical settlement amount,
 *  derived from pair-remaining at tx time.
 *
 *  Per-branch `.strict()` rejects extras at the protocol layer so we
 *  don't rely solely on firestore.rules' missing `keys().hasOnly()`
 *  gate. settlementId is client-minted via `crypto.randomUUID()` so
 *  the Worker's `currentDocument.exists=false` gives genuine
 *  create-only semantics (retry-safe). */
const CurrencyRe = /^[A-Z]{3}$/
const IsoDateRe  = /^\d{4}-\d{2}-\d{2}$/

const SettlementCreateBaseSchema = z.object({
  tripId:       z.string().regex(TripIdRe),
  settlementId: z.string().regex(TripIdRe),
  fromUid:      z.string().min(1).max(UID_MAX),
  toUid:        z.string().min(1).max(UID_MAX),
  expectedRemainingMinor: z.number().int().positive().max(AMOUNT_MINOR_MAX),
  note:         z.string().max(200).optional(),
})

const SettlementCreateTripSchema = SettlementCreateBaseSchema.extend({
  mode: z.literal('TRIP_CURRENCY'),
}).strict()

const SettlementCreateForeignSchema = SettlementCreateBaseSchema.extend({
  mode:           z.literal('FOREIGN_CURRENCY'),
  sourceCurrency: z.string().regex(CurrencyRe, 'sourceCurrency must be ISO 4217 alpha-3 uppercase'),
  settledOn:      z.string().regex(IsoDateRe, 'settledOn must be YYYY-MM-DD'),
}).strict()

export const SettlementCreateRequestSchema = z.discriminatedUnion('mode', [
  SettlementCreateTripSchema,
  SettlementCreateForeignSchema,
])
export type SettlementCreateRequest        = z.infer<typeof SettlementCreateRequestSchema>
export type SettlementCreateTripRequest    = z.infer<typeof SettlementCreateTripSchema>
export type SettlementCreateForeignRequest = z.infer<typeof SettlementCreateForeignSchema>

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

// ─── Pair-key / Pair-lock path ────────────────────────────────────

/** Deterministic unordered pair key for the pair-LOCK doc id. Settlement
 *  docs themselves are read by (fromUid,toUid) equality, NOT by a stored
 *  pairKey field — see the read fan-out in doCreate for why that's the
 *  migration-safe choice. The lock serializes same-pair create/delete so
 *  two concurrent creates on the same pair conflict on a shared doc.
 *
 *  Direction-agnostic via lexicographic min/max ordering (A→B and B→A
 *  share the same key). Storage is bounded (one lock doc per
 *  participating pair).
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
function pairKey(a: string, b: string): string {
  const [lo, hi] = a < b ? [a, b] : [b, a]
  return `${lo.length}:${lo}:${hi.length}:${hi}`
}
function pairLockPath(tripId: string, a: string, b: string): string {
  return `trips/${tripId}/settlementPairLocks/${pairKey(a, b)}`
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

/** Carries the source-domain artifacts that FOREIGN_CURRENCY persists
 *  alongside the trip-currency canonical fields. Mirrors expense-write's
 *  ForeignArtifacts pattern: snapshot.fetchedAt is encoded as null and
 *  REQUEST_TIME-stamped at commit. */
interface ForeignSettlementArtifacts {
  sourceCurrency:    string
  sourceAmountMinor: number
  settledOn:         string
  fxSnapshot:        FxSnapshot
}

/** Encode FxSnapshot as a Firestore map. `fetchedAt` is set to null
 *  here -- the caller adds an `updateTransforms` entry pinned to
 *  REQUEST_TIME so Firestore stamps the field at commit. Writing both
 *  is intentional: the field MUST appear in the map so the create
 *  Write's `currentDocument.exists=false` doesn't reject the transform
 *  as targeting a missing parent.
 *
 *  Inline (vs sharing from fx-rate.ts with expense-write) is deliberate:
 *  both writers shaping the same fxSnapshot map keeps the contract
 *  obvious at the write site, and the read-schema test
 *  (settlement.test.ts FX cross-field equality) catches any divergence. */
function encodeFxSnapshot(fx: FxSnapshot): FsValue {
  return {
    mapValue: {
      fields: {
        provider:             { stringValue:  fx.provider },
        baseCurrency:         { stringValue:  fx.baseCurrency },
        quoteCurrency:        { stringValue:  fx.quoteCurrency },
        requestedDate:        { stringValue:  fx.requestedDate },
        rateDate:             { stringValue:  fx.rateDate },
        rateDecimal:          { stringValue:  fx.rateDecimal },
        sourceAmountMinor:    { integerValue: String(fx.sourceAmountMinor) },
        convertedAmountMinor: { integerValue: String(fx.convertedAmountMinor) },
        fetchedAt:            { nullValue:    null },
      },
    },
  }
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

interface PairExpenseForSettlement extends CoreExpense {
  id:          string
  title:       string
  createdAtMs: number
  items?:      Array<MaterializeItem & { name: string }>
  adjustments: Array<MaterializeAdjustment & { label: string }>
}

interface SettlementAppliedSource {
  expenseId:    string
  expenseTitle: string
  itemId?:      string
  itemName?:    string
  amountMinor:  number
}

interface SettlementSourceUnit extends SettlementAppliedSource {
  createdAtMs:    number
  order:          number
  remainingMinor: number
}

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

function membersForExpense(expense: PairExpenseForSettlement): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const add = (uid: string) => {
    if (!uid || seen.has(uid)) return
    seen.add(uid)
    out.push(uid)
  }
  add(expense.paidBy)
  for (const split of expense.splits) add(split.memberId)
  for (const item of expense.items ?? []) {
    for (const uid of item.assignees) add(uid)
  }
  return out
}

function sourceUnitsForDirection(
  expenses: PairExpenseForSettlement[],
  fromUid:  string,
  toUid:    string,
): SettlementSourceUnit[] {
  const units: SettlementSourceUnit[] = []
  for (const expense of expenses) {
    if (expense.paidBy !== toUid) continue
    const pairSplitMinor = expense.splits
      .filter(split => split.memberId === fromUid)
      .reduce((sum, split) => sum + split.amountMinor, 0)
    if (!Number.isFinite(pairSplitMinor) || pairSplitMinor <= SETTLEMENT_EPS) continue

    const items = expense.items ?? []
    if (items.length > 0) {
      try {
        const contributions = materializeExpenseSplitContributions({
          items: items.map(item => ({
            id:          item.id,
            amountMinor: item.amountMinor,
            assignees:   item.assignees,
          })),
          adjustments: expense.adjustments.map(adj => {
            const out: MaterializeAdjustment = {
              id:          adj.id,
              kind:        adj.kind,
              scope:       adj.scope,
              amountMinor: adj.amountMinor,
            }
            if (adj.targetItemId !== undefined) out.targetItemId = adj.targetItemId
            return out
          }),
          members: membersForExpense(expense),
        }).filter(c => c.memberId === fromUid && c.amountMinor > SETTLEMENT_EPS)

        const contributionTotal = contributions.reduce((sum, c) => sum + c.amountMinor, 0)
        if (contributionTotal === pairSplitMinor) {
          const itemById = new Map(items.map(item => [item.id, item]))
          contributions.forEach((c, i) => {
            const item = itemById.get(c.itemId)
            units.push({
              expenseId:      expense.id,
              expenseTitle:   expense.title,
              itemId:         c.itemId,
              itemName:       item?.name ?? c.itemId,
              amountMinor:    c.amountMinor,
              remainingMinor: c.amountMinor,
              createdAtMs:    expense.createdAtMs,
              order:          i,
            })
          })
          continue
        }
      } catch {
        // Attribution is best-effort audit metadata; no-overpay math has
        // already used the persisted splits. Fall back to expense-level
        // lineage instead of rejecting a valid settlement.
      }
    }

    units.push({
      expenseId:      expense.id,
      expenseTitle:   expense.title,
      amountMinor:    pairSplitMinor,
      remainingMinor: pairSplitMinor,
      createdAtMs:    expense.createdAtMs,
      order:          0,
    })
  }

  return units.sort((a, b) =>
    a.createdAtMs - b.createdAtMs
    || a.expenseId.localeCompare(b.expenseId)
    || a.order - b.order
    || (a.itemId ?? '').localeCompare(b.itemId ?? ''),
  )
}

function consumeSourceUnits(units: SettlementSourceUnit[], amountMinor: number): SettlementAppliedSource[] {
  const consumed: SettlementAppliedSource[] = []
  if (!Number.isFinite(amountMinor)) return consumed
  let remaining = Math.round(amountMinor)
  if (remaining <= 0) return consumed

  for (const unit of units) {
    if (remaining <= 0) break
    if (unit.remainingMinor <= SETTLEMENT_EPS) continue
    const taken = Math.min(unit.remainingMinor, remaining)
    unit.remainingMinor -= taken
    remaining -= taken
    if (taken > SETTLEMENT_EPS) {
      const out: SettlementAppliedSource = {
        expenseId:    unit.expenseId,
        expenseTitle: unit.expenseTitle,
        amountMinor:  Math.round(taken),
      }
      if (unit.itemId !== undefined && unit.itemName !== undefined) {
        out.itemId = unit.itemId
        out.itemName = unit.itemName
      }
      consumed.push(out)
    }
  }
  return consumed
}

function sourceTotal(units: SettlementSourceUnit[]): number {
  return units.reduce((sum, unit) => sum + Math.max(0, unit.remainingMinor), 0)
}

function collapseAppliedSources(sources: SettlementAppliedSource[]): SettlementAppliedSource[] {
  const collapsed: SettlementAppliedSource[] = []
  const byKey = new Map<string, SettlementAppliedSource>()
  for (const source of sources) {
    const key = `${source.expenseId}\u0000${source.itemId ?? ''}`
    const existing = byKey.get(key)
    if (existing) {
      existing.amountMinor += source.amountMinor
      continue
    }
    const next = { ...source }
    byKey.set(key, next)
    collapsed.push(next)
  }
  return collapsed
}


interface SettlementLineage {
  /** Forward-direction sources consumed by the settlement amount — the
   *  DISPLAY lineage (「清算の元になった費用」). Capped for storage by the
   *  caller (MAX_APPLIED_SOURCES). */
  appliedSources: SettlementAppliedSource[]
  /** Every expense whose edit would change the NET this settlement cleared:
   *  the forward sources PLUS the reverse-direction expenses whose remaining
   *  debt offset the forward gross to produce that net (and the forward
   *  units they cancelled). This is the LOCK set — stored as the
   *  settlement's appliedExpenseIds and written into each expense's
   *  settlementLockIds. A forward-only set would leave a reverse offset
   *  expense editable by a non-owner, who could then re-open the settled
   *  balance (e.g. B paid 100→A, A paid 80→B, net A→B 20: editing A's 80
   *  expense changes the 20). */
  lockExpenseIds: string[]
}

function buildSettlementLineage(
  expenses:    PairExpenseForSettlement[],
  settlements: CoreSettlement[],
  fromUid:     string,
  toUid:       string,
  amountMinor: number,
): SettlementLineage {
  const forward = sourceUnitsForDirection(expenses, fromUid, toUid)
  const reverse = sourceUnitsForDirection(expenses, toUid, fromUid)

  const sortedSettlements = [...settlements].sort((a, b) => a.createdAtMs - b.createdAtMs)
  for (const settlement of sortedSettlements) {
    if (!Number.isFinite(settlement.amountMinor) || settlement.amountMinor <= SETTLEMENT_EPS) continue
    if (settlement.fromUid === settlement.toUid) continue
    if (settlement.fromUid === fromUid && settlement.toUid === toUid) {
      consumeSourceUnits(forward, settlement.amountMinor)
    } else if (settlement.fromUid === toUid && settlement.toUid === fromUid) {
      consumeSourceUnits(reverse, settlement.amountMinor)
    }
  }

  const lockIds = new Set<string>()

  // Reverse-direction expenses with remaining debt offset the forward gross
  // to produce the net this settlement clears. They (and the forward units
  // they cancel) are part of the settled balance, so they must be locked
  // even though they are NOT forward "sources" — otherwise editing the
  // reverse expense silently re-opens the debt.
  const reverseRemaining = sourceTotal(reverse)
  if (reverseRemaining > SETTLEMENT_EPS) {
    for (const unit of reverse) {
      if (unit.remainingMinor > SETTLEMENT_EPS) lockIds.add(unit.expenseId)
    }
    for (const offset of consumeSourceUnits(forward, reverseRemaining)) {
      lockIds.add(offset.expenseId)
    }
  }

  const appliedSources = collapseAppliedSources(consumeSourceUnits(forward, amountMinor))
  for (const source of appliedSources) lockIds.add(source.expenseId)

  return { appliedSources, lockExpenseIds: [...lockIds] }
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

function encodeStringArray(values: string[]): FsValue {
  return {
    arrayValue: {
      values: values.map(value => ({ stringValue: value })),
    },
  }
}

function decodeStringArrayField(fields: Record<string, FsValue> | undefined, key: string): string[] {
  const arr = (fields?.[key] as { arrayValue?: { values?: FsValue[] } } | undefined)?.arrayValue?.values ?? []
  return arr
    .map(v => (v as { stringValue?: string }).stringValue)
    .filter((s): s is string => typeof s === 'string')
}

/** Add `settlementId` to each applied expense's `settlementLockIds`
 *  reference set (materialized union). `settlementLockIds.length > 0` is
 *  the single source of truth for the post-settlement edit lock. The
 *  applied expenses are already in the create tx's read/conflict set, so
 *  a concurrent settlement touching the SAME shared expense aborts + retries
 *  — making this read-modify-write race-safe (no lost update). Cross-pair
 *  correct: an expense shared by >2 people accumulates one id per
 *  referencing settlement and stays locked until the last is removed. */
function buildExpenseSettlementLockWrites(
  projectId:      string,
  tripId:         string,
  expenseIds:     string[],
  settlementId:   string,
  currentLockIds: Map<string, string[]>,
): TxWrite[] {
  return expenseIds.map(expenseId => {
    const existing = currentLockIds.get(expenseId) ?? []
    const next = existing.includes(settlementId) ? existing : [...existing, settlementId]
    return {
      document:        docResourceName(projectId, `trips/${tripId}/expenses/${expenseId}`),
      fields:          { settlementLockIds: encodeStringArray(next) },
      updateMask:      ['settlementLockIds'],
      currentDocument: { exists: true },
    }
  })
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

// ─── Foreign-mode prep (split: network resolve, then pure-CPU derive) ──
//
// Phase 4.1 ledger semantics (2026-06-02): settlement.amountMinor ≡
// remaining (full clear). FX does NOT derive amountMinor; it only
// populates the source-side display + audit (sourceAmountMinor +
// fxSnapshot.convertedAmountMinor), which may be ≤ amountMinor by a few
// minor units due to half-even rounding plateaus.
//
// The prep is split in two so the NETWORK half runs OUTSIDE the pair-docs
// conflict window (see doCreate): resolveForeignRate does the FX I/O
// BEFORE the pair fan-out; deriveForeignArtifacts is pure-CPU and runs
// AFTER `remaining` is known.

/** The FX rate + fraction-digit context resolved before the pair fan-out.
 *  Carries everything deriveForeignArtifacts needs so that step touches no
 *  network. `rate` is the non-null result of resolveFxRate. */
interface ForeignRate {
  rate:                 NonNullable<Awaited<ReturnType<typeof resolveFxRate>>>
  sourceFractionDigits: number
  targetFractionDigits: number
}

/** NETWORK half. Rejects same-currency (caller should use TRIP_CURRENCY),
 *  then resolves the FX rate for (sourceCurrency, tripCurrency, settledOn)
 *  via the cache-aware `resolveFxRate`. FxError bubbles to the route
 *  handler → 4xx/5xx per fx-rate.ts's FxErrorCode → status mapping. Runs
 *  before the pair fan-out, so an FX failure is definitively pre-commit
 *  (no pair doc has been read, nothing written). */
async function resolveForeignRate(
  req:                SettlementCreateForeignRequest,
  ctx:                TripCurrencyContext,
  serviceAccountJson: string,
): Promise<ForeignRate> {
  if (req.sourceCurrency === ctx.currency) {
    throw new SettlementValidationError(
      'sourceCurrency',
      `sourceCurrency ${req.sourceCurrency} equals trip currency; use the trip-currency settlement path instead`,
    )
  }

  const rate = await resolveFxRate(
    {
      requestedDate:  req.settledOn,
      sourceCurrency: req.sourceCurrency,
      tripCurrency:   ctx.currency,
    },
    serviceAccountJson,
  )
  if (!rate) {
    // Defensive: resolveFxRate returns null only when source === trip,
    // which we explicitly rejected above. Reaching here means a logic
    // drift; fail closed rather than persist a partial doc.
    throw new CascadeError(500, 'unexpected null rate for foreign settlement (source !== trip)')
  }

  return {
    rate,
    sourceFractionDigits: currencyFractionDigits(req.sourceCurrency),
    targetFractionDigits: currencyFractionDigits(ctx.currency),
  }
}

/** PURE-CPU half. Inverse-derives `sourceAmountMinor` via at-most-target
 *  policy (largest non-negative source minor whose forward conversion does
 *  NOT exceed `remaining`; may be 0 for weak rates against tiny remaining —
 *  caller rejects with SettlementValidationError('sourceCurrency')), then
 *  forward-converts to fill fxSnapshot.convertedAmountMinor (audit). No
 *  network — uses the rate resolved earlier by resolveForeignRate. */
function deriveForeignArtifacts(
  req:       SettlementCreateForeignRequest,
  ctx:       TripCurrencyContext,
  remaining: number,
  fr:        ForeignRate,
): ForeignSettlementArtifacts {
  const sourceAmountMinor = estimateSourceMinorAtMostTargetHalfEven({
    targetMinor:          remaining,
    rateDecimal:          fr.rate.rateDecimal,
    sourceFractionDigits: fr.sourceFractionDigits,
    targetFractionDigits: fr.targetFractionDigits,
  })

  const convertedAmountMinor = convertMinorHalfEven({
    sourceMinor:          sourceAmountMinor,
    rateDecimal:          fr.rate.rateDecimal,
    sourceFractionDigits: fr.sourceFractionDigits,
    targetFractionDigits: fr.targetFractionDigits,
  })

  const fxSnapshot: FxSnapshot = {
    provider:             'frankfurter-v2',
    baseCurrency:         req.sourceCurrency,
    quoteCurrency:        ctx.currency,
    requestedDate:        req.settledOn,
    rateDate:             fr.rate.rateDate,
    rateDecimal:          fr.rate.rateDecimal,
    sourceAmountMinor,
    convertedAmountMinor,
    fetchedAtMs:          fr.rate.fetchedAtMs,
  }

  return {
    sourceCurrency:    req.sourceCurrency,
    sourceAmountMinor,
    settledOn:         req.settledOn,
    fxSnapshot,
  }
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
    const expenseUnlockWrites: TxWrite[] = []
    for (let i = 0; i < appliedExpenseIds.length; i++) {
      const doc = lockedExpenseReads[i]
      if (!doc.exists) continue   // expense already gone (e.g. cascade) — nothing to unlock
      const existing = decodeStringArrayField(doc.fields, 'settlementLockIds')
      if (!existing.includes(req.settlementId)) continue   // not referenced — leave untouched
      expenseUnlockWrites.push({
        document:        docResourceName(projectId, `trips/${req.tripId}/expenses/${appliedExpenseIds[i]}`),
        fields:          { settlementLockIds: encodeStringArray(existing.filter(id => id !== req.settlementId)) },
        updateMask:      ['settlementLockIds'],
        // exists:true so a transform onto a concurrently-deleted expense
        // can't resurrect it as a stub; 412 → retry → the exists check above
        // then skips it.
        currentDocument: { exists: true },
      })
    }

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
