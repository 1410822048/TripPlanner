// src/services/tripMemberIds.ts
// Single source of truth for "what memberIds should I stamp on this
// new entity?". Reads from the trip doc's denormalised memberIds array.
//
// The trip doc is the canonical roster. Worker membership endpoints keep
// it and every entity subcollection projection in sync. Reading from one
// place gives every entity create path a consistent snapshot of the current
// membership at write time.
import { getFirebase } from '@/services/firebase'
import { P } from '@/services/paths'
import { captureError } from '@/services/sentry'

/** Read the trip's current `memberIds` array.
 *
 *  A read failure is RETHROWN (after capture). It used to resolve to `[]`
 *  "so the create could proceed", but rules (`memberIdsMatchTrip`) reject
 *  an entity whose memberIds don't equal the trip roster, so the user got
 *  a misleading permission-denied instead of the real network/read error.
 *  Callers already surface thrown errors through their mutation UI. */
export async function getTripMemberIds(tripId: string): Promise<string[]> {
  try {
    const { db, doc, getDoc } = await getFirebase()
    const snap = await getDoc(doc(db, ...P.trip(tripId)))
    const data = snap.data() as { memberIds?: string[] } | undefined
    return data?.memberIds ?? []
  } catch (e) {
    captureError(e, { source: 'getTripMemberIds', tripId })
    throw e
  }
}
