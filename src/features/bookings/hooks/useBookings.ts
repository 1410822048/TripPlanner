// src/features/bookings/hooks/useBookings.ts
// Realtime-backed via createRealtimeListHook — initial getDocs populates
// the cache, then a Firestore onSnapshot listener pushes co-member edits
// live (someone else adding a hotel booking shows up immediately, no
// manual refresh).
//
// Mutations stay optimistic for instant local feedback; the listener
// reconciles temp-id rows once the server-confirmed write lands.
//
// Attachment uploads are awaited inside the mutationFn — the optimistic
// patch can't render the URL anyway (file is local), so we keep the
// optimistic row attachment-less and let the snapshot listener surface
// the final URL once the server-side write resolves.
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
import { useTripListMutation } from '@/hooks/useTripListMutation'
import { tempId } from '@/utils/tempId'
import { auditCreateMock, auditUpdateMock } from '@/utils/audit'
import type { Booking, BookingAttachment, CreateBookingInput } from '@/types'
import { MUTATION_ACTION, type MutationOptions } from '@/services/queryClient'

export const bookingKeys = {
  all:       (tripId: string, uid?: string) => ['bookings', tripId, uid ?? ''] as const,
  myHotels:  (uid: string)                  => ['bookings', 'my-hotels', uid] as const,
}

/**
 * Cross-trip hotel-booking history — backs PastLodgingPage. One
 * collection-group query (gated on memberIds + type=='hotel') resolves
 * in O(1) Firestore round-trips regardless of trip count.
 */
export const useMyHotelBookings = createRealtimeListHook<Booking>({
  queryKeyFactory: bookingKeys.myHotels,
  initialFetch:    getMyHotelBookings,
  subscribe:       (uid, _uid2, onData, onError) => subscribeToMyHotelBookings(uid, onData, onError),
  source:          'useMyHotelBookings',
})

export const useBookings = createRealtimeListHook<Booking>({
  queryKeyFactory: bookingKeys.all,
  initialFetch:    (tripId, uid) => getBookingsByTrip(tripId, uid),
  subscribe:       (tripId, uid, onData, onError) => subscribeToBookings(tripId, uid, onData, onError),
  source:          'useBookings',
  requiresUid:     true,
})

export function useCreateBooking(tripId: string, options?: MutationOptions) {
  return useTripListMutation<Booking, { input: CreateBookingInput; file: File | null; createdBy: string }>({
    tripId,
    keyFactory: bookingKeys.all,
    mutate:     ({ input, file, createdBy }) => createBooking(tripId, input, file, createdBy),
    patch:      (prev, { input, createdBy }) => [
      { id: tempId(), tripId, memberIds: [createdBy], ...auditCreateMock(createdBy), ...input },
      ...prev,
    ],
    action:     MUTATION_ACTION.CREATE_BOOKING,
    silent:     options?.silent,
  })
}

export function useUpdateBooking(tripId: string, options?: MutationOptions) {
  return useTripListMutation<Booking, {
    bookingId:  string
    updates:    Partial<CreateBookingInput>
    uid:        string
    attachment: File | null | undefined
    existing:   BookingAttachment | undefined
  }>({
    tripId,
    keyFactory: bookingKeys.all,
    mutate:     ({ bookingId, updates, uid, attachment, existing }) =>
      updateBooking(tripId, bookingId, updates, { uid, attachment, existing }),
    patch:      (prev, { bookingId, updates, uid }) =>
      prev.map(b => b.id === bookingId ? { ...b, ...updates, ...auditUpdateMock(uid) } : b),
    action:     MUTATION_ACTION.UPDATE,
    silent:     options?.silent,
  })
}

export function useDeleteBooking(tripId: string) {
  return useTripListMutation<Booking, {
    bookingId:  string
    attachment: BookingAttachment | undefined
  }>({
    tripId,
    keyFactory: bookingKeys.all,
    mutate:     ({ bookingId, attachment }, { uid }) => deleteBooking(tripId, bookingId, uid, attachment),
    patch:      (prev, { bookingId }) => prev.filter(b => b.id !== bookingId),
    action:     MUTATION_ACTION.DELETE,
  })
}
