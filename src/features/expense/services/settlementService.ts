// src/features/expense/services/settlementService.ts
// CRUD + realtime listener for trips/{tripId}/settlements/{id}. See
// src/types/settlement.ts for the entity model and why this is treated
// as a reverse-expense by computeBalances.
import type { QueryDocumentSnapshot } from 'firebase/firestore'
import { getFirebase } from '@/services/firebase'
import { firestoreDocFromSchema } from '@/services/firestoreDocFromSchema'
import { parseListSnapshot } from '@/services/parseListSnapshot'
import { captureError } from '@/services/sentry'
import { P } from '@/services/paths'
import { subscribeToCollection } from '@/services/realtimeQuery'
import {
  type SettlementRecord,
  type CreateSettlementInput,
  SettlementDocSchema,
} from '@/types/settlement'

/** Defensive cap — long trips with many splits accumulate settlement
 *  records over time. 200 covers a 14-day group trip with margin. */
const LIST_LIMIT = 200

function settlementFromDoc(d: QueryDocumentSnapshot): SettlementRecord {
  return firestoreDocFromSchema(SettlementDocSchema, d, 'settlementFromDoc')
}

export async function getSettlementsByTrip(tripId: string): Promise<SettlementRecord[]> {
  const { db, collection, query, orderBy, limit, getDocs } = await getFirebase()
  const q = query(
    collection(db, ...P.settlements(tripId)),
    orderBy('createdAt', 'desc'),
    limit(LIST_LIMIT),
  )
  const snap = await getDocs(q)
  if (snap.size >= LIST_LIMIT) {
    captureError(new Error(`getSettlementsByTrip truncated at ${LIST_LIMIT}`), { tripId })
  }
  return parseListSnapshot(snap, settlementFromDoc)
}

export const subscribeToSettlements = (
  tripId: string,
  onData: (rows: SettlementRecord[]) => void,
  onError: (e: Error) => void,
) => subscribeToCollection<SettlementRecord>({
  buildQuery: ({ db, collection, query, orderBy, limit }) => query(
    collection(db, ...P.settlements(tripId)),
    orderBy('createdAt', 'desc'),
    limit(LIST_LIMIT),
  ),
  fromDoc: settlementFromDoc,
  source:  'subscribeToSettlements',
  limit:   LIST_LIMIT,
}, onData, onError)

export async function createSettlement(
  tripId:    string,
  input:     CreateSettlementInput,
  settledBy: string,
): Promise<string> {
  const { db, collection, addDoc, serverTimestamp } = await getFirebase()
  const ref = await addDoc(collection(db, ...P.settlements(tripId)), {
    tripId,
    fromUid:   input.fromUid,
    toUid:     input.toUid,
    amount:    Math.round(input.amount),
    currency:  input.currency,
    settledBy,
    ...(input.note ? { note: input.note } : {}),
    createdAt: serverTimestamp(),
  })
  return ref.id
}

export async function deleteSettlement(tripId: string, id: string): Promise<void> {
  const { db, doc, deleteDoc } = await getFirebase()
  await deleteDoc(doc(db, ...P.settlement(tripId, id)))
}

export const settlementKeys = {
  all: (tripId: string, _uid?: string) => ['settlements', tripId] as const,
}
