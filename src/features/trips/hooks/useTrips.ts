import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { User } from 'firebase/auth'
import {
  createTrip,
  getMyTrips, subscribeToMyTrips,
  updateTrip, setWishVotingDeadline,
} from '../services/tripService'
import { deleteTrip } from '../services/tripCascade'
import { leaveMember } from '@/features/members/services/memberService'
import { copyTrip, type CopyTripInput, type CopyTripResult } from '../services/tripCopy'
import { createRealtimeListHook } from '@/hooks/createRealtimeListHook'
import { getFirebase } from '@/services/firebase'
import { MOCK_TIMESTAMP } from '@/mocks/utils'
import { toLocalMidnightTimestamp } from '@/utils/dates'
import { MUTATION_ACTION, type MutationMeta } from '@/services/queryClient'
import { useLastViewedStore } from '@/store/lastViewedStore'
import { tripKeys } from '../queryKeys'
import type { CreateTripInput, Trip } from '@/types'

/** One membership-filtered list shared by all consumers of this uid. */
export const useMyTrips = createRealtimeListHook<Trip>({
  queryKeyFactory: tripKeys.mine,
  initialFetch: getMyTrips,
  subscribe: (uid, _authUid, onData, onError) => subscribeToMyTrips(uid, onData, onError),
  source: 'useMyTrips',
})

export function useCreateTrip() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ input, user }: { input: CreateTripInput; user: User }) =>
      createTrip(input, user),
    onSuccess: (trip, { user }) => {
      // Seed the trip list; member IDs are derived by consumers.
      qc.setQueryData<Trip[]>(tripKeys.mine(user.uid), prev =>
        prev ? [trip, ...prev.filter(t => t.id !== trip.id)] : [trip],
      )
    },
  })
}

/**
 * Duplicate a trip + selected subcollections. Same cache-seeding
 * approach as useCreateTrip so the new trip appears in the switcher
 * immediately, no round-trip wait.
 */
export function useCopyTrip() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ source, input, user }: { source: Trip; input: CopyTripInput; user: User }): Promise<CopyTripResult> =>
      copyTrip(source, input, user),
    onSuccess: ({ trip }, { user }) => {
      qc.setQueryData<Trip[]>(tripKeys.mine(user.uid), prev =>
        prev ? [trip, ...prev.filter(t => t.id !== trip.id)] : [trip],
      )
    },
  })
}

export function useUpdateTrip(uid: string | undefined) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ tripId, updates }: { tripId: string; updates: Partial<CreateTripInput> }) =>
      updateTrip(tripId, updates),
    meta: { action: MUTATION_ACTION.UPDATE } satisfies MutationMeta,
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
    onError: (_err, _vars, ctx) => {
      if (uid && ctx?.prev !== undefined) qc.setQueryData(tripKeys.mine(uid), ctx.prev)
    },
    // No onSettled invalidate: the optimistic patch already covers every field
    // the UI renders (title / destination / icon / dates). The only field
    // diverging from the server is `updatedAt`, which isn't displayed anywhere,
    // so a full refetch would just re-download N trips for no visible benefit.
    // Concurrent cross-client edits are rare on trip metadata — acceptable tradeoff.
  })
}

/** Owner-only shared Wish voting deadline. Same optimistic-patch shape as
 *  useUpdateTrip, scoped to the one field it owns. */
export function useSetWishVotingDeadline(uid: string | undefined) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ tripId, deadlineAt }: { tripId: string; deadlineAt: Date | null }) =>
      setWishVotingDeadline(tripId, deadlineAt),
    meta: { action: MUTATION_ACTION.UPDATE } satisfies MutationMeta,
    onMutate: async ({ tripId, deadlineAt }) => {
      if (!uid) return { prev: undefined as Trip[] | undefined }
      const key  = tripKeys.mine(uid)
      const prev = qc.getQueryData<Trip[]>(key)
      if (!prev) return { prev }
      const { Timestamp } = await getFirebase()
      qc.setQueryData<Trip[]>(key, prev.map(t => t.id !== tripId ? t : {
        ...t,
        wishVotingDeadlineAt: deadlineAt ? Timestamp.fromDate(deadlineAt) : null,
        updatedAt: MOCK_TIMESTAMP,
      }))
      return { prev }
    },
    onError: (_err, _vars, ctx) => {
      if (uid && ctx?.prev !== undefined) qc.setQueryData(tripKeys.mine(uid), ctx.prev)
    },
  })
}

export function useDeleteTrip(uid: string | undefined) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (tripId: string) => {
      // Pages gate on signed-in state before calling; throwing here
      // turns a missed gate into a loud Sentry event instead of a
      // silent no-op. uid isn't passed to deleteTrip -- the Worker
      // reads caller identity from the Firebase ID token -- but we
      // still gate on its presence as a signed-in check.
      if (!uid) throw new Error('useDeleteTrip: uid is undefined')
      return deleteTrip(tripId)
    },
    meta: { action: MUTATION_ACTION.DELETE } satisfies MutationMeta,
    onMutate: (tripId) => {
      if (!uid) return { prevTrips: undefined as Trip[] | undefined }
      const tripsKey = tripKeys.mine(uid)
      const prevTrips = qc.getQueryData<Trip[]>(tripsKey)
      if (prevTrips) qc.setQueryData<Trip[]>(tripsKey, prevTrips.filter(t => t.id !== tripId))
      return { prevTrips }
    },
    onSuccess: (_data, tripId) => {
      // Drop per-trip lastViewed entry so localStorage doesn't accumulate
      // stale records for deleted trips.
      useLastViewedStore.getState().clearTrip(tripId)
    },
    onError: (_err, _vars, ctx) => {
      if (uid) {
        if (ctx?.prevTrips !== undefined) qc.setQueryData(tripKeys.mine(uid), ctx.prevTrips)
      }
    },
    // Race: Worker cascade can complete server-side, but the HTTP
    // response can be lost (network blip, Worker timeout, iOS
    // background tab kill). The Firestore listener pushes the
    // deletion to the cache, but then onError rolls back to the
    // pre-mutation snapshot — reviving the already-deleted trip in
    // the UI as a ghost row. Invalidating on settled forces a fresh
    // query that re-syncs with server truth regardless of which path
    // (success / error / lost response) the mutation took.
    onSettled: () => {
      if (!uid) return
      qc.invalidateQueries({ queryKey: tripKeys.mine(uid) })
    },
  })
}

/**
 * Leave a trip (non-owner self-removal via the Worker /member-leave
 * endpoint). The twin of useDeleteTrip from the trip-LIST cache's point
 * of view: both make a trip disappear from MY world, so the optimistic
 * patch + rollback + lastViewed cleanup + lost-response reconcile are
 * identical. The only difference is which Worker endpoint runs and that
 * the caller is the target (the Worker reads the uid from the token; the
 * owner is gated out server-side, and the UI hides the affordance for
 * owners anyway).
 */
export function useLeaveTrip(uid: string | undefined) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (tripId: string) => {
      if (!uid) throw new Error('useLeaveTrip: uid is undefined')
      return leaveMember(tripId)
    },
    meta: { action: MUTATION_ACTION.DELETE } satisfies MutationMeta,
    onMutate: (tripId) => {
      if (!uid) return { prevTrips: undefined as Trip[] | undefined }
      const tripsKey = tripKeys.mine(uid)
      const prevTrips = qc.getQueryData<Trip[]>(tripsKey)
      if (prevTrips) qc.setQueryData<Trip[]>(tripsKey, prevTrips.filter(t => t.id !== tripId))
      return { prevTrips }
    },
    onSuccess: (_data, tripId) => {
      useLastViewedStore.getState().clearTrip(tripId)
    },
    onError: (_err, _vars, ctx) => {
      if (uid) {
        if (ctx?.prevTrips !== undefined) qc.setQueryData(tripKeys.mine(uid), ctx.prevTrips)
      }
    },
    // Same lost-response reconcile as useDeleteTrip: the trips
    // listener pushes the leave to the cache, but a lost
    // HTTP response would otherwise roll back to the pre-mutation snapshot
    // and revive the trip as a ghost row. Invalidate forces a fresh query
    // that re-syncs with server truth regardless of which path won.
    onSettled: () => {
      if (!uid) return
      qc.invalidateQueries({ queryKey: tripKeys.mine(uid) })
    },
  })
}
