// src/features/trips/hooks/useCurrentTrip.ts
// Derived "currently-active trip" — composed from the React Query
// trip cache (authoritative source) + `selectedTripId` (persisted ID,
// JSON-safe across reloads). Replaces a Zustand-stored Trip object
// that used to run on a parallel notification path, which produced
// 1-frame "modal closes after layout swaps" flashes on create / copy
// because the Zustand setState and React Query setQueryData landed in
// different commits. Deriving collapses both into one source so the
// render cycle stays coherent and no flushSync escape hatches are
// needed at the call sites.
//
// Returns `null` in these cases:
//   - Demo mode (uid undefined → useMyTrips disabled)
//   - No persisted selection yet (cold boot before useCurrentTripSync)
//   - selectedTripId points at a trip the user no longer belongs to
//     (deleted / left / cache stale during sign-in)
//
// `useCurrentTripSync` (AppLayout) is responsible for keeping
// selectedTripId aligned with the current list — falling back to
// recents / myTrips[0] when the persisted id leaves the list.
import { useUid } from '@/hooks/useAuth'
import { useTripStore } from '@/store/tripStore'
import { useMyTrips } from './useTrips'
import type { Trip } from '@/types'

export function useCurrentTrip(): Trip | null {
  const id  = useTripStore(s => s.selectedTripId)
  const uid = useUid()
  const { data: myTrips } = useMyTrips(uid)
  if (!id || !myTrips) return null
  return myTrips.find(t => t.id === id) ?? null
}
