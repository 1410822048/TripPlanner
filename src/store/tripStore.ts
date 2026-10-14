// src/store/tripStore.ts
// Persisted trip-selection state — selectedTripId is the source of
// truth for "which trip is the user currently viewing?". The full Trip
// object is derived via `useCurrentTrip()` from the React Query cache,
// so we don't duplicate it here (Timestamps wouldn't survive JSON
// anyway). See features/trips/hooks/useCurrentTrip.ts.
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface TripStore {
  // ─── State ─────────────────────────────────────────────────────
  /**
   * Last selected trip id, persisted to localStorage. The active
   * `Trip` object comes from `useCurrentTrip()` (= myTrips.find(id)).
   * Persisting only the id keeps the store JSON-safe and avoids a
   * parallel notification path that used to cause one-frame UI
   * flashes after create / copy.
   */
  selectedTripId: string | null
  /**
   * Unix-ms timestamp of the last `setSelectedTripId` call; persisted
   * so the freshness signal survives full reloads. Read by
   * useCurrentTripSync to gate its reselect grace window: a recent
   * change (e.g. acceptInvite just navigated) is honoured for a few
   * seconds while the realtime listener catches up, while a stale id
   * (kicked, then reload) reselects immediately.
   * `0` means "never set" — used as default for old persisted state
   * that pre-dates this field.
   */
  selectedTripAt: number
  /**
   * Most-recent-first id list (cap 5). Used as a fallback ordering for
   * useCurrentTripSync when the selected id leaves the trip list.
   */
  recentTripIds: string[]
  /**
   * User-defined trip order (drag-to-reorder in TripSwitcher). Stored
   * here rather than on the trip docs because it's a personal view
   * preference — different users have different orderings of the same
   * shared trip. Trips not in this list fall through to the default
   * sort (createdAt desc) at the top, so newly-joined trips don't
   * vanish under stale ordering.
   */
  tripOrder: string[]
  /**
   * The uid this persisted state belongs to; `null` before any account has
   * claimed it. Everything above is a PER-ACCOUNT preference — which trip
   * you were on, your personal ordering — so it must not survive an account
   * switch on a shared device. localStorage outlives sign-out, Firestore
   * wipes and PWA updates alike, so this stamp is the only thing that can
   * tell "resuming" from "someone else's leftovers".
   */
  ownerUid: string | null

  // ─── Actions ───────────────────────────────────────────────────
  /** Pick a trip as active. Also promotes the id into recentTripIds[0]. */
  setSelectedTripId: (id: string | null) => void
  /** Clear selection (sign-out). */
  clearTrip:         () => void
  setTripOrder:      (ids: string[]) => void
  /** Bind this state to `uid`, atomically discarding it first when it
   *  belonged to somebody else. Idempotent for the same uid, so it is safe
   *  to call on every auth-state fire. */
  claimForOwner:     (uid: string) => void
}

/** Account-scoped slice, reset wholesale on an owner change. Rebuilt per
 *  call so no caller can mutate a shared literal into the next reset. */
function emptyAccountState() {
  return {
    selectedTripId: null,
    selectedTripAt: 0,
    recentTripIds:  [] as string[],
    tripOrder:      [] as string[],
  }
}

export const useTripStore = create<TripStore>()(
  persist(
    (set, get) => ({
      ...emptyAccountState(),
      ownerUid: null,

      setSelectedTripId: (id) =>
        set((s) => ({
          selectedTripId: id,
          selectedTripAt: id ? Date.now() : 0,
          recentTripIds:  id
            ? [id, ...s.recentTripIds.filter((x) => x !== id)].slice(0, 5)
            : s.recentTripIds,
        })),

      clearTrip: () => set({ selectedTripId: null, selectedTripAt: 0 }),

      setTripOrder: (ids) => set({ tripOrder: ids }),

      // Sign-out deliberately does NOT reset (AccountPage only calls
      // clearTrip() to drop the current SELECTION, which rules may deny
      // after sign-out; order / recents survive): keeping the state lets
      // the same person resume where they left off. The discard happens here,
      // when a DIFFERENT uid resolves — which also covers the two paths a
      // sign-out hook cannot see, a cold start under another account and an
      // A→B switch with no signed-out moment in between.
      claimForOwner: (uid) => {
        // Bail BEFORE set(): persist has no dirty check — it runs
        // `set(...args); return setItem()`, so even a reducer returning the
        // same state still writes localStorage. reconcileAccountScope runs
        // on every auth resolution, so `set(s => s)` would be a write (and a
        // chance to throw) on each one.
        if (get().ownerUid === uid) return
        set((s) => {
          // Unowned (null) is claimed WITHOUT discarding: there is no other
          // account to protect against. Only state stamped with a different
          // uid gets wiped. Blobs of unknown provenance never reach here —
          // `migrate` discards any blob from another version.
          if (s.ownerUid === null) return { ownerUid: uid }
          return { ...emptyAccountState(), ownerUid: uid }
        })
      },
    }),
    {
      name: 'tripmate-trip-store',
      // Schema version — bump when the persisted shape changes. A blob
      // from any other version is discarded, never merged: merging would
      // let whoever signs in next claim state of unknown provenance (the
      // leak `ownerUid` exists to stop). Cheap, since selection and
      // ordering rebuild themselves in one session.
      version: 2,
      migrate: () => ({ ...emptyAccountState(), ownerUid: null }),
      partialize: (s) => ({
        selectedTripId: s.selectedTripId,
        selectedTripAt: s.selectedTripAt,
        recentTripIds:  s.recentTripIds,
        tripOrder:      s.tripOrder,
        ownerUid:       s.ownerUid,
      }),
    }
  )
)
