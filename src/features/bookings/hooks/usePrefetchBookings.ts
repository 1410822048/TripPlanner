// src/features/bookings/hooks/usePrefetchBookings.ts
// Layout-level cache warmer. Reads `selectedTripId` (persisted to
// localStorage) so the bookings query can populate on cold load —
// collapses the "header rendered but list still loading" gap when
// the user navigates to /bookings.
//
// One-shot prefetchQuery, NOT a live subscription. The previous
// implementation called useBookings() here, which opened a persistent
// onSnapshot listener for every app session — even for users who
// never visit /bookings. That listener wasted Firestore bandwidth
// (continuous WebChannel) for zero rendered output. Now:
//
//   - This hook: warms the cache via one HTTP request, no listener.
//   - BookingsPage mount: useBookings() finds cache hit → instant
//     paint, then opens its OWN listener (only while page mounted)
//     to receive co-member updates.
//
// Net: listener is open ONLY while user is on /bookings. Same first-
// paint speed; meaningfully lower steady-state bandwidth + reads.
//
// We don't `await` or surface errors here — a failed prefetch just
// means BookingsPage starts cold (same as if this hook didn't exist),
// not a user-visible regression.
import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTripStore } from '@/store/tripStore'
import { useUid } from '@/hooks/useAuth'
import { getBookingsByTrip } from '../services/bookingService'
import { bookingKeys } from './useBookings'

export function usePrefetchBookings(): void {
  const qc     = useQueryClient()
  const tripId = useTripStore(s => s.selectedTripId)
  const uid    = useUid()

  useEffect(() => {
    if (!tripId || !uid) return
    void qc.prefetchQuery({
      queryKey:  bookingKeys.all(tripId, uid),
      queryFn:   () => getBookingsByTrip(tripId, uid),
      // Mirrors createRealtimeListHook's staleTime so the cache the
      // page picks up isn't immediately refetched by useQuery before
      // the listener takes over reconciliation.
      staleTime: Infinity,
    })
  }, [qc, tripId, uid])
}
