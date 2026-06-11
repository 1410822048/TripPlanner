// src/features/members/hooks/useMembers.ts
// Realtime-backed via createRealtimeListHook — when an invitee redeems
// a link, every existing member sees the new entry appear in the
// roster live (rather than needing a manual refresh, which used to be
// a confusing UX gap right after invite acceptance).
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { getMembersByTrip, subscribeToMembers, removeMember, updateMemberRole, transferOwnership } from '../services/memberService'
import { createRealtimeListHook } from '@/hooks/createRealtimeListHook'
import { tripKeys } from '@/features/trips/queryKeys'
import { useUid } from '@/hooks/useAuth'
import { MUTATION_ACTION, type MutationMeta } from '@/services/queryClient'
import type { Member } from '@/types'

export const memberKeys = {
  all: (tripId: string, uid?: string) => ['members', tripId, uid ?? ''] as const,
}

export const useMembers = createRealtimeListHook<Member>({
  queryKeyFactory: memberKeys.all,
  initialFetch:    (tripId, uid) => getMembersByTrip(tripId, uid),
  subscribe:       (tripId, uid, onData, onError) => subscribeToMembers(tripId, uid, onData, onError),
  source:          'useMembers',
  requiresUid:     true,
})

/**
 * Owner-only mutation to remove a member. Optimistically drops the row from
 * the cached list so the UI feels immediate; rolls back + surfaces a toast
 * if Firestore rejects (non-owner caller, or member was already removed).
 */
export function useRemoveMember(tripId: string | undefined) {
  const qc = useQueryClient()
  const uid = useUid()
  return useMutation({
    mutationFn: (memberId: string) => removeMember(tripId!, memberId),
    meta: { action: MUTATION_ACTION.DELETE } satisfies MutationMeta,
    onMutate: (memberId) => {
      if (!tripId) return { prev: undefined as Member[] | undefined }
      const key  = memberKeys.all(tripId, uid)
      const prev = qc.getQueryData<Member[]>(key)
      if (prev) qc.setQueryData<Member[]>(key, prev.filter(m => m.id !== memberId))
      return { prev }
    },
    onError: (_err, _id, ctx) => {
      if (tripId && ctx?.prev !== undefined) qc.setQueryData(memberKeys.all(tripId, uid), ctx.prev)
    },
  })
}

/**
 * Owner-only mutation to flip a member between editor and viewer. Same
 * optimistic pattern as useRemoveMember: patch the cached row immediately,
 * roll back + toast on failure.
 */
export function useUpdateMemberRole(tripId: string | undefined) {
  const qc = useQueryClient()
  const uid = useUid()
  return useMutation({
    mutationFn: ({ memberId, role }: { memberId: string; role: 'editor' | 'viewer' }) =>
      updateMemberRole(tripId!, memberId, role),
    meta: { action: MUTATION_ACTION.CHANGE_ROLE } satisfies MutationMeta,
    onMutate: ({ memberId, role }) => {
      if (!tripId) return { prev: undefined as Member[] | undefined }
      const key  = memberKeys.all(tripId, uid)
      const prev = qc.getQueryData<Member[]>(key)
      if (prev) qc.setQueryData<Member[]>(key,
        prev.map(m => m.id === memberId ? { ...m, role } : m),
      )
      return { prev }
    },
    onError: (_err, _vars, ctx) => {
      if (tripId && ctx?.prev !== undefined) qc.setQueryData(memberKeys.all(tripId, uid), ctx.prev)
    },
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
