// src/features/bookings/hooks/useBookings.ts
// Realtime-backed via createRealtimeListHook — initial getDocs populates
// the cache, then a Firestore onSnapshot listener pushes co-member edits
// live (someone else adding a hotel booking shows up immediately, no
// manual refresh).
//
// Optimistic state is a read-time overlay (see hooks/listOverlay.ts), so
// the cache stays server-shaped.
//
// Attachment uploads are awaited inside the mutationFn — the optimistic
// row can't render the URL anyway (the file is local), so it stays
// attachment-less and the snapshot listener surfaces the final URL once
// the server-side write resolves.
import {
  type BookingAttachmentChanges,
  type BookingExistingAttachments,
  bookingUpdateApplied,
  getBookingsByTrip,
  getBookingsByTripFromServer,
  getMyHotelBookings,
  subscribeToBookings,
  subscribeToMyHotelBookings,
  createBooking,
  updateBooking,
  deleteBooking,
} from '../services/bookingService'
import { createRealtimeListHook } from '@/hooks/createRealtimeListHook'
import { createListOverlay } from '@/hooks/listOverlay'
import { useTripListMutation } from '@/hooks/useTripListMutation'
import { auditCreateMock } from '@/utils/audit'
import type { Booking, CreateBookingInput } from '@/types'
import { MUTATION_ACTION } from '@/services/queryClient'

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

export const bookingOverlay = createListOverlay<Booking>({
  insert: 'head',
  source: 'bookings',
})

export const useBookings = createRealtimeListHook<Booking>({
  queryKeyFactory: bookingKeys.all,
  initialFetch:    (tripId, uid) => getBookingsByTrip(tripId, uid),
  subscribe:       (tripId, uid, onData, onError) => subscribeToBookings(tripId, uid, onData, onError),
  source:          'useBookings',
  requiresUid:     true,
  overlay:         bookingOverlay,
})

const serverRead = (tripId: string, uid: string | undefined) =>
  () => getBookingsByTripFromServer(tripId, uid ?? '')

export function useCreateBooking(tripId: string) {
  // Phase 3.7: the Worker writes doc + attachment atomically (or not at
  // all on rejection), so there is no partial-failure state to reconcile.
  return useTripListMutation<Booking, {
    bookingId: string
    input:     CreateBookingInput
    files:     BookingAttachmentChanges
    createdBy: string
  }>({
    tripId,
    keyFactory: bookingKeys.all,
    mutate:     ({ bookingId, input, files, createdBy }) =>
      createBooking(tripId, input, files, createdBy, bookingId),
    overlay: {
      controller: bookingOverlay,
      op: ({ bookingId, input, createdBy }, { uid }) => ({
        kind: 'create',
        row: {
          id: bookingId, tripId, memberIds: [createdBy],
          ...auditCreateMock(createdBy), ...input,
        } as Booking,
        confirms: base => base.some(b => b.id === bookingId),
        authoritativeFetch: serverRead(tripId, uid),
      }),
    },
    action:     MUTATION_ACTION.CREATE_BOOKING,
  })
}

export function useUpdateBooking(tripId: string) {
  return useTripListMutation<Booking, {
    bookingId:  string
    updates:    Partial<CreateBookingInput>
    uid:        string
    files:      BookingAttachmentChanges
    existing:   BookingExistingAttachments
  }>({
    tripId,
    keyFactory:  bookingKeys.all,
    mutate:      ({ bookingId, updates, uid, files, existing }) =>
      updateBooking(tripId, bookingId, updates, { uid, files, existing }),
    overlay: {
      controller: bookingOverlay,
      op: ({ bookingId, updates }, { uid }) => ({
        kind: 'patch',
        id:   bookingId,
        // No audit fields: unknowable client-side, so applying them would
        // leave the op permanently unconfirmable.
        apply: row => ({ ...row, ...updates }),
        confirms: base => {
          const stored = base.find(b => b.id === bookingId)
          return !!stored && bookingUpdateApplied(stored, updates)
        },
        authoritativeFetch: serverRead(tripId, uid),
      }),
    },
    action:      MUTATION_ACTION.UPDATE,
  })
}

export function useDeleteBooking(tripId: string) {
  return useTripListMutation<Booking, {
    bookingId:  string
    attachments: BookingExistingAttachments
  }>({
    tripId,
    keyFactory: bookingKeys.all,
    mutate:     ({ bookingId, attachments }, { uid }) => deleteBooking(tripId, bookingId, uid, attachments),
    overlay: {
      controller: bookingOverlay,
      op: ({ bookingId }, { uid }) => ({
        kind: 'remove',
        id:   bookingId,
        confirms: base => !base.some(b => b.id === bookingId),
        authoritativeFetch: serverRead(tripId, uid),
      }),
    },
    action:     MUTATION_ACTION.DELETE,
  })
}
