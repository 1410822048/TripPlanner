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
// Cold-boot fast path: while the membership-derived list is unresolved,
// the persisted selection is read with getDocFromServer. This is deliberately
// server-only — IndexedDB may contain a previous account's cached document.
// Once myTrips resolves it immediately becomes authoritative again.
//
// Returns `null` in these cases:
//   - Demo mode (uid undefined → useMyTrips disabled)
//   - No persisted selection yet
//   - The server rejects the fast path, or myTrips proves the id inaccessible
//
// `useCurrentTripSync` (AppLayout) is responsible for keeping
// selectedTripId aligned with the current list — falling back to
// recents / myTrips[0] when the persisted id leaves the list.
import { useQuery } from '@tanstack/react-query'
import { useUid } from '@/hooks/useAuth'
import { useTripStore } from '@/store/tripStore'
import { useMyTrips } from './useTrips'
import { getTripByIdFromServer } from '../services/tripService'
import { tripKeys } from '../queryKeys'
import type { Trip } from '@/types'

export function useCurrentTrip(): Trip | null {
  const id  = useTripStore(s => s.selectedTripId)
  const uid = useUid()
  const { data: myTrips } = useMyTrips(uid)
  const fastTrip = useQuery({
    queryKey: tripKeys.detail(uid ?? '', id ?? ''),
    queryFn: () => getTripByIdFromServer(id!),
    // Once the authoritative membership-derived list exists, it remains the
    // sole source of truth. The direct server read only removes the cold-boot
    // waterfall while that list is unresolved.
    enabled: !!uid && !!id && myTrips === undefined,
    staleTime: Infinity,
    retry: false,
  })

  if (!id) return null
  if (myTrips !== undefined) return myTrips.find(trip => trip.id === id) ?? null
  return fastTrip.data ?? null
}
