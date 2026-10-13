// src/types/settlement.ts
// Settlement records — trips/{tripId}/settlements/{id}. Every record is one
// LEG of a routed settlement (a multi-hop transfer "A → C via B", a debt-
// cycle offset, or simply a one-leg pair settlement): an ordinary
// "fromUid paid toUid amountMinor" on a real debt edge, plus the `route`
// header every leg of the same route shares. Written only by the Worker
// (/settlement-route-create), cancelled only as a whole route
// (/settlement-delete). See docs/design/settlement-debt-simplification.md.
//
// Under the debt-edge model (services/settlement.ts) a leg only REDUCES the
// existing pairwise debt from → to, capped at that debt (any excess
// surfaces as an orphan). It is NOT a reverse expense: `paid` / `owed`
// reflect expenses only; `net` comes from the remaining debt.
//
// Money domain: amountMinor is integer minor units of the trip currency.
// The currency the receiver actually got (foreign settlement) lives on the
// route header only: an intermediate never paid anyone in foreign money.
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
  /** Expense doc id this leg consumed at record time. */
  expenseId:    string
  /** Snapshot of the title so the audit row survives later edits/deletes. */
  expenseTitle: string
  /** Present when the source came from a receipt line item. */
  itemId?:      string
  /** Snapshot of the item name so item deletion still leaves context. */
  itemName?:    string
  /** Portion of the leg's amountMinor attributed to this source. */
  amountMinor:  number
}

/** The `route` map every leg carries (Worker settlement-route-write.ts). */
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
   *  sourceAmountMinor is display + audit (at-most inverse of amountMinor);
   *  the ledger only ever consumes the trip-currency leg amounts. */
  sourceCurrency?:    string
  sourceAmountMinor?: number
  /** The receiver's calendar day (their timezone), pins the FX rate. */
  settledOn?:         string
  fxSnapshot?:        FxSnapshot
}

// trips/{tripId}/settlements/{settlementId}
export interface SettlementRecord {
  id:          string
  tripId:      string
  fromUid:     string      // this leg's debtor
  toUid:       string      // this leg's creditor
  /** Trip-currency amount this leg clears, integer minor units. */
  amountMinor: number
  currency:    string      // ISO 4217 — always trip currency
  settledBy:   string      // uid that recorded the route (same on every leg)
  route:       SettlementRouteHeader
  /** Worker-derived audit snapshot of which expense/item debt this leg
   *  consumed. Never trusted from the client; used for the history detail
   *  and post-edit orphan explanations. */
  appliedSources?: SettlementAppliedSource[]
  /** Expenses this leg locks (forward sources ∪ reverse offset). */
  appliedExpenseIds?: string[]
  /** Chronological event timestamp — the ordering key for orphan reason
   *  classification (computeBalancesFull). */
  createdAt:   Timestamp
  /** Soft-delete tombstone (the Worker stamps REQUEST_TIME on cancel) so
   *  the push trigger can recover the canceller via `deletedBy`. */
  deletedAt:   Timestamp | null
  /** Present iff `deletedAt` is set. */
  deletedBy?:  string
}

const SettlementAppliedSourceSchema = z.object({
  expenseId:    z.string().min(1).max(60),
  expenseTitle: z.string().min(1).max(SETTLEMENT_LIMITS.lineageTitleRead),
  itemId:       z.string().min(1).max(64).optional(),
  itemName:     z.string().min(1).max(200).optional(),
  amountMinor:  z.number().int().positive(),
}).superRefine((data, ctx) => {
  if ((data.itemId !== undefined) !== (data.itemName !== undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'itemId and itemName must be present together',
      path: ['itemId'],
    })
  }
})

// Bounds stay looser than the Worker's write caps (45 legs) on purpose: a
// parser stricter than what might be stored would drop the whole
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

  // FX group: all-or-none, parts agree with the snapshot, offsets have none.
  const present = [data.sourceCurrency, data.sourceAmountMinor, data.fxSnapshot, data.settledOn]
    .filter(v => v !== undefined).length
  if (present === 0) return
  if (data.kind === 'OFFSET') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'an offset moves no money and has no source currency', path: ['sourceCurrency'] })
    return
  }
  if (present !== 4) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'FX group must be all-or-none: sourceCurrency, sourceAmountMinor, fxSnapshot, and settledOn',
      path: ['fxSnapshot'],
    })
    return
  }
  const fx = data.fxSnapshot!
  if (data.sourceCurrency !== fx.baseCurrency) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `sourceCurrency (${data.sourceCurrency}) must equal fxSnapshot.baseCurrency (${fx.baseCurrency})`, path: ['fxSnapshot', 'baseCurrency'] })
  }
  if (data.sourceAmountMinor !== fx.sourceAmountMinor) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `sourceAmountMinor (${data.sourceAmountMinor}) must equal fxSnapshot.sourceAmountMinor (${fx.sourceAmountMinor})`, path: ['fxSnapshot', 'sourceAmountMinor'] })
  }
  if (data.settledOn !== fx.requestedDate) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `settledOn (${data.settledOn}) must equal fxSnapshot.requestedDate (${fx.requestedDate})`, path: ['fxSnapshot', 'requestedDate'] })
  }
})

export const SettlementDocSchema = z.object({
  tripId:      z.string().min(1),
  fromUid:     z.string().min(1),
  toUid:       z.string().min(1),
  amountMinor: z.number().int().positive(),
  currency:    CurrencyCodeSchema,
  settledBy:   z.string().min(1),
  route:       SettlementRouteHeaderSchema,
  appliedSources: z.array(SettlementAppliedSourceSchema).max(80).optional(),
  appliedExpenseIds: z.array(z.string().min(1).max(60)).max(500).optional(),
  createdAt:   TimestampSchema,
  deletedAt:   TimestampSchema.nullable(),
  deletedBy:   z.string().min(1).max(128).optional(),
}).superRefine((data, ctx) => {
  // deletedAt / deletedBy iff-pair: cancelled legs carry the canceller.
  const isDeleted = data.deletedAt !== null
  if (isDeleted && data.deletedBy === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'deletedBy is required when deletedAt is set', path: ['deletedBy'] })
  }
  if (!isDeleted && data.deletedBy !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'deletedBy is only allowed when deletedAt is set', path: ['deletedBy'] })
  }
  const fx = data.route.fxSnapshot
  if (fx && data.currency !== fx.quoteCurrency) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `currency (${data.currency}) must equal route.fxSnapshot.quoteCurrency (${fx.quoteCurrency})`,
      path: ['route', 'fxSnapshot', 'quoteCurrency'],
    })
  }
})
