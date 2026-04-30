// src/features/trips/hooks/useTrips.ts
// Mutations follow the same optimistic pattern as useSchedules: cache is
// patched in onMutate, rolled back in onError (with a toast), reconciled via
// invalidate in onSettled. Edit needs async onMutate because date Timestamps
// are built lazily through the Firestore bundle import.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { User } from 'firebase/auth'
import { createTrip, deleteTrip, getMyTrips, getMyTripIds, updateTrip } from '../services/tripService'
import { getFirebase } from '@/services/firebase'
import { MOCK_TIMESTAMP } from '@/mocks/utils'
import { toast } from '@/shared/toast'
import { toLocalMidnightTimestamp } from '@/utils/dates'
import type { CreateTripInput, Trip } from '@/types'

export const tripKeys = {
  mine:  (uid: string) => ['trips', 'mine', uid] as const,
  myIds: (uid: string) => ['trips', 'my-ids', uid] as const,
}

/**
 * Fetch trips owned by the signed-in user. Disabled until uid is known so
 * we don't fire a query against an unauthenticated client.
 */
export function useMyTrips(uid: string | undefined) {
  return useQuery({
    queryKey: tripKeys.mine(uid ?? ''),
    queryFn:  () => getMyTrips(uid!),
    enabled:  !!uid,
  })
}

/**
 * Fetch just the trip ids the user belongs to (stage 1 of getMyTrips).
 * Resolves ~half the time of `useMyTrips` because it skips the per-trip
 * getDoc fan-out — useful when a caller only needs ids to fan out further
 * Firestore queries (e.g. AccountPage's per-trip member fetches), letting
 * those run in parallel with the trip-doc fetches inside `useMyTrips`
 * instead of waiting for the full Trip[] to land.
 */
export function useMyTripIds(uid: string | undefined) {
  return useQuery({
    queryKey: tripKeys.myIds(uid ?? ''),
    queryFn:  () => getMyTripIds(uid!),
    enabled:  !!uid,
  })
}

export function useCreateTrip() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ input, user }: { input: CreateTripInput; user: User }) =>
      createTrip(input, user),
    onSuccess: (trip, { user }) => {
      // Seed both list caches so switcher (mine) + AccountPage's parallel
      // member fan-out (my-ids) pick up the new trip immediately without a
      // round-trip. Without the my-ids update, AccountPage's collaborator
      // count would lag until the cache invalidates.
      qc.setQueryData<Trip[]>(tripKeys.mine(user.uid), prev =>
        prev ? [trip, ...prev.filter(t => t.id !== trip.id)] : [trip],
      )
      qc.setQueryData<string[]>(tripKeys.myIds(user.uid), prev =>
        prev ? [trip.id, ...prev.filter(id => id !== trip.id)] : [trip.id],
      )
    },
  })
}

export function useUpdateTrip(uid: string | undefined) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ tripId, updates }: { tripId: string; updates: Partial<CreateTripInput> }) =>
      updateTrip(tripId, updates),
    onMutate: async ({ tripId, updates }) => {
      if (!uid) return { prev: undefined as Trip[] | undefined }
      const key  = tripKeys.mine(uid)
      const prev = qc.getQueryData<Trip[]>(key)
      if (!prev) return { prev }
      const { Timestamp } = await getFirebase()
      qc.setQueryData<Trip[]>(key, prev.map(t => {
        if (t.id !== tripId) return t
        const next: Trip = { ...t, updatedAt: MOCK_TIMESTAMP }
        if (updates.title       !== undefined) next.title       = updates.title
        if (updates.destination !== undefined) next.destination = updates.destination
        if (updates.icon        !== undefined) next.icon        = updates.icon
        if (updates.currency    !== undefined) next.currency    = updates.currency
        if (updates.startDate) next.startDate = toLocalMidnightTimestamp(updates.startDate, Timestamp)
        if (updates.endDate)   next.endDate   = toLocalMidnightTimestamp(updates.endDate,   Timestamp)
        return next
      }))
      return { prev }
    },
    onError: (err, _vars, ctx) => {
      if (uid && ctx?.prev !== undefined) qc.setQueryData(tripKeys.mine(uid), ctx.prev)
      toast.error(err instanceof Error ? `更新に失敗：${err.message}` : '更新に失敗しました')
    },
    // No onSettled invalidate: the optimistic patch already covers every field
    // the UI renders (title / destination / icon / dates). The only field
    // diverging from the server is `updatedAt`, which isn't displayed anywhere,
    // so a full refetch would just re-download N trips for no visible benefit.
    // Concurrent cross-client edits are rare on trip metadata — acceptable tradeoff.
  })
}

export function useDeleteTrip(uid: string | undefined) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (tripId: string) => deleteTrip(tripId),
    onMutate: (tripId) => {
      if (!uid) return { prevTrips: undefined as Trip[] | undefined, prevIds: undefined as string[] | undefined }
      const tripsKey = tripKeys.mine(uid)
      const idsKey   = tripKeys.myIds(uid)
      const prevTrips = qc.getQueryData<Trip[]>(tripsKey)
      const prevIds   = qc.getQueryData<string[]>(idsKey)
      if (prevTrips) qc.setQueryData<Trip[]>(tripsKey, prevTrips.filter(t => t.id !== tripId))
      if (prevIds)   qc.setQueryData<string[]>(idsKey, prevIds.filter(id => id !== tripId))
      return { prevTrips, prevIds }
    },
    onError: (err, _vars, ctx) => {
      if (uid) {
        if (ctx?.prevTrips !== undefined) qc.setQueryData(tripKeys.mine(uid), ctx.prevTrips)
        if (ctx?.prevIds   !== undefined) qc.setQueryData(tripKeys.myIds(uid), ctx.prevIds)
      }
      toast.error(err instanceof Error ? `削除に失敗：${err.message}` : '削除に失敗しました')
    },
    onSettled: () => {
      if (uid) {
        qc.invalidateQueries({ queryKey: tripKeys.mine(uid) })
        qc.invalidateQueries({ queryKey: tripKeys.myIds(uid) })
      }
    },
  })
}
