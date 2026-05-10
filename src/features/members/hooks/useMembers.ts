// src/features/members/hooks/useMembers.ts
// Realtime-backed via createRealtimeListHook — when an invitee redeems
// a link, every existing member sees the new entry appear in the
// roster live (rather than needing a manual refresh, which used to be
// a confusing UX gap right after invite acceptance).
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { getMembersByTrip, subscribeToMembers, removeMember, updateMemberRole } from '../services/memberService'
import { createRealtimeListHook } from '@/hooks/createRealtimeListHook'
import { toast } from '@/shared/toast'
import type { Member } from '@/types'

export const memberKeys = {
  all: (tripId: string) => ['members', tripId] as const,
}

export const useMembers = createRealtimeListHook<Member>({
  queryKeyFactory: memberKeys.all,
  initialFetch:    getMembersByTrip,
  subscribe:       subscribeToMembers,
  source:          'useMembers',
})

/**
 * Owner-only mutation to remove a member. Optimistically drops the row from
 * the cached list so the UI feels immediate; rolls back + surfaces a toast
 * if Firestore rejects (non-owner caller, or member was already removed).
 */
export function useRemoveMember(tripId: string | undefined) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (memberId: string) => removeMember(tripId!, memberId),
    onMutate: (memberId) => {
      if (!tripId) return { prev: undefined as Member[] | undefined }
      const key  = memberKeys.all(tripId)
      const prev = qc.getQueryData<Member[]>(key)
      if (prev) qc.setQueryData<Member[]>(key, prev.filter(m => m.id !== memberId))
      return { prev }
    },
    onError: (err, _id, ctx) => {
      if (tripId && ctx?.prev !== undefined) qc.setQueryData(memberKeys.all(tripId), ctx.prev)
      toast.mutationError(err, '削除')
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
  return useMutation({
    mutationFn: ({ memberId, role }: { memberId: string; role: 'editor' | 'viewer' }) =>
      updateMemberRole(tripId!, memberId, role),
    onMutate: ({ memberId, role }) => {
      if (!tripId) return { prev: undefined as Member[] | undefined }
      const key  = memberKeys.all(tripId)
      const prev = qc.getQueryData<Member[]>(key)
      if (prev) qc.setQueryData<Member[]>(key,
        prev.map(m => m.id === memberId ? { ...m, role } : m),
      )
      return { prev }
    },
    onError: (err, _vars, ctx) => {
      if (tripId && ctx?.prev !== undefined) qc.setQueryData(memberKeys.all(tripId), ctx.prev)
      toast.mutationError(err, '権限変更')
    },
  })
}
