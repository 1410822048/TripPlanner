// src/features/bookings/hooks/usePrefetchBookings.ts
// Layout-level subscriber that warms the bookings cache. Reads
// `selectedTripId` (persisted to localStorage) rather than
// `currentTrip?.id` so the query can fire on cold load BEFORE
// useCurrentTripSync hydrates the full Trip object — collapses the
// gap between "header rendered" and "list arrived" on /bookings hard
// reload. TanStack Query dedupes against BookingsPage's own useBookings
// call, so the list resolves from cache instantly.
//
// We could also prefetch expenses / schedules here, but those weren't
// flagged as feeling slow. Hold off until a profiler-or-user signal
// says it's worth the extra request.
import { useTripStore } from '@/store/tripStore'
import { useBookings } from './useBookings'

export function usePrefetchBookings(): void {
  const tripId = useTripStore(s => s.selectedTripId ?? s.currentTrip?.id)
  // useQuery with the same key as BookingsPage → automatic deduplication.
  // We don't read `data` here; this is a cache-warming subscription only.
  useBookings(tripId ?? undefined)
}
