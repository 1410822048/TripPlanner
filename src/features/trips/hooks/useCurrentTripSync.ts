// src/features/trips/hooks/useCurrentTripSync.ts
// Keeps the Zustand `currentTrip` in lockstep with the user's TanStack
// Query trip cache. Designed to run from the layout level (AppLayout) so
// the rehydration happens regardless of which tab the user lands on after
// a hard reload — previously this useEffect lived only in SchedulePage,
// which meant /bookings or /expense after refresh would render the
// "select a trip" empty state until the user manually navigated through
// /schedule.
//
// Rehydration rules:
//   1. Demo mode (no uid) → leave currentTrip alone, no fetch
//   2. myTrips loaded but empty → clear currentTrip
//   3. currentTrip points at a still-existing trip → swap in the latest
//      cache entry if it has drifted (e.g. an optimistic update landed)
//   4. currentTrip is null OR points at a deleted trip → pick:
//        a) the persisted selectedTripId if still in myTrips
//        b) the first recentTripIds entry that's still in myTrips
//        c) myTrips[0]
import { useEffect } from 'react'
import { useUid } from '@/hooks/useAuth'
import { useTripStore } from '@/store/tripStore'
import { useMyTrips } from './useTrips'

export function useCurrentTripSync(): void {
  const uid = useUid()
  const isDemo = !uid
  const { currentTrip, setCurrentTrip, selectedTripId, recentTripIds } = useTripStore()
  const { data: myTrips } = useMyTrips(uid)

  useEffect(() => {
    if (isDemo || !myTrips) return
    if (myTrips.length === 0) {
      if (currentTrip) setCurrentTrip(null)
      return
    }
    if (currentTrip) {
      const latest = myTrips.find(t => t.id === currentTrip.id)
      if (latest) {
        if (latest !== currentTrip) setCurrentTrip(latest)
        return
      }
      // current trip no longer in cache → fall through to reselect
    }
    // Reselect priority: persisted selection → recents → newest.
    const persisted = selectedTripId ? myTrips.find(t => t.id === selectedTripId) : undefined
    const recent    = recentTripIds.map(id => myTrips.find(t => t.id === id)).find(Boolean)
    setCurrentTrip(persisted ?? recent ?? myTrips[0] ?? null)
  }, [isDemo, myTrips, currentTrip, selectedTripId, recentTripIds, setCurrentTrip])
}
