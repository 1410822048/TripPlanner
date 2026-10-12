// src/types/settlement.ts
// Settlement records — bilateral "X paid Y back" entries stored in
// trips/{tripId}/settlements/{id}. Under the debt-edge model
// (services/settlement.ts) a settlement only REDUCES the existing
// pairwise debt from → to, capped at that debt (any excess surfaces as an
// orphan). It is NOT a reverse expense: `paid` / `owed` reflect expenses
// only; `net` comes from the remaining debt after settlements.
//
// Money domain: amountMinor is integer minor units (matches the trip
// currency's minor unit), per the money refactor. Distinct from
// `Settlement` in services/settlement.ts(which models the algorithm's
// transfer SUGGESTIONS derived from balances). The suggestion is
// computed; the record is persisted.
//
// Settlement FX (Phase 4.1 ledger semantics, 2026-06-02):
//
//   The Worker accepts FOREIGN_CURRENCY settlements where the payee
//   received money in a non-trip currency. The Worker fetches the FX
//   rate, computes a display source amount via atMost policy, and
//   persists the sourceCurrency / sourceAmountMinor / fxSnapshot /
//   settledOn quartet alongside the trip-currency amountMinor.
//
//   Critical invariant: amountMinor ≡ remaining (full clear) for BOTH
//   modes. The ledger MUST zero the entire pair balance — 「已收款」 is
//   intent-driven, not amount-entry. FX is decoupled:
//     - sourceAmountMinor + fxSnapshot.convertedAmountMinor record what
//       the FX math produced (≤ amountMinor, may diverge by a few minor
//       units due to half-even rounding plateaus).
//     - amountMinor is what the ledger consumes — always = remaining.
//
//   Group invariant (enforced via superRefine below): the four source
//   fields are all-or-none, plus cross-field equality with the parent
//   doc for fields where it makes sense (sourceCurrency,
//   sourceAmountMinor, settledOn). The amountMinor === fx.
//   convertedAmountMinor check was DROPPED in Phase 4.1 because the
//   two values are intentionally decoupled.
import { z } from 'zod'
import type { Timestamp } from 'firebase/firestore'
import { SETTLEMENT_LIMITS } from '@tripmate/entity-contracts'
import { MAX_ROUTE_PARTICIPANTS, ROUTE_ID_MAX } from '@tripmate/settlement-core'
import {
  CurrencyCodeSchema,
  type FxSnapshot,
  FxSnapshotSchema,
  IsoDateSchema,
  TimestampSchema,
} from './_shared'

export interface SettlementAppliedSource {
  /** Expense doc id this settlement consumed at record time. */
  expenseId:    string
  /** Snapshot of the title so the audit row survives later edits/deletes. */
  expenseTitle: string
  /** Present when the source came from a receipt line item. */
  itemId?:      string
  /** Snapshot of the item name so item deletion still leaves context. */
  itemName?:    string
  /** Portion of settlement.amountMinor attributed to this source. */
  amountMinor:  number
}

// trips/{tripId}/settlements/{settlementId}
export interface SettlementRecord {
  id:          string
  tripId:      string
  fromUid:     string      // payer(reduces their debt)
  toUid:       string      // payee(reduces their credit)
  /** Trip-currency ledger amount, integer minor units. Phase 4.1: this
   *  ALWAYS equals the pair-remaining the Worker computed at tx time —
   *  for BOTH TRIP_CURRENCY and FOREIGN_CURRENCY modes. Foreign mode's
   *  `fxSnapshot.convertedAmountMinor` is the FX forward result (may
   *  be ≤ amountMinor); they're intentionally decoupled so 「已收款」
   *  always clears the entire pair balance regardless of FX rounding. */
  amountMinor: number
  currency:    string      // ISO 4217 — always trip currency
  settledBy:   string      // uid that recorded the settlement
  /** Set when the trip owner recorded the receipt for a receiver who had
   *  left the trip (toUid). Absent on ordinary receiver-confirmed rows. */
  recordedOnBehalfOf?: string
  /** Present iff this settlement is one leg of a routed settlement (a
   *  multi-hop transfer or a debt-cycle offset). Every leg of a route
   *  carries the same header; the route is cancelled as a whole. Leg docs
   *  never carry the top-level note / FX group — those live here. */
  route?:      SettlementRouteHeader
  note?:       string
  /** Worker-derived audit snapshot of which expense/item debt this
   *  settlement consumed. Never trusted from the client; used only for
   *  post-edit orphan explanations in the history UI. */
  appliedSources?: SettlementAppliedSource[]
  /** Queryable source-expense ids derived by the Worker. Used to lock
   *  already-settled source expenses for non-owner editors. */
  appliedExpenseIds?: string[]
  /**
   * Chronological event timestamp — drives orphan reason
   * classification in `computeBalancesFull`. THIS is the ordering key,
   * NOT `settledOn`. `settledOn` is the FX-rate lookup key (which of the
   * user's calendar days the Worker pinned a rate to), `createdAt` is when the
   * settlement was recorded relative to expense_create /
   * expense_delete events. Keeping the two roles distinct is what
   * lets phase-2 chronological replay correctly classify OVERPAYMENT
   * vs EXPENSE_DELETED.
   */
  createdAt:   Timestamp
  /** Soft-delete tombstone. `null` on active settlements; the Worker
   *  stamps its own REQUEST_TIME here on cancel instead of hard-
   *  deleting the doc. This is what lets the push-notification
   *  Firestore trigger recover the actual canceller's uid via
   *  `deletedBy` -- a hard delete only carries `before` in the
   *  trigger, whose `settledBy` is the recorder, not necessarily
   *  whoever cancelled. */
  deletedAt:   Timestamp | null
  /** uid that cancelled the settlement. Present iff `deletedAt` is
   *  set -- enforced by SettlementDocSchema's superRefine below. */
  deletedBy?:  string
  /** FX source-currency fields. Present iff the payee received money
   *  in a non-trip currency. Written by the Worker's foreign-mode
   *  router.
   *
   *  Group invariant (enforced via the schema-level superRefine
   *  below): all four fields are all-or-none, plus cross-field
   *  equality with the parent doc:
   *    sourceCurrency    === fxSnapshot.baseCurrency
   *    currency          === fxSnapshot.quoteCurrency
   *    sourceAmountMinor === fxSnapshot.sourceAmountMinor
   *    settledOn         === fxSnapshot.requestedDate
   *
   *  Phase 4.1 explicitly drops the `amountMinor === fx.convertedAmountMinor`
   *  invariant — the two are decoupled (amountMinor is the ledger
   *  clear, convertedAmountMinor is the FX forward result). */
  sourceCurrency?:    string
  sourceAmountMinor?: number
  fxSnapshot?:        FxSnapshot
  /** Calendar date (YYYY-MM-DD) in the RECORDING USER's timezone — the
   *  day the payee received the money, as they would say it. Same policy
   *  as expense.date. Not a UTC date: east of Greenwich the two differ
   *  for part of every day, and bounding this by UTC made the sheet
   *  refuse the user's own today.
   *
   *  `fxSnapshot.rateDate` is the one that IS a UTC date — it is the
   *  provider's publication day, and cannot run ahead of it. */
  settledOn?:         string
}

// Doc-shape schema(no `id` — that's the doc reference). firestoreDocFromSchema
// merges { id, ...parsed.data } so entity callers get the full SettlementRecord.
const SettlementAppliedSourceSchema = z.object({
  expenseId:    z.string().min(1).max(60),
  // Read side accepts 200 (the Worker's former expense-title cap) so
  // settlements written before lineage titles were truncated still parse;
  // a single over-long one used to fail the whole settlements listener.
  expenseTitle: z.string().min(1).max(SETTLEMENT_LIMITS.lineageTitleRead),
  itemId:       z.string().min(1).max(64).optional(),
  itemName:     z.string().min(1).max(200).optional(),
  amountMinor:  z.number().int().positive(),
}).superRefine((data, ctx) => {
  const hasItemId = data.itemId !== undefined
  const hasItemName = data.itemName !== undefined
  if (hasItemId !== hasItemName) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'itemId and itemName must be present together',
      path: ['itemId'],
    })
  }
})

/** The `route` map on a routed-settlement leg (Worker
 *  settlement-route-write.ts). */
export interface SettlementRouteHeader {
  id:              string
  legIndex:        number
  legCount:        number
  kind:            'TRANSFER' | 'OFFSET'
  /** Sorted uids of everyone the route's legs touch. */
  participantUids: string[]
  /** TRANSFER only: who paid whom how much (trip currency). */
  payerUid?:       string
  receiverUid?:    string
  amountMinor?:    number
  /** The trip owner recorded it for departed members. */
  ownerRecorded?:  true
  note?:           string
  /** TRANSFER only, all-or-none: the currency the receiver actually got.
   *  Same group invariant as the settlement-level FX fields. */
  sourceCurrency?:    string
  sourceAmountMinor?: number
  settledOn?:         string
  fxSnapshot?:        FxSnapshot
}

// Bounds stay looser than the Worker's write caps (45 legs) on purpose: a
// parser that is stricter than what might be stored would drop the whole
// settlements listener for everyone.
const SettlementRouteHeaderSchema = z.object({
  id:              z.string().min(1).max(ROUTE_ID_MAX),
  legIndex:        z.number().int().nonnegative(),
  legCount:        z.number().int().min(1).max(99),
  kind:            z.enum(['TRANSFER', 'OFFSET']),
  participantUids: z.array(z.string().min(1)).min(2).max(MAX_ROUTE_PARTICIPANTS * 2),
  payerUid:        z.string().min(1).optional(),
  receiverUid:     z.string().min(1).optional(),
  amountMinor:     z.number().int().positive().optional(),
  ownerRecorded:   z.literal(true).optional(),
  note:            z.string().max(SETTLEMENT_LIMITS.note).optional(),
  sourceCurrency:    CurrencyCodeSchema.optional(),
  sourceAmountMinor: z.number().int().positive().optional(),
  settledOn:         IsoDateSchema.optional(),
  fxSnapshot:        FxSnapshotSchema.optional(),
}).superRefine((data, ctx) => {
  if (data.legIndex >= data.legCount) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'legIndex must be < legCount', path: ['legIndex'] })
  }
  const transferFields = [data.payerUid, data.receiverUid, data.amountMinor].filter(v => v !== undefined).length
  if (data.kind === 'TRANSFER' ? transferFields !== 3 : transferFields !== 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'payerUid / receiverUid / amountMinor belong to TRANSFER routes, all together', path: ['kind'] })
  }
  checkFxGroup(data, ctx)
  if (data.kind === 'OFFSET' && data.sourceCurrency !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'an offset moves no money and has no source currency', path: ['sourceCurrency'] })
  }
})

/** FX source group: all-or-none, and the parts must agree with the
 *  snapshot. Shared by the settlement doc and the route header. */
function checkFxGroup(
  data: { sourceCurrency?: string; sourceAmountMinor?: number; fxSnapshot?: FxSnapshot; settledOn?: string },
  ctx:  z.RefinementCtx,
): FxSnapshot | null {
  const present = [data.sourceCurrency, data.sourceAmountMinor, data.fxSnapshot, data.settledOn]
    .filter(v => v !== undefined).length
  if (present === 0) return null
  if (present !== 4) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'FX group must be all-or-none: sourceCurrency, sourceAmountMinor, fxSnapshot, and settledOn must all be present together (or all absent)',
      path: ['fxSnapshot'],
    })
    return null
  }
  const fx = data.fxSnapshot!
  if (data.sourceCurrency !== fx.baseCurrency) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `sourceCurrency (${data.sourceCurrency}) must equal fxSnapshot.baseCurrency (${fx.baseCurrency})`,
      path: ['fxSnapshot', 'baseCurrency'],
    })
  }
  if (data.sourceAmountMinor !== fx.sourceAmountMinor) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `sourceAmountMinor (${data.sourceAmountMinor}) must equal fxSnapshot.sourceAmountMinor (${fx.sourceAmountMinor})`,
      path: ['fxSnapshot', 'sourceAmountMinor'],
    })
  }
  if (data.settledOn !== fx.requestedDate) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `settledOn (${data.settledOn}) must equal fxSnapshot.requestedDate (${fx.requestedDate})`,
      path: ['fxSnapshot', 'requestedDate'],
    })
  }
  return fx
}

export const SettlementDocSchema = z.object({
  tripId:      z.string().min(1),
  fromUid:     z.string().min(1),
  toUid:       z.string().min(1),
  amountMinor: z.number().int().positive(),
  currency:    CurrencyCodeSchema,
  settledBy:   z.string().min(1),
  recordedOnBehalfOf: z.string().min(1).optional(),
  route:       SettlementRouteHeaderSchema.optional(),
  note:        z.string().max(SETTLEMENT_LIMITS.note).optional(),
  appliedSources: z.array(SettlementAppliedSourceSchema).max(80).optional(),
  appliedExpenseIds: z.array(z.string().min(1).max(60)).max(500).optional(),
  createdAt:   TimestampSchema,
  deletedAt:   TimestampSchema.nullable(),
  deletedBy:   z.string().min(1).max(128).optional(),
  /** FX source fields. Optional (NOT nullable) — same-currency
   *  settlements simply omit them. The Worker's foreign-mode router
   *  writes the full group in one tx; superRefine below rejects any
   *  partial population. */
  sourceCurrency:    CurrencyCodeSchema.optional(),
  sourceAmountMinor: z.number().int().positive().optional(),
  fxSnapshot:        FxSnapshotSchema.optional(),
  settledOn:         IsoDateSchema.optional(),
}).superRefine((data, ctx) => {
  // deletedAt / deletedBy iff-pair: cancelled settlements must carry
  // the canceller's uid, active ones must not. Independent of the FX
  // group check below.
  const isDeleted = data.deletedAt !== null
  if (isDeleted && data.deletedBy === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'deletedBy is required when deletedAt is set',
      path: ['deletedBy'],
    })
  }
  if (!isDeleted && data.deletedBy !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'deletedBy is only allowed when deletedAt is set',
      path: ['deletedBy'],
    })
  }

  // FX group all-or-none + cross-field equality with the parent doc.
  //
  // Rationale: TRIP_CURRENCY settlements omit all FX fields
  // (degenerate path); FOREIGN_CURRENCY settlements MUST carry the
  // full 4-field group so the Worker can replay
  // sourceMinor → rateDecimal → convertedMinor from a single
  // authoritative source. Without this gate, a half-populated doc
  // (Worker bug, raw admin write) would parse cleanly and surface as
  // silent display drift in the UI history row.
  //
  // Phase 4.1 explicitly OMITS `amountMinor === fx.convertedAmountMinor`
  // — the ledger amount is decoupled from the FX forward result
  // (amountMinor = remaining; convertedAmountMinor = forward(source)).
  const fx = checkFxGroup(data, ctx)
  if (fx && data.currency !== fx.quoteCurrency) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `currency (${data.currency}) must equal fxSnapshot.quoteCurrency (${fx.quoteCurrency})`,
      path: ['fxSnapshot', 'quoteCurrency'],
    })
  }
  const routeFx = data.route?.fxSnapshot
  if (routeFx && data.currency !== routeFx.quoteCurrency) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `currency (${data.currency}) must equal route.fxSnapshot.quoteCurrency (${routeFx.quoteCurrency})`,
      path: ['route', 'fxSnapshot', 'quoteCurrency'],
    })
  }
})
