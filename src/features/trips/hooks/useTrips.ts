// src/features/trips/hooks/useTrips.ts
// Realtime-backed via:
//   - useMyTripIds: a /members collection-group listener filtered by
//     `userId == uid`. Pushes the new id list whenever the user joins
//     or leaves a trip.
//   - useMyTrips:   useMyTripIds + per-trip doc listeners. Aggregates
//     N trip-doc pushes into a single Trip[] cache so the trip
//     switcher / SchedulePage header / etc. all reflect metadata
//     edits live.
//
// We deliberately do NOT use `where(documentId(), 'in', ids)` for the
// per-trip fetch — it routes through the /trips LIST rule (owner-only)
// and 403s for non-owner members. The L3 (R3) regression in 2026-04
// burnt this in once already; sticking with N independent listeners
// keeps reads identical for a typical 5-trip user and avoids that
// pitfall entirely.
import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import type { User } from 'firebase/auth'
import {
  createTrip,
  getMyTripIds, getTripsByIds,
  subscribeToMyTripIds, subscribeToTrip,
  updateTrip,
} from '../services/tripService'
import { deleteTrip } from '../services/tripCascade'
import { copyTrip, type CopyTripInput, type CopyTripResult } from '../services/tripCopy'
import { createRealtimeListHook } from '@/hooks/createRealtimeListHook'
import { captureError } from '@/services/sentry'
import { getFirebase } from '@/services/firebase'
import { MOCK_TIMESTAMP } from '@/mocks/utils'
import { toLocalMidnightTimestamp } from '@/utils/dates'
import { MUTATION_ACTION, type MutationMeta, type MutationOptions } from '@/services/queryClient'
import { markPerf } from '@/utils/perf'
import { useLastViewedStore } from '@/store/lastViewedStore'
import type { CreateTripInput, Trip } from '@/types'

export const tripKeys = {
  mine:  (uid: string) => ['trips', 'mine', uid] as const,
  myIds: (uid: string) => ['trips', 'my-ids', uid] as const,
}

/**
 * Realtime trip-id list — collection-group listener on /members
 * filtered to docs owned by this uid. Resolves ~half the time of
 * useMyTrips because it skips the per-trip getDoc fan-out, exposing
 * the ids early for callers (AccountPage's member fan-out) that can
 * start downstream queries in parallel.
 */
export const useMyTripIds = createRealtimeListHook<string>({
  queryKeyFactory: tripKeys.myIds,
  initialFetch:    getMyTripIds,
  subscribe:       (uid, _uid2, onData, onError) => subscribeToMyTripIds(uid, onData, onError),
  source:          'useMyTripIds',
})

/**
 * Realtime trip list. Internally:
 *   1. subscribes to the user's member-collection-group (via
 *      useMyTripIds) to keep the id list fresh,
 *   2. opens one trip-doc listener per id and aggregates pushes into
 *      tripKeys.mine(uid)'s array cache.
 *
 * The split lets membership changes (join / leave) and metadata edits
 * (title / dates / icon) propagate independently without re-querying
 * the unchanged half. Listeners are disposed when ids change so we
 * don't leak subscriptions to trips the user no longer belongs to.
 */
export function useMyTrips(uid: string | undefined): UseQueryResult<Trip[]> {
  const qc = useQueryClient()
  const idsResult = useMyTripIds(uid)
  const ids = idsResult.data ?? []
  // Stable string for effect dep: array refs change every render, but
  // joining means same-content arrays produce same dep, so listeners
  // only re-subscribe on actual id changes.
  const idsKey = ids.join(',')

  const result = useQuery<Trip[]>({
    queryKey:  tripKeys.mine(uid ?? ''),
    queryFn:   () => getTripsByIds(ids),
    enabled:   !!uid && idsResult.isSuccess,
    staleTime: Infinity,
  })

  const idsResultIsSuccess = idsResult.isSuccess
  useEffect(() => {
    // Derive `ids` from `idsKey` inside the effect so the dep array is
    // honest (idsKey is the content-stable joined string; the outer
    // `ids` array reference changes every render). This keeps React
    // Compiler + exhaustive-deps happy with no eslint-disable.
    const idList = idsKey ? idsKey.split(',') : []
    if (!uid || idList.length === 0) {
      // No trips → ensure cache reflects empty rather than a stale list.
      if (uid && idsResultIsSuccess) qc.setQueryData<Trip[]>(tripKeys.mine(uid), [])
      return
    }

    let mounted = true
    const unsubs: Array<() => void> = []
    // Per-id Trip object accumulator. Listener pushes update individual
    // entries; we recompute the array on each change so React-Query
    // reference equality fires component updates.
    const tripMap = new Map<string, Trip>()
    let firstPublishMarked = false
    const publish = () => {
      if (!mounted) return
      const arr = idList
        .flatMap(id => {
          const t = tripMap.get(id)
          return t ? [t] : []
        })
        .sort((a, b) => b.createdAt.toMillis() - a.createdAt.toMillis())
      qc.setQueryData<Trip[]>(tripKeys.mine(uid), arr)
      if (!firstPublishMarked && arr.length > 0) {
        firstPublishMarked = true
        markPerf('mytrips-first-publish')
      }
    }

    idList.forEach(id => {
      // No retry: trip docs use the same same-doc memberIds read rule
      // as entity subcollections, so permission-denied here is a real
      // revoke (trip deleted / left), not a propagation lag.
      void subscribeToTrip(
        id,
        trip => {
          if (trip) tripMap.set(id, trip)
          else      tripMap.delete(id)
          publish()
        },
        err => {
          const code = (err as { code?: string }).code
          if (code === 'permission-denied') {
            if (import.meta.env.DEV) {
              console.warn(`[useMyTrips/tripDoc:${id}] listener permission revoked`, err)
            }
            return
          }
          const e = err instanceof Error ? err : new Error(String(err))
          const tagged = new Error(`[useMyTrips/tripDoc:${id}] ${e.message}`)
          tagged.name  = e.name
          tagged.stack = e.stack
          captureError(tagged, { source: 'useMyTrips/tripDoc', tripId: id })
        },
      ).then(unsub => {
        if (mounted) unsubs.push(unsub)
        else unsub()
      }).catch(e => {
        captureError(e, { source: 'useMyTrips/subscribe-init', tripId: id })
      })
    })

    return () => {
      mounted = false
      unsubs.forEach(u => u())
    }
  }, [uid, idsKey, qc, idsResultIsSuccess])

  return result
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
      qc.setQueryData<string[]>(tripKeys.myIds(user.uid), prev =>
        prev ? [trip.id, ...prev.filter(id => id !== trip.id)] : [trip.id],
      )
    },
  })
}

export function useUpdateTrip(uid: string | undefined, options?: MutationOptions) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ tripId, updates }: { tripId: string; updates: Partial<CreateTripInput> }) =>
      updateTrip(tripId, updates),
    meta: { action: MUTATION_ACTION.UPDATE, silent: options?.silent } satisfies MutationMeta,
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
      if (!uid) return { prevTrips: undefined as Trip[] | undefined, prevIds: undefined as string[] | undefined }
      const tripsKey = tripKeys.mine(uid)
      const idsKey   = tripKeys.myIds(uid)
      const prevTrips = qc.getQueryData<Trip[]>(tripsKey)
      const prevIds   = qc.getQueryData<string[]>(idsKey)
      if (prevTrips) qc.setQueryData<Trip[]>(tripsKey, prevTrips.filter(t => t.id !== tripId))
      if (prevIds)   qc.setQueryData<string[]>(idsKey, prevIds.filter(id => id !== tripId))
      return { prevTrips, prevIds }
    },
    onSuccess: (_data, tripId) => {
      // Drop per-trip lastViewed entry so localStorage doesn't accumulate
      // stale records for deleted trips.
      useLastViewedStore.getState().clearTrip(tripId)
    },
    onError: (_err, _vars, ctx) => {
      if (uid) {
        if (ctx?.prevTrips !== undefined) qc.setQueryData(tripKeys.mine(uid), ctx.prevTrips)
        if (ctx?.prevIds   !== undefined) qc.setQueryData(tripKeys.myIds(uid), ctx.prevIds)
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
      qc.invalidateQueries({ queryKey: tripKeys.myIds(uid) })
    },
  })
}
