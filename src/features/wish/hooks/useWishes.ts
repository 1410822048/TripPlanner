// src/features/wish/hooks/useWishes.ts
// Same optimistic-update pattern as useBookings / useExpenses.
// `toggleVote` is its own mutation distinct from `updateWish` so the
// vote-button latency is tighter (no full doc patch / no validation).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getWishesByTrip,
  createWish,
  updateWish,
  deleteWish,
  toggleWishVote,
} from '../services/wishService'
import type { CreateWishInput, Wish, WishImage } from '@/types'
import { MOCK_TIMESTAMP } from '@/mocks/utils'
import { toast } from '@/shared/toast'

export const wishKeys = {
  all: (tripId: string) => ['wishes', tripId] as const,
}

function tempId() { return `temp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` }

function patchCache(
  qc: ReturnType<typeof useQueryClient>,
  tripId: string,
  fn: (prev: Wish[]) => Wish[],
): { prev: Wish[] | undefined } {
  const key  = wishKeys.all(tripId)
  const prev = qc.getQueryData<Wish[]>(key)
  qc.setQueryData<Wish[]>(key, fn(prev ?? []))
  return { prev }
}

export function useWishes(tripId: string | undefined) {
  return useQuery({
    queryKey: wishKeys.all(tripId ?? ''),
    queryFn:  () => getWishesByTrip(tripId!),
    enabled:  !!tripId,
  })
}

export function useCreateWish(tripId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ input, file, proposedBy }: {
      input:      CreateWishInput
      file:       File | null
      proposedBy: string
    }) => createWish(tripId, input, file, proposedBy),
    onMutate: ({ input, proposedBy }) =>
      patchCache(qc, tripId, prev => {
        const optimistic: Wish = {
          id: tempId(),
          tripId,
          ...input,
          proposedBy,
          votes:     [proposedBy],
          createdAt: MOCK_TIMESTAMP,
          updatedAt: MOCK_TIMESTAMP,
        }
        return [optimistic, ...prev]
      }),
    onError: (err, _vars, ctx) => {
      if (ctx?.prev !== undefined) qc.setQueryData(wishKeys.all(tripId), ctx.prev)
      toast.error(err instanceof Error ? `追加に失敗：${err.message}` : '追加に失敗しました')
    },
    onSettled: () => qc.invalidateQueries({ queryKey: wishKeys.all(tripId) }),
  })
}

export function useUpdateWish(tripId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ wishId, updates, attachment, existingImage }: {
      wishId:        string
      updates:       Partial<CreateWishInput>
      attachment:    File | null | undefined
      existingImage: WishImage | undefined
    }) => updateWish(tripId, wishId, updates, attachment, existingImage),
    onMutate: ({ wishId, updates }) =>
      patchCache(qc, tripId, prev =>
        prev.map(w => w.id === wishId ? { ...w, ...updates, updatedAt: MOCK_TIMESTAMP } : w),
      ),
    onError: (err, _vars, ctx) => {
      if (ctx?.prev !== undefined) qc.setQueryData(wishKeys.all(tripId), ctx.prev)
      toast.error(err instanceof Error ? `更新に失敗：${err.message}` : '更新に失敗しました')
    },
    onSettled: () => qc.invalidateQueries({ queryKey: wishKeys.all(tripId) }),
  })
}

export function useDeleteWish(tripId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ wishId, image }: { wishId: string; image: WishImage | undefined }) =>
      deleteWish(tripId, wishId, image),
    onMutate: ({ wishId }) =>
      patchCache(qc, tripId, prev => prev.filter(w => w.id !== wishId)),
    onError: (err, _vars, ctx) => {
      if (ctx?.prev !== undefined) qc.setQueryData(wishKeys.all(tripId), ctx.prev)
      toast.error(err instanceof Error ? `削除に失敗：${err.message}` : '削除に失敗しました')
    },
    onSettled: () => qc.invalidateQueries({ queryKey: wishKeys.all(tripId) }),
  })
}

/**
 * Toggle the caller's vote. Optimistic so the heart fills/empties
 * immediately; server reconciliation may briefly re-order the list if
 * other members' votes raced in concurrently. We don't invalidate on
 * settle because the optimistic patch already covers the visible state.
 */
export function useToggleWishVote(tripId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ wishId, uid, isVoting }: {
      wishId:   string
      uid:      string
      isVoting: boolean
    }) => toggleWishVote(tripId, wishId, uid, isVoting),
    onMutate: ({ wishId, uid, isVoting }) =>
      patchCache(qc, tripId, prev =>
        prev.map(w => {
          if (w.id !== wishId) return w
          const next = isVoting
            ? w.votes.includes(uid) ? w.votes : [...w.votes, uid]
            : w.votes.filter(u => u !== uid)
          return { ...w, votes: next }
        }),
      ),
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev !== undefined) qc.setQueryData(wishKeys.all(tripId), ctx.prev)
      toast.error('投票に失敗しました')
    },
    // Light invalidate — server-side ordering may have shifted with
    // concurrent votes. Quick refetch keeps the leaderboard fresh.
    onSettled: () => qc.invalidateQueries({ queryKey: wishKeys.all(tripId) }),
  })
}
