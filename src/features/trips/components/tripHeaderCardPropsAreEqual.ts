// src/features/trips/components/tripHeaderCardPropsAreEqual.ts
// Memo comparator for TripHeaderCard, in its own module so the component
// file can stay pure-component-exports (Fast Refresh requirement).
//
// Returns true when re-render can be skipped. Ignores the inline callback
// props (onEditTrip, onInvite — fresh identity every parent render);
// checks the data props that actually drive output. `selectedTrip`
// identity comes from a stable upstream (Zustand store / TanStack Query
// cache + page-level useMemo), so unchanged trips have stable references
// — a referential equality check is correct here.
//
// Pinned by `TripHeaderCard.test.ts` so a future tweak (e.g. adding a
// new prop) that drops the memo's effectiveness fails the build.
import type { TripItem } from '@/features/trips/types'

export interface TripHeaderCardProps {
  selectedTrip:  TripItem
  tripDays:      number
  scheduleCount: number
  tripTotal:     number
  onEditTrip:    () => void
  onInvite:      () => void
}

export function tripHeaderCardPropsAreEqual(
  prev: TripHeaderCardProps,
  next: TripHeaderCardProps,
): boolean {
  return (
    prev.selectedTrip === next.selectedTrip
    && prev.tripDays === next.tripDays
    && prev.scheduleCount === next.scheduleCount
    && prev.tripTotal === next.tripTotal
  )
}
