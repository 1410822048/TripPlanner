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
import { captureError }       from '@/services/sentry'

/** Run one store's claim in isolation.
 *
 *  zustand's persist writes localStorage on every `set` and does not catch
 *  the result, so a quota / SecurityError (Safari private mode, a full
 *  disk) propagates straight out. Unhandled it would abort the auth
 *  observer before it publishes the signed-in state, stranding the app on
 *  the loading splash — a full outage caused by a full disk. Per-store so a
 *  failure in the first cannot skip the second.
 *
 *  The in-memory reset has already applied when persist throws (it runs
 *  `set(...)` first), so account isolation still holds for this session;
 *  only its persistence is lost, and the next successful write restores it. */
function safeClaim(store: string, claim: () => void): void {
  try {
    claim()
  } catch (error) {
    captureError(error, { source: `account-scope:${store}` })
  }
}

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
  safeClaim('trip', () => useTripStore.getState().claimForOwner(uid))
  safeClaim('last-viewed', () => useLastViewedStore.getState().claimForOwner(uid))
}
