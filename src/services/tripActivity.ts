// src/services/tripActivity.ts
// Best-effort bump of trip.lastActivityByFeature[feature] = { ts, by }.
// Called after every entity mutation (create / update / delete / toggle
// / vote) so useFeatureBadges can read the bottom-nav unread-dot state
// from a single trip doc — no need to mount 5 per-entity listeners at
// AppLayout level.
//
// Best-effort: failures (rules race, network, etc.) are captured to
// Sentry but never propagate. The entity write itself already succeeded
// at this point; failing the user's save just because the badge tracker
// glitched would be terrible UX. Eventually-consistent — next mutation
// reconciles.
//
// Rules (validActivityBump) pin the payload shape: exactly one feature
// per write, `{ ts: serverTimestamp(), by: <caller uid> }`. A malformed
// stamp used to be able to fail TripDocSchema and hide the whole trip,
// so keep this payload in that exact shape.
import { getFirebase } from '@/services/firebase'
import { P } from '@/services/paths'
import { captureError } from '@/services/sentry'
import type { ActivityFeature } from '@/types'

export async function bumpTripActivity(
  tripId: string,
  feature: ActivityFeature,
  by: string,
): Promise<void> {
  try {
    const { db, doc, updateDoc, serverTimestamp } = await getFirebase()
    await updateDoc(doc(db, ...P.trip(tripId)), {
      [`lastActivityByFeature.${feature}`]: { ts: serverTimestamp(), by },
    })
  } catch (e) {
    captureError(e, { source: 'bumpTripActivity', tripId, feature })
  }
}
