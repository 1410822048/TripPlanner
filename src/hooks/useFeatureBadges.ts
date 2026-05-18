// src/hooks/useFeatureBadges.ts
// Computes per-tab unread dot state for the bottom nav. Reads from a
// single source — the current trip doc's `lastActivityByFeature` map,
// which the trip-doc listener (useMyTrips/tripDoc, already mounted by
// SchedulePage) keeps fresh.
//
// Earlier versions mounted 5 always-on Firestore listeners here (one
// per entity collection) and computed max(updatedAt). That worked but
// wasted reads: every edit by any member pushed the whole collection
// snapshot to every other member, multiplied by 5 entity listeners.
// Now each service mutation calls bumpTripActivity(tripId, feature,
// uid) best-effort after the main write, denormalising activity into
// the trip doc. Read cost drops to 0 new listeners (we piggyback on
// the existing trip-doc listener); 5 listeners → 0.
import { useLastViewedStore, type BadgeFeature } from '@/store/lastViewedStore'
import { useCurrentTrip } from '@/features/trips/hooks/useCurrentTrip'
import { useUid } from '@/hooks/useAuth'

export type FeatureBadges = Record<BadgeFeature, boolean>
export type FeatureActivity = Record<BadgeFeature, number>

export interface UseFeatureBadgesResult {
  badges:   FeatureBadges
  /** Latest activity timestamp (ms) per feature, filtered to exclude
   *  own writes. AppLayout uses this to align lastViewed with server
   *  activity on the active tab — see the watermark effect there. */
  activity: FeatureActivity
}

const FEATURES: BadgeFeature[] = ['schedule', 'expense', 'bookings', 'wish', 'planning']

export function useFeatureBadges(): UseFeatureBadgesResult {
  const trip   = useCurrentTrip()
  const tripId = trip?.id
  const viewed = useLastViewedStore(s => (tripId ? s.viewed[tripId] : undefined))
  const uid    = useUid()

  const lv = viewed ?? {}
  const activity = {} as FeatureActivity
  const badges   = {} as FeatureBadges

  // Read directly from the trip-doc denormalisation. `by === uid` skips
  // own writes so the user's own create/update/toggle/vote never lights
  // up their own dot. Missing entry → 0 → no dot (correct for new trip).
  for (const feature of FEATURES) {
    const stamp = trip?.lastActivityByFeature?.[feature]
    const ms = stamp && stamp.by !== uid
      ? (stamp.ts?.toMillis?.() ?? 0)
      : 0
    activity[feature] = ms
    badges[feature]   = ms > (lv[feature] ?? 0)
  }

  return { badges, activity }
}
