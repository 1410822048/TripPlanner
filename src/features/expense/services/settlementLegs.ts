// src/features/expense/services/settlementLegs.ts
// The ledger's view of settlements. A settlement doc is a route holding its
// legs; the debt math, orphan attribution and the chronological replay all
// work per LEG (each leg clears one pair's debt), so they read this flat
// list instead of the docs. Pure, no side effects.
import type { Timestamp } from 'firebase/firestore'
import { legSources, type SettlementAppliedSource, type SettlementRecord } from '@/types/settlement'

export interface SettlementLeg {
  /** Unique per leg across the trip: `${settlementId}#${legIndex}`. */
  key:          string
  /** The settlement (route) doc this leg belongs to — what a cancel takes. */
  settlementId: string
  legIndex:     number
  fromUid:      string
  toUid:        string
  amountMinor:  number
  /** The settlement's createdAt: every leg of a route was applied at once. */
  createdAt:    Timestamp
  /** This leg's display lineage (possibly trimmed; see SettlementRecord). */
  sources:      SettlementAppliedSource[]
  /** The expenses this leg locks (complete). */
  lockExpenseIds: string[]
}

export const legKey = (settlementId: string, legIndex: number) => `${settlementId}#${legIndex}`

/** Every leg of every given settlement, in settlement order then leg order. */
export function settlementLegs(records: SettlementRecord[]): SettlementLeg[] {
  return records.flatMap(record => record.legs.map((leg, legIndex) => ({
    key:          legKey(record.id, legIndex),
    settlementId: record.id,
    legIndex,
    fromUid:      leg.fromUid,
    toUid:        leg.toUid,
    amountMinor:  leg.amountMinor,
    createdAt:    record.createdAt,
    sources:      legSources(record, legIndex),
    lockExpenseIds: (record.lockedExpenses ?? []).filter(lock => lock.legIndexes.includes(legIndex)).map(lock => lock.expenseId),
  })))
}
