// src/features/wish/hooks/useWishes.ts
// Realtime-backed via createRealtimeListHook — vote toggles from other
// members appear without a refresh, the most "live" tab in the app.
// Mutations stay optimistic; the snapshot listener reconciles.
//
// `toggleVote` is split out from `updateWish` so vote-button latency is
// tight (no full doc patch / no Zod validation).
import {
  getWishesByTrip,
  getWishesByTripFromServer,
  subscribeToWishes,
  createWish,
  updateWish,
  deleteWish,
  toggleWishVote,
  wishUpdateApplied,
} from '../services/wishService'
import { createRealtimeListHook } from '@/hooks/createRealtimeListHook'
import { createListOverlay } from '@/hooks/listOverlay'
import { useTripListMutation, type UseTripListMutationOpts } from '@/hooks/useTripListMutation'
import { auditUpdateMock } from '@/utils/audit'
import type { CreateWishInput, Wish, WishImage } from '@/types'
import { mockTimestampNow } from '@/mocks/utils'
import { MUTATION_ACTION } from '@/services/queryClient'

export const wishKeys = {
  all: (tripId: string, uid?: string) => ['wishes', tripId, uid ?? ''] as const,
}

export const wishOverlay = createListOverlay<Wish>({
  // WishPage runs rankWishes over the merged list, so placement here only
  // has to be stable, not sorted.
  insert: 'head',
  source: 'wishes',
})

export const useWishes = createRealtimeListHook<Wish>({
  queryKeyFactory: wishKeys.all,
  initialFetch:    (tripId, uid) => getWishesByTrip(tripId, uid),
  subscribe:       (tripId, uid, onData, onError) => subscribeToWishes(tripId, uid, onData, onError),
  source:          'useWishes',
  requiresUid:     true,
  overlay:         wishOverlay,
})

const serverRead = (tripId: string, uid: string | undefined) =>
  () => getWishesByTripFromServer(tripId, uid ?? '')

/** Wish create / update 各有兩條執行路徑：純文字走 client Firestore SDK，
 *  帶圖片走 Worker。離線策略不同（SDK 寫入要 `networkMode: 'always'` 才會
 *  進 IndexedDB 佇列；Worker 的 fetch 離線即失敗，排隊無意義），而 TanStack
 *  的 networkMode 綁在 mutation 上，所以每個 hook 其實是兩個 mutation ——
 *  同一份 overlay op、同一個 action，只差 networkMode —— 由變數決定走哪一個。
 *  對呼叫端仍是單一 `{ mutate, mutateAsync, isPending }`。 */
type WishMutation<Vars> = Pick<
  ReturnType<typeof useTripListMutation<Wish, Vars>>,
  'mutate' | 'mutateAsync' | 'isPending'
>

function usePathSplitMutation<Vars>(
  opts:        Omit<UseTripListMutationOpts<Wish, Vars>, 'networkMode'>,
  goesToWorker: (vars: Vars) => boolean,
): WishMutation<Vars> {
  const clientWrite = useTripListMutation<Wish, Vars>({ ...opts, networkMode: 'always' })
  const workerWrite = useTripListMutation<Wish, Vars>(opts)
  const pick = (vars: Vars | undefined) =>
    (vars !== undefined && goesToWorker(vars) ? workerWrite : clientWrite)
  return {
    mutate:      (...args) => pick(args[0]).mutate(...args),
    mutateAsync: (...args) => pick(args[0]).mutateAsync(...args),
    isPending:   clientWrite.isPending || workerWrite.isPending,
  }
}

export function useCreateWish(tripId: string) {
  return usePathSplitMutation<{
    wishId:     string
    input:      CreateWishInput
    file:       File | null
    proposedBy: string
  }>({
    tripId,
    keyFactory: wishKeys.all,
    mutate:     ({ wishId, input, file, proposedBy }) => createWish(tripId, input, file, proposedBy, wishId),
    overlay: {
      controller: wishOverlay,
      op: ({ wishId, input, proposedBy }, { uid }) => ({
        kind: 'create',
        // createdAt is mockTimestampNow(), not the epoch, so rankWishes
        // puts the row at the head of its vote group — the same place the
        // server row will land, so it doesn't jump on confirmation.
        row: {
          id: wishId, tripId, memberIds: [proposedBy], ...input,
          proposedBy, votes: [proposedBy], createdAt: mockTimestampNow(),
          ...auditUpdateMock(proposedBy),
        } as Wish,
        confirms: base => base.some(w => w.id === wishId),
        authoritativeFetch: serverRead(tripId, uid),
      }),
    },
    action:     MUTATION_ACTION.CREATE_WISH,
    // Phase 3.7: no partial-create recovery needed. Worker-authoritative
    // /wish-file-create is atomic — either the wish doc lands (with
    // image) or nothing lands, so the realtime listener never observes a
    // half-state row and dropping the overlay operation is the whole
    // cleanup. The text-only setDoc path is a single atomic Firestore
    // write, same guarantee.
  }, ({ file }) => file instanceof File)
}

export function useUpdateWish(tripId: string) {
  return usePathSplitMutation<{
    wishId:        string
    updates:       Partial<CreateWishInput>
    uid:           string
    attachment:    File | null | undefined
    existingImage: WishImage | undefined
  }>({
    tripId,
    keyFactory:  wishKeys.all,
    mutate:      ({ wishId, updates, uid, attachment, existingImage }) =>
      updateWish(tripId, wishId, updates, { uid, attachment, existingImage }),
    overlay: {
      controller: wishOverlay,
      op: ({ wishId, updates }, { uid }) => ({
        kind: 'patch',
        id:   wishId,
        apply: row => ({ ...row, ...updates }),
        confirms: base => {
          const stored = base.find(w => w.id === wishId)
          return !!stored && wishUpdateApplied(stored, updates)
        },
        authoritativeFetch: serverRead(tripId, uid),
      }),
    },
    action:      MUTATION_ACTION.UPDATE,
  // 帶新圖片才走 Worker；detach（null）與純文字（undefined）都是 client updateDoc。
  // 非圖片 File 在 service 內退回 client 路徑，但這裡仍視為 Worker（維持
  // 'online'）：表單 UI 不會送出非圖片檔，不值得為它多一次 compressImage。
  }, ({ attachment }) => attachment instanceof File)
}

export function useDeleteWish(tripId: string) {
  return useTripListMutation<Wish, { wishId: string }>({
    tripId,
    keyFactory: wishKeys.all,
    mutate:     ({ wishId }, { uid }) => deleteWish(tripId, wishId, uid),
    overlay: {
      controller: wishOverlay,
      op: ({ wishId }, { uid }) => ({
        kind: 'remove',
        id:   wishId,
        confirms: base => !base.some(w => w.id === wishId),
        authoritativeFetch: serverRead(tripId, uid),
      }),
    },
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
    overlay: {
      controller: wishOverlay,
      op: ({ wishId, uid, isVoting }) => ({
        kind: 'patch',
        id:   wishId,
        // A reducer over the arriving base, not a snapshot of `votes`:
        // the service uses arrayUnion/arrayRemove for exactly this reason,
        // so a co-member's vote landing mid-flight must survive here too.
        // WishPage re-ranks the merged list, so no sorting is needed.
        apply: row => ({
          ...row,
          votes: isVoting
            ? row.votes.includes(uid) ? row.votes : [...row.votes, uid]
            : row.votes.filter(u => u !== uid),
        }),
        confirms: base => {
          const stored = base.find(w => w.id === wishId)
          return !!stored && stored.votes.includes(uid) === isVoting
        },
        authoritativeFetch: serverRead(tripId, uid),
      }),
    },
    action:     MUTATION_ACTION.TOGGLE_VOTE,
    // 投票是純 client SDK 寫入；create / update 可能走 Worker、delete 走 Worker，維持預設。
    networkMode: 'always',
  })
}
