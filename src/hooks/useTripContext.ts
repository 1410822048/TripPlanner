// src/hooks/useTripContext.ts
// Single source of truth for "what trip is the page operating on right now?"
//
// Pages used to do this 5-hook handshake by hand:
//   useAuth → uid → useMyTrips → currentTrip → useSelectedDemoTrip → isDemo
// …and then branch on `isDemo` and `tripsPending` and `currentTrip` ad hoc.
// Sixty-plus call sites of `isDemo` accumulated across BookingsPage,
// ExpensePage, etc. Each was a place new features could forget the demo
// path. This hook collapses the handshake into one discriminated union.
//
// Status semantics:
//   loading        → auth still resolving, OR cloud user has trips but
//                    AppLayout's useCurrentTripSync hasn't pinned one yet.
//                    Pages should render a skeleton / spinner.
//   demo           → signed-out preview mode. `trip` is the demo trip; pages
//                    should still render the demo banner + sign-in CTA but
//                    can use `trip.id` / `trip.title` / `trip.members`.
//   no-trip        → signed-in but the user has zero trips. Pages should
//                    render a "create your first trip" CTA.
//   cloud          → signed-in with a selected real trip. `trip` is the
//                    Firestore Trip object (note: TripItem ≠ Trip — they
//                    differ on `dest`/`destination`, `emoji`/`icon`, and
//                    date types). SchedulePage has a private
//                    `cloudTripToItem` adapter for the conversion; if a
//                    second consumer ever needs the same shape, promote
//                    that adapter to a shared util before duplicating it.
//
// Why a discriminated union (not a flat object with optional fields)?
//   - The TS narrowing makes the demo / cloud branch unambiguous
//   - Forces callers to handle 'loading' and 'no-trip' explicitly — the
//     bug we fixed earlier ("hard reload on /bookings stuck on select-a-
//     trip") happened because pages collapsed the loading + empty cases
import type { Trip } from '@/types'
import type { TripItem } from '@/features/trips/types'
import { useAuth } from '@/hooks/useAuth'
import { useMyTrips } from '@/features/trips/hooks/useTrips'
import { useTripStore } from '@/store/tripStore'
import { useSelectedDemoTrip } from '@/store/demoTripStore'

export type TripContext =
  | { status: 'loading' }
  | { status: 'no-trip' }
  | { status: 'demo';  trip: TripItem }
  | { status: 'cloud'; trip: Trip }

export function useTripContext(): TripContext {
  const { state: authState } = useAuth(true)
  const uid = authState.status === 'signed-in' ? authState.user.uid : undefined

  // Both queries always run — TanStack dedupes against AppLayout's calls.
  const { data: myTrips, isPending: tripsPending } = useMyTrips(uid)
  const currentTrip = useTripStore(s => s.currentTrip)
  const demoTrip = useSelectedDemoTrip()

  if (authState.status === 'loading') return { status: 'loading' }
  if (authState.status === 'signed-out') return { status: 'demo', trip: demoTrip }

  // Signed-in branches:
  if (currentTrip) return { status: 'cloud', trip: currentTrip }

  // Cold-load window: auth resolved, currentTrip null. Two sub-cases:
  //   1. trips fetch in flight, or fetched but non-empty — wait for
  //      AppLayout's useCurrentTripSync to pin a trip.
  //   2. trips fetched and empty — guide the user to create one.
  if (tripsPending || (myTrips && myTrips.length > 0)) return { status: 'loading' }
  return { status: 'no-trip' }
}
