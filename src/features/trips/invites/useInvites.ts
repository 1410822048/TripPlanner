// src/features/trips/invites/useInvites.ts
// TanStack Query wrappers for invite lifecycle. Pattern matches useTrips:
// optimistic cache updates on create/revoke, invalidate-on-error, toast on
// failure. acceptInvite additionally invalidates useMyTrips so the newly-
// joined trip shows up in the switcher immediately.
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { User } from 'firebase/auth'
import {
  createInvite,
  listInvites,
  subscribeToInvites,
  revokeInvite,
  acceptInvite,
  type AcceptResult,
} from './inviteService'
import { createRealtimeListHook } from '@/hooks/createRealtimeListHook'
import { tripKeys } from '@/features/trips/hooks/useTrips'
import type { MutationMeta } from '@/services/queryClient'
import type { Invite, Trip } from '@/types'

export const inviteKeys = {
  ofTrip: (tripId: string, _uid?: string) => ['invites', tripId] as const,
}

/** Internal realtime base — subscribes to /trips/{tripId}/invites for
 *  any tripId we feed it. Wrapped by useInvites below to layer on the
 *  caller-side `enabled` flag (modal must be open + user signed in). */
const useInvitesBase = createRealtimeListHook<Invite>({
  queryKeyFactory: inviteKeys.ofTrip,
  initialFetch:    listInvites,
  subscribe:       (tripId, _uid, onData, onError) => subscribeToInvites(tripId, onData, onError),
  source:          'useInvites',
})

/**
 * Owner-only: list every invite (active + expired) for a trip,
 * realtime-pushed via onSnapshot. The `enabled` flag lets InviteModal
 * defer subscription until the modal is actually open + auth resolved
 * — passing undefined as the key short-circuits the underlying
 * factory hook, so no listener is opened when disabled.
 */
export function useInvites(tripId: string | undefined, enabled: boolean = true) {
  return useInvitesBase(enabled ? tripId : undefined)
}

export function useCreateInvite() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ trip, role, user }: {
      trip: Trip
      role: 'editor' | 'viewer'
      user: User
    }) => createInvite(trip, role, user),
    meta: { action: '邀請連結作成' } satisfies MutationMeta,
    onSuccess: (invite) => {
      // Replace (not prepend) the cache: the service atomically deletes old
      // invites when creating a new one, so after success there should be
      // exactly one invite in the list — the one we just made.
      qc.setQueryData<Invite[]>(inviteKeys.ofTrip(invite.tripId), [invite])
    },
  })
}

export function useRevokeInvite(tripId: string | undefined) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (token: string) => revokeInvite(tripId!, token),
    meta: { action: '取り消し' } satisfies MutationMeta,
    onMutate: (token) => {
      if (!tripId) return { prev: undefined as Invite[] | undefined }
      const key  = inviteKeys.ofTrip(tripId)
      const prev = qc.getQueryData<Invite[]>(key)
      if (prev) qc.setQueryData<Invite[]>(key, prev.filter(i => i.id !== token))
      return { prev }
    },
    onError: (_err, _token, ctx) => {
      if (tripId && ctx?.prev !== undefined) qc.setQueryData(inviteKeys.ofTrip(tripId), ctx.prev)
    },
  })
}

/**
 * Redeem an invite. On success, the trip + id caches are seeded with
 * the freshly-joined trip so the switcher reflects membership without
 * waiting for the realtime listener's first push (~100-300ms).
 * Listeners then take over: useMyTripIds picks up the new member doc
 * via its collection-group subscription, and useMyTrips opens a doc
 * listener for the new trip, so any subsequent changes flow through
 * naturally.
 *
 * The trip object travels back through the mutation result so the
 * caller (InvitePage) can also setCurrentTrip(trip) before navigating
 * to /schedule. If the service couldn't fetch the trip post-redeem
 * (rare — rules race, schema mismatch), we skip the seed; the
 * listeners will fill the cache shortly anyway.
 */
export function useAcceptInvite() {
  const qc = useQueryClient()
  return useMutation<
    AcceptResult,
    Error,
    { tripId: string; token: string; user: User }
  >({
    mutationFn: ({ tripId, token, user }) => acceptInvite(tripId, token, user),
    onSuccess: ({ trip }, { user }) => {
      if (!trip) return  // listeners will reconcile within a few hundred ms
      qc.setQueryData<Trip[]>(tripKeys.mine(user.uid), prev =>
        prev ? [trip, ...prev.filter(t => t.id !== trip.id)] : [trip],
      )
      qc.setQueryData<string[]>(tripKeys.myIds(user.uid), prev =>
        prev ? [trip.id, ...prev.filter(id => id !== trip.id)] : [trip.id],
      )
    },
  })
}
