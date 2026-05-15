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
// Realtime: each per-trip member query is backed by a Firestore
// onSnapshot listener (started in this hook's effect, dispatched to
// the same memberKeys.all(tripId) cache that useMembers uses). When a
// member doc changes anywhere — invitee redeems, owner kicks someone,
// role flip — the corresponding cache slot updates and useQueries
// re-emits without any manual refetch.
//
// Why we run the listeners here (not just rely on useMembers): the
// SocialCirclePage / AccountPage callers don't mount useMembers for
// every trip (they aren't on a single-trip view), so without these
// listeners the cross-trip view would only refresh when a trip is
// individually visited. Running them here closes that gap.
import { useEffect } from 'react'
import { useQueries, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { useMyTrips, useMyTripIds } from '@/features/trips/hooks/useTrips'
import { memberKeys } from './useMembers'
import { getMembersByTrip, subscribeToMembers } from '../services/memberService'
import { captureError } from '@/services/sentry'
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
  const qc = useQueryClient()
  const { data: trips,   isPending: tripsPending } = useMyTrips(uid)
  const { data: tripIds }                          = useMyTripIds(uid)
  const ids = tripIds ?? []
  // Stable string for effect dep; arrays are fresh refs every render.
  const idsKey = ids.join(',')

  const memberResults = useQueries({
    queries: ids.map(id => ({
      queryKey:  memberKeys.all(id),
      queryFn:   () => getMembersByTrip(id),
      enabled:   !!tripIds,
      // Listener is the source of truth once attached (see effect below).
      staleTime: Infinity,
    })),
  })

  useEffect(() => {
    // Derive `ids` from idsKey inside the effect — `idsKey` is the
    // canonical content-stable identity (a comma-joined string), and
    // re-splitting it here keeps the dep array honest. The outer `ids`
    // array reference changes every render (recomputed from tripIds),
    // which is why we keyed on the joined string in the first place.
    const idList = idsKey ? idsKey.split(',') : []
    if (idList.length === 0) return
    let mounted = true
    const unsubs: Array<() => void> = []

    idList.forEach(id => {
      void subscribeToMembers(
        id,
        data => {
          if (mounted) qc.setQueryData<Member[]>(memberKeys.all(id), data)
        },
        err => captureError(err, { source: 'useAllTripMembers/members', tripId: id }),
      ).then(unsub => {
        if (mounted) unsubs.push(unsub)
        else unsub()
      }).catch(e => {
        captureError(e, { source: 'useAllTripMembers/subscribe-init', tripId: id })
      })
    })

    return () => {
      mounted = false
      unsubs.forEach(u => u())
    }
  }, [idsKey, qc])

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
