// src/features/members/hooks/useMembers.ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getMembersByTrip, removeMember, updateMemberRole } from '../services/memberService'
import { toast } from '@/shared/toast'
import type { Member } from '@/types'

export const memberKeys = {
  all: (tripId: string) => ['members', tripId] as const,
}

export function useMembers(tripId: string | undefined) {
  return useQuery({
    queryKey: memberKeys.all(tripId ?? ''),
    queryFn:  () => getMembersByTrip(tripId!),
    enabled:  !!tripId,
  })
}

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
      toast.error(err instanceof Error ? `削除に失敗：${err.message}` : '削除に失敗しました')
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
      toast.error(err instanceof Error ? `権限変更に失敗：${err.message}` : '権限変更に失敗しました')
    },
  })
}
