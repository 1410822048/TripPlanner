import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { User } from 'firebase/auth'
import {
  createTrip,
  getMyTrips, getMyTripsFromServer, subscribeToMyTrips,
  updateTrip, setWishVotingDeadline,
} from '../services/tripService'
import { deleteTrip } from '../services/tripCascade'
import { leaveMember } from '@/features/members/services/memberService'
import { copyTrip, type CopyTripInput, type CopyTripResult } from '../services/tripCopy'
import { createRealtimeListHook } from '@/hooks/createRealtimeListHook'
import { createListOverlay, type OverlayHandle } from '@/hooks/listOverlay'
import { isWorkerAmbiguousError } from '@/hooks/useTripListMutation'
import { getFirebase } from '@/services/firebase'
import { toTripDateTimestamp } from '@/utils/dates'
import { MUTATION_ACTION, type MutationMeta } from '@/services/queryClient'
import { useLastViewedStore } from '@/store/lastViewedStore'
import { tripKeys } from '../queryKeys'
import type { CreateTripInput, Trip } from '@/types'

/** Removals (delete / leave) replayed over the membership list. A raw
 *  cache patch would be overwritten by any listener push that still holds
 *  the trip — the Worker strips memberIds only at the end of its cascade,
 *  and a co-member's activity bump re-sends the doc in the meantime. */
export const tripListOverlay = createListOverlay<Trip>({
  insert: 'head',
  source: 'trips',
})

/** One membership-filtered list shared by all consumers of this uid. */
export const useMyTrips = createRealtimeListHook<Trip>({
  queryKeyFactory: tripKeys.mine,
  initialFetch: getMyTrips,
  subscribe: (uid, _authUid, onData, onError) => subscribeToMyTrips(uid, onData, onError),
  source: 'useMyTrips',
  overlay: tripListOverlay,
})

/** Optimistically drop a trip from MY list until server truth agrees. */
function addTripRemoval(uid: string, tripId: string): OverlayHandle {
  return tripListOverlay.add(tripKeys.mine(uid), {
    kind: 'remove',
    id:   tripId,
    confirms: base => !base.some(t => t.id === tripId),
    authoritativeFetch: () => getMyTripsFromServer(uid),
  })
}

/** Optimistic trip-doc edit; `matches` must cover every field `apply` writes. */
function addTripPatch(
  uid:    string,
  tripId: string,
  op:     { apply: (trip: Trip) => Trip; matches: (trip: Trip) => boolean },
): OverlayHandle {
  return tripListOverlay.add(tripKeys.mine(uid), {
    kind:  'patch',
    id:    tripId,
    apply: op.apply,
    // A trip that left the list cannot confirm a patch; that is the
    // remove's business, so treat it as settled.
    confirms: base => {
      const stored = base.find(t => t.id === tripId)
      return !stored || op.matches(stored)
    },
    authoritativeFetch: () => getMyTripsFromServer(uid),
  })
}

function settleTripOp(handle: OverlayHandle | undefined, err?: unknown): void {
  if (!handle) return
  if (err === undefined) tripListOverlay.markSucceeded(handle)
  else if (isWorkerAmbiguousError(err)) tripListOverlay.markAmbiguous(handle)
  else tripListOverlay.drop(handle)
}

export function useCreateTrip() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ input, user }: { input: CreateTripInput; user: User }) =>
      createTrip(input, user),
    // 失敗由全域 MutationCache.onError 以這個標籤 toast；CreateTripModal 不再自己 toast。
    meta: { action: MUTATION_ACTION.CREATE_TRIP } satisfies MutationMeta,
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
    meta: { action: MUTATION_ACTION.COPY_TRIP } satisfies MutationMeta,
    onSuccess: ({ trip }, { user }) => {
      qc.setQueryData<Trip[]>(tripKeys.mine(user.uid), prev =>
        prev ? [trip, ...prev.filter(t => t.id !== trip.id)] : [trip],
      )
    },
  })
}

export function useUpdateTrip(uid: string | undefined) {
  return useMutation({
    mutationFn: ({ tripId, updates }: { tripId: string; updates: Partial<CreateTripInput> }) =>
      updateTrip(tripId, updates),
    meta: { action: MUTATION_ACTION.UPDATE } satisfies MutationMeta,
    // Client Firestore SDK write: 離線時交給 SDK 佇列（見 useTripListMutation 的 networkMode）。
    networkMode: 'always',
    onMutate: async ({ tripId, updates }) => {
      if (!uid) return { handle: undefined }
      const { Timestamp } = await getFirebase()
      const startDate = updates.startDate ? toTripDateTimestamp(updates.startDate, Timestamp) : undefined
      const endDate   = updates.endDate   ? toTripDateTimestamp(updates.endDate,   Timestamp) : undefined
      const fields: Partial<Pick<Trip, 'title' | 'destination' | 'icon' | 'currency'>> = {}
      if (updates.title       !== undefined) fields.title       = updates.title
      if (updates.destination !== undefined) fields.destination = updates.destination
      if (updates.icon        !== undefined) fields.icon        = updates.icon
      if (updates.currency    !== undefined) fields.currency    = updates.currency
      return { handle: addTripPatch(uid, tripId, {
        apply: t => ({
          ...t, ...fields,
          ...(startDate ? { startDate } : {}),
          ...(endDate   ? { endDate }   : {}),
        }),
        matches: t =>
          Object.entries(fields).every(([k, v]) => t[k as keyof typeof fields] === v)
          && (!startDate || t.startDate.toMillis() === startDate.toMillis())
          && (!endDate   || t.endDate.toMillis()   === endDate.toMillis()),
      }) }
    },
    onSuccess: (_data, _vars, ctx) => settleTripOp(ctx?.handle),
    onError:   (err, _vars, ctx)   => settleTripOp(ctx?.handle, err),
  })
}

/** Owner-only shared Wish voting deadline. Same overlay patch as
 *  useUpdateTrip, scoped to the one field it owns. */
export function useSetWishVotingDeadline(uid: string | undefined) {
  return useMutation({
    mutationFn: ({ tripId, deadlineAt }: { tripId: string; deadlineAt: Date | null }) =>
      setWishVotingDeadline(tripId, deadlineAt),
    meta: { action: MUTATION_ACTION.UPDATE } satisfies MutationMeta,
    networkMode: 'always',
    onMutate: async ({ tripId, deadlineAt }) => {
      if (!uid) return { handle: undefined }
      const { Timestamp } = await getFirebase()
      const next = deadlineAt ? Timestamp.fromDate(deadlineAt) : null
      return { handle: addTripPatch(uid, tripId, {
        apply:   t => ({ ...t, wishVotingDeadlineAt: next }),
        matches: t => (t.wishVotingDeadlineAt?.toMillis() ?? null) === (next?.toMillis() ?? null),
      }) }
    },
    onSuccess: (_data, _vars, ctx) => settleTripOp(ctx?.handle),
    onError:   (err, _vars, ctx)   => settleTripOp(ctx?.handle, err),
  })
}

export function useDeleteTrip(uid: string | undefined) {
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
    onMutate: (tripId) => ({ handle: uid ? addTripRemoval(uid, tripId) : undefined }),
    onSuccess: (_data, tripId, ctx) => {
      settleTripOp(ctx?.handle)
      // Drop per-trip lastViewed entry so localStorage doesn't accumulate
      // stale records for deleted trips.
      useLastViewedStore.getState().clearTrip(tripId)
    },
    // A definitive failure drops only this removal (the trip reappears); an
    // ambiguous one — cascade may have completed while the response was
    // lost — is held until server truth settles it, so no ghost row.
    onError: (err, _tripId, ctx) => settleTripOp(ctx?.handle, err),
  })
}

/**
 * Leave a trip (non-owner self-removal via the Worker /member-leave
 * endpoint). The twin of useDeleteTrip from the trip-LIST cache's point
 * of view: both make a trip disappear from MY world, so the overlay
 * removal + lastViewed cleanup + lost-response reconcile are identical. The only difference is which Worker endpoint runs and that
 * the caller is the target (the Worker reads the uid from the token; the
 * owner is gated out server-side, and the UI hides the affordance for
 * owners anyway).
 */
export function useLeaveTrip(uid: string | undefined) {
  return useMutation({
    mutationFn: (tripId: string) => {
      if (!uid) throw new Error('useLeaveTrip: uid is undefined')
      return leaveMember(tripId)
    },
    meta: { action: MUTATION_ACTION.DELETE } satisfies MutationMeta,
    onMutate: (tripId) => ({ handle: uid ? addTripRemoval(uid, tripId) : undefined }),
    onSuccess: (_data, tripId, ctx) => {
      settleTripOp(ctx?.handle)
      useLastViewedStore.getState().clearTrip(tripId)
    },
    onError: (err, _tripId, ctx) => settleTripOp(ctx?.handle, err),
  })
}
