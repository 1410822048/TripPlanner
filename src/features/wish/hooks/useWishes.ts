// src/features/wish/hooks/useWishes.ts
// Realtime-backed via createRealtimeListHook — vote toggles from other
// members appear without a refresh, the most "live" tab in the app.
// Mutations stay optimistic; the snapshot listener reconciles.
//
// `toggleVote` is split out from `updateWish` so vote-button latency is
// tight (no full doc patch / no Zod validation).
import {
  getWishesByTrip,
  subscribeToWishes,
  createWish,
  updateWish,
  deleteWish,
  toggleWishVote,
} from '../services/wishService'
import { createRealtimeListHook } from '@/hooks/createRealtimeListHook'
import { useTripListMutation } from '@/hooks/useTripListMutation'
import { tempId } from '@/utils/tempId'
import { auditUpdateMock } from '@/utils/audit'
import type { CreateWishInput, Wish, WishImage } from '@/types'
import { MOCK_TIMESTAMP } from '@/mocks/utils'
import { MUTATION_ACTION, type MutationOptions } from '@/services/queryClient'

export const wishKeys = {
  all: (tripId: string, uid?: string) => ['wishes', tripId, uid ?? ''] as const,
}

export const useWishes = createRealtimeListHook<Wish>({
  queryKeyFactory: wishKeys.all,
  initialFetch:    (tripId, uid) => getWishesByTrip(tripId, uid),
  subscribe:       (tripId, uid, onData, onError) => subscribeToWishes(tripId, uid, onData, onError),
  source:          'useWishes',
  requiresUid:     true,
})

export function useCreateWish(tripId: string, options?: MutationOptions) {
  return useTripListMutation<Wish, {
    input:      CreateWishInput
    file:       File | null
    proposedBy: string
  }>({
    tripId,
    keyFactory: wishKeys.all,
    mutate:     ({ input, file, proposedBy }) => createWish(tripId, input, file, proposedBy),
    patch:      (prev, { input, proposedBy }) => [
      {
        id:        tempId(),
        tripId,
        memberIds: [proposedBy],
        ...input,
        proposedBy,
        votes:     [proposedBy],
        createdAt: MOCK_TIMESTAMP,
        ...auditUpdateMock(proposedBy),
      },
      ...prev,
    ],
    action:     MUTATION_ACTION.ADD,
    silent:     options?.silent,
  })
}

export function useUpdateWish(tripId: string, options?: MutationOptions) {
  return useTripListMutation<Wish, {
    wishId:        string
    updates:       Partial<CreateWishInput>
    uid:           string
    attachment:    File | null | undefined
    existingImage: WishImage | undefined
  }>({
    tripId,
    keyFactory: wishKeys.all,
    mutate:     ({ wishId, updates, uid, attachment, existingImage }) =>
      updateWish(tripId, wishId, updates, { uid, attachment, existingImage }),
    patch:      (prev, { wishId, updates, uid }) =>
      prev.map(w => w.id === wishId ? { ...w, ...updates, ...auditUpdateMock(uid) } : w),
    action:     MUTATION_ACTION.UPDATE,
    silent:     options?.silent,
  })
}

export function useDeleteWish(tripId: string) {
  return useTripListMutation<Wish, { wishId: string; image: WishImage | undefined }>({
    tripId,
    keyFactory: wishKeys.all,
    mutate:     ({ wishId, image }, { uid }) => deleteWish(tripId, wishId, uid, image),
    patch:      (prev, { wishId }) => prev.filter(w => w.id !== wishId),
    action:     MUTATION_ACTION.DELETE,
  })
}

/** Toggle caller's vote. Optimistic so the heart fills/empties
 *  immediately; listener pushes server-side re-ordering on concurrent votes. */
export function useToggleWishVote(tripId: string) {
  return useTripListMutation<Wish, { wishId: string; uid: string; isVoting: boolean }>({
    tripId,
    keyFactory: wishKeys.all,
    mutate:     ({ wishId, uid, isVoting }) => toggleWishVote(tripId, wishId, uid, isVoting),
    patch:      (prev, { wishId, uid, isVoting }) =>
      prev.map(w => {
        if (w.id !== wishId) return w
        const next = isVoting
          ? w.votes.includes(uid) ? w.votes : [...w.votes, uid]
          : w.votes.filter(u => u !== uid)
        return { ...w, votes: next, ...auditUpdateMock(uid) }
      }),
    action:     MUTATION_ACTION.TOGGLE_VOTE,
  })
}
