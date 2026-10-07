// src/features/members/hooks/useCollaboratorSummary.ts
// Account-page stat tile: how many distinct people the signed-in user has
// travelled with, plus up to three of them for the avatar row.
//
// The count comes from `trip.memberIds`, which the trip list already holds
// (zero extra reads). Member docs are only fetched for the few trips needed
// to name the first three collaborators — the full per-trip fan-out with a
// realtime listener each (useAllTripMembers) is for SocialCirclePage, which
// actually lists everyone.
import { useQueries } from '@tanstack/react-query'
import type { Trip } from '@/types'
import type { TripMember } from '@/features/trips/types'
import { memberToTripMember } from '../utils'
import { memberKeys } from './useMembers'
import { getMembersByTrip } from '../services/memberService'

const CHIP_COUNT = 3

export interface CollaboratorSummary {
  count: number
  chips: TripMember[]
}

export function useCollaboratorSummary(uid: string | undefined, trips: Trip[] | undefined): CollaboratorSummary {
  const seen = new Set<string>()
  const chipIds: string[] = []
  const chipTripIds: string[] = []
  for (const trip of trips ?? []) {
    for (const id of trip.memberIds) {
      if (id === uid || seen.has(id)) continue
      seen.add(id)
      if (chipIds.length < CHIP_COUNT) {
        chipIds.push(id)
        if (!chipTripIds.includes(trip.id)) chipTripIds.push(trip.id)
      }
    }
  }

  const results = useQueries({
    queries: chipTripIds.map(tripId => ({
      queryKey:  memberKeys.all(tripId, uid),
      queryFn:   () => (uid ? getMembersByTrip(tripId, uid) : Promise.resolve([])),
      enabled:   !!uid,
      staleTime: 5 * 60_000,
    })),
  })

  const byUid = new Map<string, TripMember>()
  for (const r of results) {
    for (const m of r.data ?? []) {
      if (!byUid.has(m.userId)) byUid.set(m.userId, memberToTripMember(m))
    }
  }
  const chips = chipIds.flatMap(id => {
    const chip = byUid.get(id)
    return chip ? [chip] : []
  })
  return { count: seen.size, chips }
}
