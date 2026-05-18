// src/features/trips/hooks/useCurrentTripSync.ts
// Keeps `selectedTripId` (Zustand, persisted) pointing at a trip the
// user actually has access to. Runs at the layout level so a hard
// reload landing on any tab picks the user's last trip without
// forcing them through /schedule first.
//
// The full `Trip` object is no longer hydrated here — consumers read
// it via `useCurrentTrip()`, which derives from this id + the React
// Query trip cache. That single source removed the create / copy
// flash bugs that the previous dual-store had needed flushSync to
// paper over.
//
// Rehydration rules:
//   1. Demo mode (no uid)            → no-op
//   2. myTrips empty                 → clear selectedTripId
//   3. selectedTripId still in list  → no-op (don't churn recents)
//   4. selectedTripId missing/null   → recents[0] in list ?? myTrips[0]
import { useEffect } from 'react'
import { useUid } from '@/hooks/useAuth'
import { useTripStore } from '@/store/tripStore'
import { useMyTrips } from './useTrips'

export function useCurrentTripSync(): void {
  const uid = useUid()
  const isDemo = !uid
  const { selectedTripId, recentTripIds, setSelectedTripId } = useTripStore()
  const { data: myTrips } = useMyTrips(uid)

  useEffect(() => {
    if (isDemo || !myTrips) return
    if (myTrips.length === 0) {
      if (selectedTripId) setSelectedTripId(null)
      return
    }
    // Selection still valid → no write (avoid recents churn on every
    // trip-doc cache push).
    if (selectedTripId && myTrips.some(t => t.id === selectedTripId)) return
    // Reselect priority: most-recent that's still accessible → newest.
    const tripById = new Map(myTrips.map(t => [t.id, t]))
    const recent   = recentTripIds.find(id => tripById.has(id))
    setSelectedTripId(recent ?? myTrips[0]?.id ?? null)
  }, [isDemo, myTrips, selectedTripId, recentTripIds, setSelectedTripId])
}
