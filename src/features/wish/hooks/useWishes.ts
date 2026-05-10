// src/features/wish/hooks/useWishes.ts
// useWishes is realtime-backed via createRealtimeListHook — vote toggles
// from other members appear in real time without a refresh, which is
// where realtime matters most (the wish list is the most "live" tab in
// the app — multiple people interact with it at the same time).
//
// Mutations stay optimistic for instant local feedback; the snapshot
// listener handles reconciliation, no onSettled invalidates needed.
//
// `toggleVote` is its own mutation distinct from `updateWish` so the
// vote-button latency is tighter (no full doc patch / no validation).
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getWishesByTrip,
  subscribeToWishes,
  createWish,
  updateWish,
  deleteWish,
  toggleWishVote,
} from '../services/wishService'
import { createRealtimeListHook } from '@/hooks/createRealtimeListHook'
import { tempId } from '@/utils/tempId'
import { patchListCache, rollbackListCache } from '@/utils/queryCache'
import type { CreateWishInput, Wish, WishImage } from '@/types'
import { MOCK_TIMESTAMP } from '@/mocks/utils'
import { toast } from '@/shared/toast'

export const wishKeys = {
  all: (tripId: string) => ['wishes', tripId] as const,
}

export const useWishes = createRealtimeListHook<Wish>({
  queryKeyFactory: wishKeys.all,
  initialFetch:    getWishesByTrip,
  subscribe:       subscribeToWishes,
  source:          'useWishes',
})

export function useCreateWish(tripId: string) {
  const qc = useQueryClient()
  const key = wishKeys.all(tripId)
  return useMutation({
    mutationFn: ({ input, file, proposedBy }: {
      input:      CreateWishInput
      file:       File | null
      proposedBy: string
    }) => createWish(tripId, input, file, proposedBy),
    onMutate: ({ input, proposedBy }) =>
      patchListCache<Wish>(qc, key, prev => [
        {
          id: tempId(),
          tripId,
          ...input,
          proposedBy,
          votes:     [proposedBy],
          createdAt: MOCK_TIMESTAMP,
          updatedAt: MOCK_TIMESTAMP,
        },
        ...prev,
      ]),
    onError: (err, _vars, ctx) => {
      rollbackListCache<Wish>(qc, key, ctx)
      toast.mutationError(err, '追加')
    },
  })
}

export function useUpdateWish(tripId: string) {
  const qc = useQueryClient()
  const key = wishKeys.all(tripId)
  return useMutation({
    mutationFn: ({ wishId, updates, attachment, existingImage }: {
      wishId:        string
      updates:       Partial<CreateWishInput>
      attachment:    File | null | undefined
      existingImage: WishImage | undefined
    }) => updateWish(tripId, wishId, updates, attachment, existingImage),
    onMutate: ({ wishId, updates }) =>
      patchListCache<Wish>(qc, key, prev =>
        prev.map(w => w.id === wishId ? { ...w, ...updates, updatedAt: MOCK_TIMESTAMP } : w),
      ),
    onError: (err, _vars, ctx) => {
      rollbackListCache<Wish>(qc, key, ctx)
      toast.mutationError(err, '更新')
    },
  })
}

export function useDeleteWish(tripId: string) {
  const qc = useQueryClient()
  const key = wishKeys.all(tripId)
  return useMutation({
    mutationFn: ({ wishId, image }: { wishId: string; image: WishImage | undefined }) =>
      deleteWish(tripId, wishId, image),
    onMutate: ({ wishId }) =>
      patchListCache<Wish>(qc, key, prev => prev.filter(w => w.id !== wishId)),
    onError: (err, _vars, ctx) => {
      rollbackListCache<Wish>(qc, key, ctx)
      toast.mutationError(err, '削除')
    },
  })
}

/**
 * Toggle the caller's vote. Optimistic so the heart fills/empties
 * immediately; the realtime listener pushes server-side re-ordering
 * when concurrent votes land.
 */
export function useToggleWishVote(tripId: string) {
  const qc = useQueryClient()
  const key = wishKeys.all(tripId)
  return useMutation({
    mutationFn: ({ wishId, uid, isVoting }: {
      wishId:   string
      uid:      string
      isVoting: boolean
    }) => toggleWishVote(tripId, wishId, uid, isVoting),
    onMutate: ({ wishId, uid, isVoting }) =>
      patchListCache<Wish>(qc, key, prev =>
        prev.map(w => {
          if (w.id !== wishId) return w
          const next = isVoting
            ? w.votes.includes(uid) ? w.votes : [...w.votes, uid]
            : w.votes.filter(u => u !== uid)
          return { ...w, votes: next }
        }),
      ),
    onError: (_err, _vars, ctx) => {
      rollbackListCache<Wish>(qc, key, ctx)
      toast.error('投票に失敗しました')
    },
  })
}
