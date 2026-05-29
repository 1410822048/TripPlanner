// src/features/trips/components/tripHeaderCardPropsAreEqual.ts
// Type-only module for TripHeaderCard's prop shape. The eponymous
// propsAreEqual comparator that used to live here was removed when
// React Compiler took over memoisation duties — manual prop comparison
// is now redundant. File name retained to avoid a wider rename diff.
import type { TripItem } from '@/features/trips/types'

export interface TripHeaderCardProps {
  selectedTrip:  TripItem
  tripDays:      number
  scheduleCount: number
  /** Sum of schedule estimatedCostMinor in the active trip's currency
   *  (integer minor units). Rendered via formatMinorAmount. */
  tripTotal:     number
  /** Owner-only: controls visibility of the invite "+" button.
   *  firestore.rules gates /invites create on isTripOwner — non-owners
   *  who tap would 403, so we hide rather than show-then-fail. */
  canInvite:     boolean
  /** Owner-only: controls whether the title block is tappable and shows
   *  the Pencil affordance. firestore.rules gates trip update on
   *  isTripOwner; without this gate, editors / viewers could open
   *  EditTripModal and silently 403 on save. */
  canEdit:       boolean
  onEditTrip:    () => void
  onInvite:      () => void
}
