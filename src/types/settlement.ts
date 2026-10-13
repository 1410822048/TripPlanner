// src/types/settlement.ts
// Settlement records — trips/{tripId}/settlements/{id}. Every settlement is
// a ROUTE stored as one doc: a pair payment (one leg), a multi-hop transfer
// "A → C via B" (several legs), or a debt-cycle offset (no money moved).
// Each leg is an ordinary "fromUid cleared amountMinor of their debt to
// toUid" on a real debt edge. Written only by the Worker
// (/settlement-route-create), cancelled only as a whole
// (/settlement-delete). See docs/design/settlement-debt-simplification.md.
//
// Under the debt-edge model (services/settlement.ts) a leg only REDUCES the
// existing pairwise debt from → to, capped at that debt (any excess
// surfaces as an orphan). It is NOT a reverse expense: `paid` / `owed`
// reflect expenses only; `net` comes from the remaining debt.
//
// Money domain: every amountMinor is integer minor units of the trip
// currency. The currency the receiver actually got (foreign settlement)
// describes the transfer only: an intermediate never paid anyone in foreign
// money.
import { z } from 'zod'
import type { Timestamp } from 'firebase/firestore'
import { EXPENSE_LIMITS, SETTLEMENT_LIMITS } from '@tripmate/entity-contracts'
import { MAX_ROUTE_PARTICIPANTS } from '@tripmate/settlement-core'
import {
  CurrencyCodeSchema,
  type FxSnapshot,
  FxSnapshotSchema,
  IsoDateSchema,
  TimestampSchema,
} from './_shared'

/** One leg: a clear of `fromUid`'s debt to `toUid`. */
export interface SettlementLegRecord {
  fromUid:     string
  toUid:       string
  amountMinor: number
}

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

/** A source as stored: tagged with the leg it belongs to. */
export interface StoredAppliedSource extends SettlementAppliedSource {
  legIndex: number
}

/** An expense this settlement locks, and which of its legs lock it. */
export interface LockedExpense {
  expenseId:  string
  legIndexes: number[]
}

// trips/{tripId}/settlements/{settlementId}
export interface SettlementRecord {
  id:              string
  tripId:          string
  kind:            'TRANSFER' | 'OFFSET'
  currency:        string      // ISO 4217 — always trip currency
  /** Sorted uids of everyone the legs touch. */
  participantUids: string[]
  /** Canonical order (by from, then to); lineage refers to legs by index. */
  legs:            SettlementLegRecord[]
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
  /** Worker-derived audit snapshot of which expense / item debt each leg
   *  consumed (oldest first, trimmed to a route-wide budget — a leg's
   *  untraced remainder is shown as such). Never trusted from the client. */
  appliedSources?: StoredAppliedSource[]
  /** Every expense this settlement locks, each once with the legs that lock
   *  it (complete, never trimmed) — what expense.settlementLockIds holds
   *  this id for. */
  lockedExpenses?: LockedExpense[]
  settledBy:   string      // uid that recorded it
  /** Chronological event timestamp — the ordering key for the debt fold and
   *  orphan reason classification (computeBalancesFull). */
  createdAt:   Timestamp
  /** Soft-delete tombstone (the Worker stamps REQUEST_TIME on cancel) so
   *  the push trigger can recover the canceller via `deletedBy`. */
  deletedAt:   Timestamp | null
  /** Present iff `deletedAt` is set. */
  deletedBy?:  string
}

const UidSchema = z.string().min(1).max(128)

const SettlementLegSchema = z.object({
  fromUid:     UidSchema,
  toUid:       UidSchema,
  amountMinor: z.number().int().positive(),
}).refine(leg => leg.fromUid !== leg.toUid, { message: 'a leg cannot clear a debt to oneself', path: ['toUid'] })

const StoredAppliedSourceSchema = z.object({
  legIndex:     z.number().int().nonnegative(),
  expenseId:    z.string().min(1).max(60),
  expenseTitle: z.string().min(1).max(SETTLEMENT_LIMITS.lineageTitleRead),
  itemId:       z.string().min(1).max(64).optional(),
  itemName:     z.string().min(1).max(EXPENSE_LIMITS.itemName).optional(),
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

// Bounds stay looser than the Worker's write caps (45 legs, 400 sources) on
// purpose: a parser stricter than what might be stored would drop the whole
// settlements listener for everyone.
export const SettlementDocSchema = z.object({
  tripId:          z.string().min(1),
  kind:            z.enum(['TRANSFER', 'OFFSET']),
  currency:        CurrencyCodeSchema,
  participantUids: z.array(UidSchema).min(2).max(MAX_ROUTE_PARTICIPANTS * 2),
  legs:            z.array(SettlementLegSchema).min(1).max(99),
  payerUid:        UidSchema.optional(),
  receiverUid:     UidSchema.optional(),
  amountMinor:     z.number().int().positive().optional(),
  ownerRecorded:   z.literal(true).optional(),
  note:            z.string().max(SETTLEMENT_LIMITS.note).optional(),
  sourceCurrency:    CurrencyCodeSchema.optional(),
  sourceAmountMinor: z.number().int().positive().optional(),
  settledOn:         IsoDateSchema.optional(),
  fxSnapshot:        FxSnapshotSchema.optional(),
  appliedSources:    z.array(StoredAppliedSourceSchema).max(1000).optional(),
  lockedExpenses:    z.array(z.object({
    expenseId:  z.string().min(1).max(60),
    legIndexes: z.array(z.number().int().nonnegative()).min(1).max(99),
  })).max(1000).optional(),
  settledBy:   UidSchema,
  createdAt:   TimestampSchema,
  deletedAt:   TimestampSchema.nullable(),
  deletedBy:   UidSchema.optional(),
}).superRefine((data, ctx) => {
  const issue = (message: string, path: (string | number)[]) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, message, path })

  // deletedAt / deletedBy iff-pair: cancelled settlements carry the canceller.
  const isDeleted = data.deletedAt !== null
  if (isDeleted && data.deletedBy === undefined) issue('deletedBy is required when deletedAt is set', ['deletedBy'])
  if (!isDeleted && data.deletedBy !== undefined) issue('deletedBy is only allowed when deletedAt is set', ['deletedBy'])

  const transferFields = [data.payerUid, data.receiverUid, data.amountMinor].filter(v => v !== undefined).length
  if (data.kind === 'TRANSFER' ? transferFields !== 3 : transferFields !== 0) {
    issue('payerUid / receiverUid / amountMinor belong to TRANSFER settlements, all together', ['kind'])
  }
  data.appliedSources?.forEach((source, i) => {
    if (source.legIndex >= data.legs.length) issue('appliedSources legIndex must name a leg', ['appliedSources', i, 'legIndex'])
  })
  data.lockedExpenses?.forEach((lock, i) => {
    if (lock.legIndexes.some(legIndex => legIndex >= data.legs.length)) issue('lockedExpenses legIndexes must name legs', ['lockedExpenses', i, 'legIndexes'])
  })

  // FX group: all-or-none, parts agree with the snapshot, offsets have none.
  const present = [data.sourceCurrency, data.sourceAmountMinor, data.fxSnapshot, data.settledOn]
    .filter(v => v !== undefined).length
  if (present === 0) return
  if (data.kind === 'OFFSET') {
    issue('an offset moves no money and has no source currency', ['sourceCurrency'])
    return
  }
  if (present !== 4) {
    issue('FX group must be all-or-none: sourceCurrency, sourceAmountMinor, fxSnapshot, and settledOn', ['fxSnapshot'])
    return
  }
  const fx = data.fxSnapshot!
  if (data.sourceCurrency !== fx.baseCurrency) {
    issue(`sourceCurrency (${data.sourceCurrency}) must equal fxSnapshot.baseCurrency (${fx.baseCurrency})`, ['fxSnapshot', 'baseCurrency'])
  }
  if (data.sourceAmountMinor !== fx.sourceAmountMinor) {
    issue(`sourceAmountMinor (${data.sourceAmountMinor}) must equal fxSnapshot.sourceAmountMinor (${fx.sourceAmountMinor})`, ['fxSnapshot', 'sourceAmountMinor'])
  }
  if (data.settledOn !== fx.requestedDate) {
    issue(`settledOn (${data.settledOn}) must equal fxSnapshot.requestedDate (${fx.requestedDate})`, ['fxSnapshot', 'requestedDate'])
  }
  if (data.currency !== fx.quoteCurrency) {
    issue(`currency (${data.currency}) must equal fxSnapshot.quoteCurrency (${fx.quoteCurrency})`, ['fxSnapshot', 'quoteCurrency'])
  }
})

/** The display sources of leg `legIndex`, in lineage (oldest-first) order. */
export function legSources(record: Pick<SettlementRecord, 'appliedSources'>, legIndex: number): SettlementAppliedSource[] {
  return (record.appliedSources ?? [])
    .filter(source => source.legIndex === legIndex)
    .map(source => {
      const out: SettlementAppliedSource = { expenseId: source.expenseId, expenseTitle: source.expenseTitle, amountMinor: source.amountMinor }
      if (source.itemId !== undefined && source.itemName !== undefined) {
        out.itemId = source.itemId
        out.itemName = source.itemName
      }
      return out
    })
}

/** Every expense id the settlement locks (any leg). */
export function lockedExpenseIds(record: Pick<SettlementRecord, 'lockedExpenses'>): string[] {
  return (record.lockedExpenses ?? []).map(lock => lock.expenseId)
}
