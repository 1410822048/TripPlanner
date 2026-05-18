// src/features/bookings/hooks/useBookings.ts
// useBookings is realtime-backed via createRealtimeListHook — initial
// getDocs populates the cache, then a Firestore onSnapshot listener
// pushes co-member edits live (someone else adding a hotel booking
// shows up immediately, no manual refresh).
//
// Mutations stay optimistic for instant local feedback; the listener
// reconciles temp-id rows once the server-confirmed write lands. Roll
// back is unchanged on failure.
//
// Attachment uploads are awaited inside the mutationFn — the optimistic
// patch can't render the URL anyway (the file is local), so we keep the
// optimistic row attachment-less and let the snapshot listener surface
// the final URL once the server-side write resolves.
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getBookingsByTrip,
  getMyHotelBookings,
  subscribeToBookings,
  subscribeToMyHotelBookings,
  createBooking,
  updateBooking,
  deleteBooking,
} from '../services/bookingService'
import { createRealtimeListHook } from '@/hooks/createRealtimeListHook'
import { useUid } from '@/hooks/useAuth'
import { tempId } from '@/utils/tempId'
import { patchListCache, rollbackListCache } from '@/utils/queryCache'
import { auditCreateMock, auditUpdateMock } from '@/utils/audit'
import type { Booking, CreateBookingInput } from '@/types'
import type { MutationMeta, MutationOptions } from '@/services/queryClient'

export const bookingKeys = {
  all:       (tripId: string, uid?: string) => ['bookings', tripId, uid ?? ''] as const,
  myHotels:  (uid: string)                  => ['bookings', 'my-hotels', uid] as const,
}

/**
 * Cross-trip hotel-booking history for the signed-in user — backs
 * PastLodgingPage. Uses a collection-group query with a server-side
 * filter (`memberIds array-contains uid && type == 'hotel'`) so it
 * resolves in O(1) Firestore round-trips regardless of trip count.
 *
 * Realtime: a new hotel booking on any trip you're a member of pushes
 * here automatically.
 */
export const useMyHotelBookings = createRealtimeListHook<Booking>({
  queryKeyFactory: bookingKeys.myHotels,
  initialFetch:    getMyHotelBookings,
  subscribe:       (uid, _uid2, onData, onError) => subscribeToMyHotelBookings(uid, onData, onError),
  source:          'useMyHotelBookings',
})

export const useBookings = createRealtimeListHook<Booking>({
  queryKeyFactory: bookingKeys.all,
  initialFetch:    (tripId, uid) => getBookingsByTrip(tripId, uid!),
  subscribe:       (tripId, uid, onData, onError) => subscribeToBookings(tripId, uid!, onData, onError),
  source:          'useBookings',
  requiresUid:     true,
})

export function useCreateBooking(tripId: string, options?: MutationOptions) {
  const qc = useQueryClient()
  const uid = useUid()
  const key = bookingKeys.all(tripId, uid)
  return useMutation({
    mutationFn: ({ input, file, createdBy }: { input: CreateBookingInput; file: File | null; createdBy: string }) =>
      createBooking(tripId, input, file, createdBy),
    meta: { action: '予約の追加', silent: options?.silent } satisfies MutationMeta,
    onMutate: ({ input, createdBy }) =>
      patchListCache<Booking>(qc, key, prev => [
        { id: tempId(), tripId, memberIds: [createdBy], ...auditCreateMock(createdBy), ...input },
        ...prev,
      ]),
    onError: (_err, _vars, ctx) => {
      rollbackListCache<Booking>(qc, key, ctx)
    },
  })
}

export function useUpdateBooking(tripId: string, options?: MutationOptions) {
  const qc = useQueryClient()
  const uid = useUid()
  const key = bookingKeys.all(tripId, uid)
  return useMutation({
    mutationFn: ({
      bookingId, updates, uid, attachment, existing,
    }: {
      bookingId:  string
      updates:    Partial<CreateBookingInput>
      uid:        string
      attachment: File | null | undefined
      existing:   { filePath?: string; thumbPath?: string }
    }) => updateBooking(tripId, bookingId, updates, { uid, attachment, existing }),
    meta: { action: '更新', silent: options?.silent } satisfies MutationMeta,
    onMutate: ({ bookingId, updates, uid }) =>
      patchListCache<Booking>(qc, key, prev =>
        prev.map(b => b.id === bookingId ? { ...b, ...updates, ...auditUpdateMock(uid) } : b),
      ),
    onError: (_err, _vars, ctx) => {
      rollbackListCache<Booking>(qc, key, ctx)
    },
  })
}

export function useDeleteBooking(tripId: string) {
  const qc = useQueryClient()
  const uid = useUid()
  const key = bookingKeys.all(tripId, uid)
  return useMutation({
    mutationFn: ({ bookingId, paths }: {
      bookingId: string
      paths:     { filePath?: string; thumbPath?: string }
    }) => deleteBooking(tripId, bookingId, uid!, paths),
    meta: { action: '削除' } satisfies MutationMeta,
    onMutate: ({ bookingId }) =>
      patchListCache<Booking>(qc, key, prev => prev.filter(b => b.id !== bookingId)),
    onError: (_err, _vars, ctx) => {
      rollbackListCache<Booking>(qc, key, ctx)
    },
  })
}
