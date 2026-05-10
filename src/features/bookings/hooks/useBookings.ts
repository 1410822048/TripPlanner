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
import { tempId } from '@/utils/tempId'
import { patchListCache, rollbackListCache } from '@/utils/queryCache'
import type { Booking, CreateBookingInput } from '@/types'
import { MOCK_TIMESTAMP } from '@/mocks/utils'
import { toast } from '@/shared/toast'

export const bookingKeys = {
  all:       (tripId: string) => ['bookings', tripId] as const,
  myHotels:  (uid: string)    => ['bookings', 'my-hotels', uid] as const,
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
  subscribe:       subscribeToMyHotelBookings,
  source:          'useMyHotelBookings',
})

export const useBookings = createRealtimeListHook<Booking>({
  queryKeyFactory: bookingKeys.all,
  initialFetch:    getBookingsByTrip,
  subscribe:       subscribeToBookings,
  source:          'useBookings',
})

export function useCreateBooking(tripId: string) {
  const qc = useQueryClient()
  const key = bookingKeys.all(tripId)
  return useMutation({
    mutationFn: ({ input, file }: { input: CreateBookingInput; file: File | null }) =>
      createBooking(tripId, input, file),
    onMutate: ({ input }) =>
      patchListCache<Booking>(qc, key, prev => [
        { id: tempId(), tripId, createdAt: MOCK_TIMESTAMP, ...input },
        ...prev,
      ]),
    onError: (err, _vars, ctx) => {
      rollbackListCache<Booking>(qc, key, ctx)
      toast.mutationError(err, '予約の追加')
    },
  })
}

export function useUpdateBooking(tripId: string) {
  const qc = useQueryClient()
  const key = bookingKeys.all(tripId)
  return useMutation({
    mutationFn: ({
      bookingId, updates, attachment, existing,
    }: {
      bookingId:  string
      updates:    Partial<CreateBookingInput>
      attachment: File | null | undefined
      existing:   { filePath?: string; thumbPath?: string }
    }) => updateBooking(tripId, bookingId, updates, attachment, existing),
    onMutate: ({ bookingId, updates }) =>
      patchListCache<Booking>(qc, key, prev =>
        prev.map(b => b.id === bookingId ? { ...b, ...updates } : b),
      ),
    onError: (err, _vars, ctx) => {
      rollbackListCache<Booking>(qc, key, ctx)
      toast.mutationError(err, '更新')
    },
  })
}

export function useDeleteBooking(tripId: string) {
  const qc = useQueryClient()
  const key = bookingKeys.all(tripId)
  return useMutation({
    mutationFn: ({ bookingId, paths }: {
      bookingId: string
      paths:     { filePath?: string; thumbPath?: string }
    }) => deleteBooking(tripId, bookingId, paths),
    onMutate: ({ bookingId }) =>
      patchListCache<Booking>(qc, key, prev => prev.filter(b => b.id !== bookingId)),
    onError: (err, _vars, ctx) => {
      rollbackListCache<Booking>(qc, key, ctx)
      toast.mutationError(err, '削除')
    },
  })
}
