// src/types/settlement.ts
// Settlement records — bilateral "X paid Y back" entries stored in
// trips/{tripId}/settlements/{id}. Treated as reverse expenses by
// computeBalances: applying a settlement reduces from's net debt by
// the amount(paid += amountMinor on from, owed += amountMinor on to).
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
//   modes. The ledger MUST zero the entire pair balance — 「済み」 is
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
   *  be ≤ amountMinor); they're intentionally decoupled so 「済み」
   *  always clears the entire pair balance regardless of FX rounding. */
  amountMinor: number
  currency:    string      // ISO 4217 — always trip currency
  settledBy:   string      // uid that recorded the settlement
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
   * NOT `settledOn`. `settledOn` is the FX-rate lookup key (which UTC
   * day's rate did the Worker pin), `createdAt` is when the
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
  /** UTC date (YYYY-MM-DD) the FX rate was pinned to — typically the
   *  day the payee actually received the money. Same UTC-date policy
   *  as expense.date / fxSnapshot.requestedDate. */
  settledOn?:         string
}

// Doc-shape schema(no `id` — that's the doc reference). firestoreDocFromSchema
// merges { id, ...parsed.data } so entity callers get the full SettlementRecord.
const SettlementAppliedSourceSchema = z.object({
  expenseId:    z.string().min(1).max(60),
  expenseTitle: z.string().min(1).max(100),
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

export const SettlementDocSchema = z.object({
  tripId:      z.string().min(1),
  fromUid:     z.string().min(1),
  toUid:       z.string().min(1),
  amountMinor: z.number().int().positive(),
  currency:    CurrencyCodeSchema,
  settledBy:   z.string().min(1),
  note:        z.string().max(200).optional(),
  appliedSources: z.array(SettlementAppliedSourceSchema).max(80).optional(),
  appliedExpenseIds: z.array(z.string().min(1).max(60)).max(500).optional(),
  createdAt:   TimestampSchema,
  deletedAt:   z.preprocess(
    v => v === undefined ? null : v,
    TimestampSchema.nullable(),
  ),
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
  const hasSourceCurrency = data.sourceCurrency    !== undefined
  const hasSourceAmount   = data.sourceAmountMinor !== undefined
  const hasFx             = data.fxSnapshot        !== undefined
  const hasSettledOn      = data.settledOn         !== undefined
  const groupPresent      = [hasSourceCurrency, hasSourceAmount, hasFx, hasSettledOn].filter(Boolean).length

  // Case 1: TRIP_CURRENCY degenerate path — all four must be absent.
  if (groupPresent === 0) return

  // Case 2: partial population — reject loudly. Skip cross-field
  // checks so the user sees the root-cause shape error, not derivative
  // noise.
  if (groupPresent !== 4) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'FX group must be all-or-none: sourceCurrency, sourceAmountMinor, fxSnapshot, and settledOn must all be present together (or all absent)',
      path: ['fxSnapshot'],
    })
    return
  }

  // Case 3: full FOREIGN_CURRENCY mode — cross-field equality. The
  // non-null assertions are safe because groupPresent===4 guarantees
  // every field is defined.
  const fx = data.fxSnapshot!
  if (data.sourceCurrency !== fx.baseCurrency) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `sourceCurrency (${data.sourceCurrency}) must equal fxSnapshot.baseCurrency (${fx.baseCurrency})`,
      path: ['fxSnapshot', 'baseCurrency'],
    })
  }
  if (data.currency !== fx.quoteCurrency) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `currency (${data.currency}) must equal fxSnapshot.quoteCurrency (${fx.quoteCurrency})`,
      path: ['fxSnapshot', 'quoteCurrency'],
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
})

/**
 * Client-side settlement create input. Discriminated by `mode` —
 * exactly mirrors the Worker's `SettlementCreateRequestSchema` shape so
 * the wire body is a thin translation in `settlementService.ts`.
 *
 * Phase 4.1 rearchitecture (2026-06-02): the payload is now INTENT
 * ONLY. 「済み」 is "clear the suggested debt", not "post an arbitrary
 * amount". The ledger ALWAYS clears the entire pair-remaining for
 * BOTH modes — there is no partial-clear path:
 *   - TRIP_CURRENCY:    payee received money in the trip currency.
 *                       Worker writes `amountMinor = pair-remaining`
 *                       (full clear).
 *   - FOREIGN_CURRENCY: payee received money in a non-trip currency.
 *                       Worker STILL writes `amountMinor = pair-remaining`
 *                       (the ledger truth). FX is decoupled and only
 *                       populates display/audit fields: Worker fetches
 *                       the rate, inverse-derives `sourceAmountMinor`
 *                       from pair-remaining via at-most policy (largest
 *                       source whose forward conversion ≤ remaining),
 *                       and records the forward result in
 *                       `fxSnapshot.convertedAmountMinor` — which may
 *                       be ≤ `amountMinor` by a few minor units due to
 *                       half-even rounding plateaus, and that's expected.
 *                       `sourceAmountMinor` / `fxSnapshot` are display
 *                       and audit data only, NEVER ledger inputs.
 *
 * Eliminates two whole classes of bug by construction:
 *   - OVERPAY: client can't ship a too-large amount because client
 *     doesn't ship an amount at all.
 *   - PARTIAL CLEAR: the ledger always consumes remaining, so FX
 *     rounding can't leave a few-yen orphan tail on the pair balance.
 *
 * Optimistic-cache rows: the page-level mutation uses
 * `suggestion.amountMinor` (= pair-remaining) as the optimistic
 * `amountMinor` for BOTH modes, exactly matching what the Worker will
 * write. Foreign mode additionally derives `sourceAmountMinor` via
 * `useFxPreview` for the optimistic source-side display — that field
 * doesn't cross the wire (Worker re-derives authoritatively from its
 * own fresh rate).
 */
export interface CreateTripSettlementInput {
  mode:                   'TRIP_CURRENCY'
  fromUid:                string
  toUid:                  string
  /** Pair remaining shown to the user when they confirmed the sheet.
   *  Worker still computes the canonical amount from the transaction
   *  snapshot; this value is only a stale-confirmation guard. */
  expectedRemainingMinor: number
  note?:                  string
}

export interface CreateForeignSettlementInput {
  mode:                   'FOREIGN_CURRENCY'
  fromUid:                string
  toUid:                  string
  expectedRemainingMinor: number
  sourceCurrency:         string
  /** UTC YYYY-MM-DD the payee received the foreign money. Worker pins
   *  the FX rate to this date. */
  settledOn:              string
  note?:                  string
}

export type CreateSettlementInput =
  | CreateTripSettlementInput
  | CreateForeignSettlementInput
