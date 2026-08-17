// Binds the persisted stores to the account that owns them.
//
// localStorage outlives sign-out, Firestore wipes and PWA updates, so
// per-account preferences (which trip you were on, your trip ordering, your
// badge watermarks) would otherwise be inherited by whoever signs in next on
// a shared device. Watermarks are the sharp edge: two accounts can be
// members of the SAME trip, so inherited ones suppress the new user's badges
// for activity they have never seen.
import { useTripStore }       from './tripStore'
import { useLastViewedStore } from './lastViewedStore'

/**
 * Reconcile every account-scoped store against the resolved uid.
 *
 * MUST be called on every auth-state resolution, including the initial
 * restore — that fire is the cold-start case, where the previous session's
 * state is already hydrated and the new account has never been compared
 * against it. Checking the uid itself (rather than watching for a
 * transition) also covers an A→B switch that never passes through a
 * signed-out state.
 *
 * A `null` uid deliberately does NOT reset: keeping the state through
 * sign-out is what lets the same person resume. The discard happens when a
 * DIFFERENT uid actually resolves.
 */
export function reconcileAccountScope(uid: string | null): void {
  if (!uid) return
  useTripStore.getState().claimForOwner(uid)
  useLastViewedStore.getState().claimForOwner(uid)
}
