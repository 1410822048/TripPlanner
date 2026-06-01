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
// Settlement FX (Commit 1 of the locked design, 2026-06-01):
//
//   The Worker can also accept FOREIGN_CURRENCY settlements where the
//   payee received money in a non-trip currency. The Worker fetches
//   the FX rate, converts source → trip canonical, and persists the
//   sourceCurrency / sourceAmountMinor / fxSnapshot / settledOn trio
//   alongside the trip-currency amountMinor. The 4 fields move as one
//   group — superRefine below rejects half-populated docs so the
//   downstream balance / replay code only ever sees either
//   "TRIP_CURRENCY-only" or "fully populated FOREIGN" records.
//
//   Commit 1 ships the schema additions DORMANT: client still only
//   sends TRIP_CURRENCY payloads, Worker still validates the
//   pre-Settlement-FX shape. The superRefine is enabled NOW per the
//   [[dormant-schema-must-enforce-group-invariants]] rule so any
//   accidental Worker write of a partial FX group during Commit 2
//   surfaces immediately on read.
import { z } from 'zod'
import type { Timestamp } from 'firebase/firestore'
import {
  CurrencyCodeSchema,
  type FxSnapshot,
  FxSnapshotSchema,
  IsoDateSchema,
  TimestampSchema,
} from './_shared'

// trips/{tripId}/settlements/{settlementId}
export interface SettlementRecord {
  id:          string
  tripId:      string
  fromUid:     string      // payer(reduces their debt)
  toUid:       string      // payee(reduces their credit)
  /** Trip-currency canonical amount, integer minor units. For
   *  FOREIGN_CURRENCY settlements this is the Worker-derived
   *  convertedAmountMinor from the FX snapshot, NOT what the user
   *  typed. */
  amountMinor: number
  currency:    string      // ISO 4217 — always trip currency
  settledBy:   string      // uid that recorded the settlement
  note?:       string
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
  /** FX source-currency fields. Present iff the payee received money
   *  in a non-trip currency. Written by the Worker's foreign-mode
   *  router in Commit 2 of the Settlement FX rollout.
   *
   *  Group invariant (enforced via the schema-level superRefine
   *  below): all four fields are all-or-none, plus cross-field
   *  equality with the parent doc (sourceCurrency ===
   *  fxSnapshot.baseCurrency, amountMinor ===
   *  fxSnapshot.convertedAmountMinor, settledOn ===
   *  fxSnapshot.requestedDate). */
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
export const SettlementDocSchema = z.object({
  tripId:      z.string().min(1),
  fromUid:     z.string().min(1),
  toUid:       z.string().min(1),
  amountMinor: z.number().int().positive(),
  currency:    CurrencyCodeSchema,
  settledBy:   z.string().min(1),
  note:        z.string().max(200).optional(),
  createdAt:   TimestampSchema,
  /** FX source fields. Optional (NOT nullable) — same-currency
   *  settlements simply omit them. The Worker's foreign-mode router
   *  writes the full group in one tx; superRefine below rejects any
   *  partial population. */
  sourceCurrency:    CurrencyCodeSchema.optional(),
  sourceAmountMinor: z.number().int().positive().optional(),
  fxSnapshot:        FxSnapshotSchema.optional(),
  settledOn:         IsoDateSchema.optional(),
}).superRefine((data, ctx) => {
  // FX group all-or-none + cross-field equality with the parent doc.
  //
  // Rationale: TRIP_CURRENCY settlements omit all FX fields
  // (degenerate path); FOREIGN_CURRENCY settlements MUST carry the
  // full 4-field group so the Worker can replay
  // sourceMinor → rateDecimal → convertedMinor from a single
  // authoritative source. Without this gate, a half-populated doc
  // (Worker bug in Commit 2, raw admin write) would parse cleanly and
  // surface as silent display drift in the Commit 3 UI history row
  // (which renders "source (canonical)" double form).
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
  if (data.amountMinor !== fx.convertedAmountMinor) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `amountMinor (${data.amountMinor}) must equal fxSnapshot.convertedAmountMinor (${fx.convertedAmountMinor})`,
      path: ['fxSnapshot', 'convertedAmountMinor'],
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

export interface CreateSettlementInput {
  fromUid:     string
  toUid:       string
  amountMinor: number
  currency:    string
  note?:       string
}
