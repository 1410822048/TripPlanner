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
import { useUid } from '@/hooks/useAuth'
import { tempId } from '@/utils/tempId'
import { patchListCache, rollbackListCache } from '@/utils/queryCache'
import { auditUpdateMock } from '@/utils/audit'
import type { CreateWishInput, Wish, WishImage } from '@/types'
import { MOCK_TIMESTAMP } from '@/mocks/utils'
import type { MutationMeta, MutationOptions } from '@/services/queryClient'

export const wishKeys = {
  all: (tripId: string, uid?: string) => ['wishes', tripId, uid ?? ''] as const,
}

export const useWishes = createRealtimeListHook<Wish>({
  queryKeyFactory: wishKeys.all,
  initialFetch:    (tripId, uid) => getWishesByTrip(tripId, uid!),
  subscribe:       (tripId, uid, onData, onError) => subscribeToWishes(tripId, uid!, onData, onError),
  source:          'useWishes',
  requiresUid:     true,
})

export function useCreateWish(tripId: string, options?: MutationOptions) {
  const qc = useQueryClient()
  const uid = useUid()
  const key = wishKeys.all(tripId, uid)
  return useMutation({
    mutationFn: ({ input, file, proposedBy }: {
      input:      CreateWishInput
      file:       File | null
      proposedBy: string
    }) => createWish(tripId, input, file, proposedBy),
    meta: { action: '追加', silent: options?.silent } satisfies MutationMeta,
    onMutate: ({ input, proposedBy }) =>
      patchListCache<Wish>(qc, key, prev => [
        {
          id: tempId(),
          tripId,
          memberIds: [proposedBy],
          ...input,
          proposedBy,
          votes:     [proposedBy],
          createdAt: MOCK_TIMESTAMP,
          ...auditUpdateMock(proposedBy),
        },
        ...prev,
      ]),
    onError: (_err, _vars, ctx) => {
      rollbackListCache<Wish>(qc, key, ctx)
    },
  })
}

export function useUpdateWish(tripId: string, options?: MutationOptions) {
  const qc = useQueryClient()
  const uid = useUid()
  const key = wishKeys.all(tripId, uid)
  return useMutation({
    mutationFn: ({ wishId, updates, uid, attachment, existingImage }: {
      wishId:        string
      updates:       Partial<CreateWishInput>
      uid:           string
      attachment:    File | null | undefined
      existingImage: WishImage | undefined
    }) => updateWish(tripId, wishId, updates, { uid, attachment, existingImage }),
    meta: { action: '更新', silent: options?.silent } satisfies MutationMeta,
    onMutate: ({ wishId, updates, uid }) =>
      patchListCache<Wish>(qc, key, prev =>
        prev.map(w => w.id === wishId ? { ...w, ...updates, ...auditUpdateMock(uid) } : w),
      ),
    onError: (_err, _vars, ctx) => {
      rollbackListCache<Wish>(qc, key, ctx)
    },
  })
}

export function useDeleteWish(tripId: string) {
  const qc = useQueryClient()
  const uid = useUid()
  const key = wishKeys.all(tripId, uid)
  return useMutation({
    mutationFn: ({ wishId, image }: { wishId: string; image: WishImage | undefined }) =>
      deleteWish(tripId, wishId, uid!, image),
    meta: { action: '削除' } satisfies MutationMeta,
    onMutate: ({ wishId }) =>
      patchListCache<Wish>(qc, key, prev => prev.filter(w => w.id !== wishId)),
    onError: (_err, _vars, ctx) => {
      rollbackListCache<Wish>(qc, key, ctx)
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
  const uid = useUid()
  const key = wishKeys.all(tripId, uid)
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
          return { ...w, votes: next, ...auditUpdateMock(uid) }
        }),
      ),
    meta: { action: '投票' } satisfies MutationMeta,
    onError: (_err, _vars, ctx) => {
      rollbackListCache<Wish>(qc, key, ctx)
    },
  })
}
