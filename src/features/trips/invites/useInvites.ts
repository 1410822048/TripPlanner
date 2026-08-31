// src/features/trips/invites/useInvites.ts
// TanStack Query wrappers for invite lifecycle. Create and redeem seed the
// cache from their authoritative Worker response; revoke is optimistic as a
// read-time overlay op (see hooks/listOverlay.ts). Failures toast through
// the global MutationCache.
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { User } from 'firebase/auth'
import {
  createInvite,
  listInvites,
  listInvitesFromServer,
  subscribeToInvites,
  revokeInvite,
  acceptInvite,
  type AcceptResult,
} from './inviteService'
import { createRealtimeListHook } from '@/hooks/createRealtimeListHook'
import { createListOverlay } from '@/hooks/listOverlay'
import { useTripListMutation } from '@/hooks/useTripListMutation'
import { tripKeys } from '@/features/trips/queryKeys'
import { MUTATION_ACTION, type MutationMeta } from '@/services/queryClient'
import type { Invite, Trip } from '@/types'

const inviteKeys = {
  ofTrip: (tripId: string, _uid?: string) => ['invites', tripId] as const,
}

/** Revoke only. Creation isn't optimistic and must not become so: the token
 *  and expiry are minted by the Worker, so the response IS the row — there
 *  is nothing to guess ahead of it. */
export const inviteOverlay = createListOverlay<Invite>({
  insert: 'head',
  source: 'invites',
})

/** Internal realtime base — subscribes to /trips/{tripId}/invites for
 *  any tripId we feed it. Wrapped by useInvites below to layer on the
 *  caller-side `enabled` flag (modal must be open + user signed in). */
const useInvitesBase = createRealtimeListHook<Invite>({
  queryKeyFactory: inviteKeys.ofTrip,
  initialFetch:    listInvites,
  subscribe:       (tripId, _uid, onData, onError) => subscribeToInvites(tripId, onData, onError),
  source:          'useInvites',
  overlay:         inviteOverlay,
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
    meta: { action: MUTATION_ACTION.CREATE_INVITE } satisfies MutationMeta,
    onSuccess: (invite) => {
      // Replace (not prepend) the cache: the service atomically deletes old
      // invites when creating a new one, so after success there should be
      // exactly one invite in the list — the one we just made.
      qc.setQueryData<Invite[]>(inviteKeys.ofTrip(invite.tripId), [invite])
    },
  })
}

/**
 * Revoke the active invite. The card disappears immediately and comes back
 * if the Worker refuses (409 on an already-rotated token).
 *
 * `whenUnconfirmable: 'drop'` — a link that looks revoked but isn't can
 * still be redeemed, so an unreachable server reveals rather than hides.
 */
export function useRevokeInvite(tripId: string) {
  return useTripListMutation<Invite, string>({
    tripId,
    keyFactory: inviteKeys.ofTrip,
    mutate:     token => revokeInvite(tripId, token),
    overlay: {
      controller: inviteOverlay,
      op: token => ({
        kind: 'remove',
        id:   token,
        confirms: base => !base.some(i => i.id === token),
        authoritativeFetch: () => listInvitesFromServer(tripId),
        whenUnconfirmable: 'drop',
      }),
    },
    action: MUTATION_ACTION.REVOKE_INVITE,
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
 * caller (InvitePage) can use it to switch the active trip before
 * navigating to /schedule. If the post-redeem fetch fails (rare —
 * rules race, schema mismatch), `trip` is null and we skip the seed;
 * the listeners will fill the cache shortly anyway. The caller still
 * has the URL `tripId` to fall back on for the selection itself, so
 * the "stay on old trip" failure mode doesn't reappear.
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
