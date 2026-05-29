// src/types/settlement.ts
// Settlement records — bilateral "X paid Y back" entries stored in
// trips/{tripId}/settlements/{id}. Treated as reverse expenses by
// computeBalances: applying a settlement reduces from's net debt by
// the amount(paid += amountMinor on from, owed += amountMinor on to).
//
// Money domain: amountMinor is integer minor units (matches the
// corresponding expense currency's minor unit), per the money refactor.
// Distinct from `Settlement` in services/settlement.ts(which models
// the algorithm's transfer SUGGESTIONS derived from balances). The
// suggestion is computed; the record is persisted.
import { z } from 'zod'
import type { Timestamp } from 'firebase/firestore'
import { TimestampSchema } from './_shared'

// trips/{tripId}/settlements/{settlementId}
export interface SettlementRecord {
  id:          string
  tripId:      string
  fromUid:     string      // payer(reduces their debt)
  toUid:       string      // payee(reduces their credit)
  amountMinor: number      // integer minor units
  currency:    string      // ISO 4217 — matches expenses' currency
  settledBy:   string      // uid that recorded the settlement
  note?:       string
  createdAt:   Timestamp
}

// Doc-shape schema(no `id` — that's the doc reference). firestoreDocFromSchema
// merges { id, ...parsed.data } so entity callers get the full SettlementRecord.
export const SettlementDocSchema = z.object({
  tripId:      z.string().min(1),
  fromUid:     z.string().min(1),
  toUid:       z.string().min(1),
  amountMinor: z.number().int().positive(),
  currency:    z.string().length(3),
  settledBy:   z.string().min(1),
  note:        z.string().max(200).optional(),
  createdAt:   TimestampSchema,
})

export interface CreateSettlementInput {
  fromUid:     string
  toUid:       string
  amountMinor: number
  currency:    string
  note?:       string
}
