// src/features/trips/hooks/useTripRole.ts
// Resolves the signed-in user's role within a given trip — owner /
// editor / viewer — for UI gating purposes. Pages use this to hide
// affordances that would 403 at the rules layer (add buttons,
// delete buttons, settings menus on collections gated by canWrite).
//
// firestore.rules already enforces these gates server-side, so this
// hook is purely a UX courtesy: pre-empting a "更新失敗" toast that
// would result from a viewer tapping a button they shouldn't see.
//
// What collections need gating (from firestore.rules audit):
//   - schedules / bookings / expenses → canWrite (owner/editor only)
//   - wishes / planning → isMember (any role; viewer can write)
//   - members (delete/role) → isTripOwner (only owner)
//
// Pages calling this hook should keep the gating list aligned with
// the rules — if the rules ever loosen 'wishes' from isMember to
// public, the UI here can stay; if they tighten 'schedules' to a new
// role, the page's gate has to follow.
import type { Member } from '@/types'
import { useUid } from '@/hooks/useAuth'
import { useMembers } from '@/features/members/hooks/useMembers'
import { useTripStore } from '@/store/tripStore'

export type TripRole = Member['role']

/**
 * Returns the caller's role on `tripId`, or null when the answer
 * isn't yet knowable (auth resolving / members list still loading /
 * caller not in the member roster). Pages treating null as
 * "no permission" avoids a flash of writer-only UI before the
 * roster loads.
 */
export function useTripRole(tripId: string | undefined): TripRole | null {
  const uid = useUid()
  const { data: members } = useMembers(tripId)
  if (!uid || !members) return null
  return members.find(m => m.userId === uid)?.role ?? null
}

/**
 * True when the caller can write to canWrite-gated subcollections
 * (schedules / bookings / expenses).
 *
 * Demo mode ignores the role machinery — there's no real ownership
 * concept, every user "owns" their preview trip; treating viewers
 * specially there would just confuse the preview.
 *
 * Cloud + role unknown → false (conservative default; the actual UI
 * shows nothing rather than flashing writer-only buttons that
 * disappear once the role resolves).
 */
export function useCanWrite(tripId: string | undefined, isDemo: boolean): boolean {
  const role = useTripRole(tripId)
  if (isDemo) return true
  return role === 'owner' || role === 'editor'
}

/**
 * True when the caller owns the trip (mirrors `isTripOwner` in
 * firestore.rules). Used to gate owner-only UI affordances —
 * invite-link generation, trip metadata edit, member role changes.
 *
 * Reads `currentTrip.ownerId` from the trip store rather than the
 * members subcollection so it doesn't pay the second cache lookup
 * the role-based gates need. Demo mode short-circuits to true (no
 * real ownership concept).
 */
export function useIsTripOwner(tripId: string | undefined, isDemo: boolean): boolean {
  const uid = useUid()
  const currentTrip = useTripStore(s => s.currentTrip)
  if (isDemo) return true
  if (!uid || !tripId || !currentTrip || currentTrip.id !== tripId) return false
  return currentTrip.ownerId === uid
}
