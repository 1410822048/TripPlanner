// src/services/paths.ts
// Single source of truth for Firestore collection + document path segments.
// Consolidating the string literals here makes a future collection rename
// (e.g. 'bookings' → 'reservations') one-file surgery instead of a global
// find-and-replace sweep. It also pairs the CASCADE_SUBCOLLECTIONS list in
// tripService with a typed tuple, so adding a new subcollection without
// updating the cascade becomes a TypeScript error rather than a silent
// orphan-doc bug.
//
// Functions return plain strings + arg arrays so callers can spread them
// into `doc(db, ...path)` or `collection(db, ...path)` freely. They
// deliberately don't import firebase types — this file stays bundle-neutral
// and can be imported anywhere without dragging firestore into the bundle.

// ─── Root collections ──────────────────────────────────────────
export const TRIPS = 'trips'

// ─── Trip-scoped subcollections ────────────────────────────────
// Order matters: listed in the order subcollections must be purged during
// cascade delete. `members` MUST be last because canWrite() rules on
// schedules/expenses/journals/bookings dereference members/{uid}, and
// deleting the owner's member doc mid-cascade would revoke write perm for
// the remaining steps. `invites` is rule-independent (gated by
// isTripOwner which reads the trip doc), so it's order-agnostic — placed
// just before `members` for symmetry with other content collections.
export const TRIP_SUBCOLLECTIONS = [
  'schedules',
  'expenses',
  'wishes',
  'bookings',
  'planning',
  'invites',
  'members',
] as const
export type TripSubcollection = typeof TRIP_SUBCOLLECTIONS[number]

// ─── Path builders ─────────────────────────────────────────────
// Each returns a tuple suitable for `doc(db, ...)` / `collection(db, ...)`.
// Example: `doc(db, ...P.tripMember('t1', 'u1'))` → the member doc path.

export const P = {
  // Root
  trips:     (): ['trips']                                    => [TRIPS],
  trip:      (tripId: string): ['trips', string]              => [TRIPS, tripId],

  // Subcollections of /trips/{tripId}
  subcollection: <K extends TripSubcollection>(tripId: string, name: K): ['trips', string, K] =>
    [TRIPS, tripId, name],

  members:     (tripId: string): ['trips', string, 'members']   => [TRIPS, tripId, 'members'],
  member:      (tripId: string, memberId: string): ['trips', string, 'members', string] =>
    [TRIPS, tripId, 'members', memberId],

  invites:     (tripId: string): ['trips', string, 'invites']   => [TRIPS, tripId, 'invites'],
  invite:      (tripId: string, token: string): ['trips', string, 'invites', string] =>
    [TRIPS, tripId, 'invites', token],

  schedules:   (tripId: string): ['trips', string, 'schedules'] => [TRIPS, tripId, 'schedules'],
  schedule:    (tripId: string, scheduleId: string): ['trips', string, 'schedules', string] =>
    [TRIPS, tripId, 'schedules', scheduleId],

  expenses:    (tripId: string): ['trips', string, 'expenses']  => [TRIPS, tripId, 'expenses'],
  expense:     (tripId: string, expenseId: string): ['trips', string, 'expenses', string] =>
    [TRIPS, tripId, 'expenses', expenseId],

  wishes:      (tripId: string): ['trips', string, 'wishes']    => [TRIPS, tripId, 'wishes'],
  wish:        (tripId: string, wishId: string): ['trips', string, 'wishes', string] =>
    [TRIPS, tripId, 'wishes', wishId],

  planning:    (tripId: string): ['trips', string, 'planning']  => [TRIPS, tripId, 'planning'],
  planItem:    (tripId: string, itemId: string): ['trips', string, 'planning', string] =>
    [TRIPS, tripId, 'planning', itemId],

  bookings:    (tripId: string): ['trips', string, 'bookings']  => [TRIPS, tripId, 'bookings'],
  booking:     (tripId: string, bookingId: string): ['trips', string, 'bookings', string] =>
    [TRIPS, tripId, 'bookings', bookingId],
} as const
