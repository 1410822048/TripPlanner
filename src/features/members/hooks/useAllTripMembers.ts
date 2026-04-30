// src/features/members/hooks/useAllTripMembers.ts
// Fan-out hook: "every member of every trip the signed-in user belongs to."
//
// Two callers — AccountPage (counts unique non-self collaborators for a
// stat tile) and SocialCirclePage (groups members by uid + lists shared
// trips). Both used to inline the same fan-out:
//
//   useMyTrips → useQueries(memberKeys.all(tripId), getMembersByTrip)
//
// This hook owns the data-fetching layer; aggregation (unique count vs
// per-collaborator trip list) stays at each caller because the shapes
// diverge enough that a unified return type would just push branching
// downstream.
//
// Optimisation note: the member fan-out queries off `tripIds` (stage 1
// of getMyTrips, ~half the latency) so they start in parallel with
// stage 2's per-trip getDoc fan-out instead of waiting for the full
// Trip[]. Each entry shares cache with `useMembers(tripId)` in
// SchedulePage / MembersModal — repeat visits are free.
import { useQueries, type UseQueryResult } from '@tanstack/react-query'
import { useMyTrips, useMyTripIds } from '@/features/trips/hooks/useTrips'
import { memberKeys } from './useMembers'
import { getMembersByTrip } from '../services/memberService'
import type { Member, Trip } from '@/types'

export interface UseAllTripMembersResult {
  /** Full Trip docs for the signed-in user, undefined while loading. */
  trips:         Trip[] | undefined
  /** Trip ids only — resolves before `trips`, exposed so callers that
   *  only need ids can avoid waiting on the per-trip getDoc fan-out. */
  tripIds:       string[] | undefined
  /** One UseQueryResult<Member[]> per trip, in the same order as `tripIds`. */
  memberResults: UseQueryResult<Member[]>[]
  /** True while either the trip list OR any of the per-trip member queries
   *  is still pending. Composite signal so callers don't have to OR them. */
  isLoading:     boolean
}

export function useAllTripMembers(uid: string | undefined): UseAllTripMembersResult {
  const { data: trips,   isPending: tripsPending } = useMyTrips(uid)
  const { data: tripIds }                          = useMyTripIds(uid)

  const memberResults = useQueries({
    queries: (tripIds ?? []).map(id => ({
      queryKey: memberKeys.all(id),
      queryFn:  () => getMembersByTrip(id),
      enabled:  !!tripIds,
    })),
  })

  // `fetchStatus !== 'idle'` excludes the disabled-because-no-uid state,
  // which would otherwise leave the page stuck "loading" for signed-out
  // users.
  const anyMembersLoading = memberResults.some(r => r.isPending && r.fetchStatus !== 'idle')

  return {
    trips,
    tripIds,
    memberResults,
    isLoading: tripsPending || anyMembersLoading,
  }
}
