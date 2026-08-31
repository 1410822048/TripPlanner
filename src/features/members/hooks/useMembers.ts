// src/features/members/hooks/useMembers.ts
// Realtime-backed via createRealtimeListHook — when an invitee redeems
// a link, every existing member sees the new entry appear in the
// roster live (rather than needing a manual refresh, which used to be
// a confusing UX gap right after invite acceptance).
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getMembersByTrip,
  getMembersByTripFromServer,
  subscribeToMembers,
  removeMember,
  updateMemberRole,
  transferOwnership,
} from '../services/memberService'
import { createRealtimeListHook } from '@/hooks/createRealtimeListHook'
import { createListOverlay } from '@/hooks/listOverlay'
import { useTripListMutation } from '@/hooks/useTripListMutation'
import { tripKeys } from '@/features/trips/queryKeys'
import { useUid } from '@/hooks/useAuth'
import { MUTATION_ACTION, type MutationMeta } from '@/services/queryClient'
import type { Member } from '@/types'

export const memberKeys = {
  all: (tripId: string, uid?: string) => ['members', tripId, uid ?? ''] as const,
}

/** Roster edits are optimistic as ops replayed over server truth, never as a
 *  cache patch with a snapshot to restore. The list is realtime, so a
 *  rollback would also undo whatever the listener pushed while the write was
 *  in flight, and one failing edit would revert a concurrent edit to another
 *  row. Neither is expressible here: an op only ever undoes itself. */
export const memberOverlay = createListOverlay<Member>({
  insert: 'tail',
  source: 'members',
})

export const useMembers = createRealtimeListHook<Member>({
  queryKeyFactory: memberKeys.all,
  initialFetch:    (tripId, uid) => getMembersByTrip(tripId, uid),
  subscribe:       (tripId, uid, onData, onError) => subscribeToMembers(tripId, uid, onData, onError),
  source:          'useMembers',
  requiresUid:     true,
  overlay:         memberOverlay,
})

/** Owner-only removal. The row disappears at once and returns if the write
 *  turns out to have been refused.
 *
 *  Both roster mutations go through the Worker, so a failure can be
 *  ambiguous and only a server read settles it. `whenUnconfirmable: 'drop'`
 *  because a roster claiming access was revoked while it is in fact intact
 *  is the dangerous direction to fail in; a stale row just looks out of date
 *  and the next snapshot corrects it. */
export function useRemoveMember(tripId: string) {
  return useTripListMutation<Member, string>({
    tripId,
    keyFactory: memberKeys.all,
    mutate:     memberId => removeMember(tripId, memberId),
    overlay: {
      controller: memberOverlay,
      op: (memberId, { uid }) => ({
        kind: 'remove',
        id:   memberId,
        confirms: base => !base.some(m => m.id === memberId),
        authoritativeFetch: () => getMembersByTripFromServer(tripId, uid ?? ''),
        whenUnconfirmable: 'drop',
      }),
    },
    action: MUTATION_ACTION.DELETE,
  })
}

/** Owner-only editor ⇄ viewer flip. `confirms` checks the role itself, not
 *  just the row's presence — a predicate weaker than the patch would retire
 *  the op against a base that still carries the old role, snapping the badge
 *  back. */
export function useUpdateMemberRole(tripId: string) {
  return useTripListMutation<Member, { memberId: string; role: 'editor' | 'viewer' }>({
    tripId,
    keyFactory: memberKeys.all,
    mutate:     ({ memberId, role }) => updateMemberRole(tripId, memberId, role),
    overlay: {
      controller: memberOverlay,
      op: ({ memberId, role }, { uid }) => ({
        kind:  'patch',
        id:    memberId,
        apply: m => ({ ...m, role }),
        confirms: base => base.some(m => m.id === memberId && m.role === role),
        authoritativeFetch: () => getMembersByTripFromServer(tripId, uid ?? ''),
        whenUnconfirmable: 'drop',
      }),
    },
    action: MUTATION_ACTION.CHANGE_ROLE,
  })
}

/**
 * Owner-only mutation to transfer trip ownership to another member. Worker
 * atomically flips trip.ownerId + caller→editor + target→owner.
 *
 * NOT optimistic: the transfer touches two member-role rows AND the trip
 * doc's ownerId across two separate caches; a half-optimistic patch reads
 * worse than letting the realtime listeners (useMembers role + useMyTrips
 * ownerId) reflect it. `onSettled` invalidates both so a lost HTTP response
 * / listener race still reconciles to server truth — same reasoning as
 * useDeleteTrip / useLeaveTrip. The MembersModal surfaces a success toast;
 * failures go through the global MutationCache toast (meta.action).
 */
export function useTransferOwnership(tripId: string | undefined) {
  const qc = useQueryClient()
  const uid = useUid()
  return useMutation({
    mutationFn: (targetUid: string) => transferOwnership(tripId!, targetUid),
    meta: { action: MUTATION_ACTION.TRANSFER_OWNER } satisfies MutationMeta,
    onSettled: () => {
      if (!tripId || !uid) return
      qc.invalidateQueries({ queryKey: memberKeys.all(tripId, uid) })
      qc.invalidateQueries({ queryKey: tripKeys.mine(uid) })
      qc.invalidateQueries({ queryKey: tripKeys.myIds(uid) })
    },
  })
}
