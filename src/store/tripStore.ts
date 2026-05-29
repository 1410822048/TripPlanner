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

  // ─── Actions ───────────────────────────────────────────────────
  /** Pick a trip as active. Also promotes the id into recentTripIds[0]. */
  setSelectedTripId: (id: string | null) => void
  /** Clear selection (sign-out). */
  clearTrip:         () => void
  setTripOrder:      (ids: string[]) => void
}

export const useTripStore = create<TripStore>()(
  persist(
    (set) => ({
      selectedTripId: null,
      selectedTripAt: 0,
      recentTripIds:  [],
      tripOrder:      [],

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
    }),
    {
      name: 'tripmate-trip-store',
      // Schema version — bump when the persisted shape changes (rename /
      // remove a field, switch a string id to a branded type, etc.) and
      // add a `migrate(persistedState, fromVersion)` handler here. Without
      // a version, future schema drifts hydrate stale data silently and
      // can corrupt the rehydration logic in useCurrentTripSync.
      //
      // `selectedTripAt` was added without a version bump because Zustand
      // persist's merge falls the missing field back to the initial
      // state (`0`), which behaves as "stale" — the desired safe default
      // for any pre-existing persisted blob.
      version: 1,
      partialize: (s) => ({
        selectedTripId: s.selectedTripId,
        selectedTripAt: s.selectedTripAt,
        recentTripIds:  s.recentTripIds,
        tripOrder:      s.tripOrder,
      }),
    }
  )
)
