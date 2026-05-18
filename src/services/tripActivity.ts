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
// `by` is intentionally NOT validated server-side: the badge filter
// (skip if by === currentUid) is a client UX nicety. Forging `by` would
// only cause the forger's own badge to fire incorrectly — no security
// or data-integrity impact, so we keep the rule lenient.
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
