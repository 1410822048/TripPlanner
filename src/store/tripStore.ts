// src/store/tripStore.ts
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Trip } from '@/types'

interface TripStore {
  // ─── State ─────────────────────────────────────────────────────
  /** In-memory selected trip object. Hydrated from query cache by
   *  useCurrentTripSync — see also `selectedTripId` below for the
   *  persistent half. */
  currentTrip: Trip | null
  /**
   * Last selected trip id, persisted to localStorage. Used by AppLayout's
   * useCurrentTripSync as the preferred id to pin on cold load — falls
   * back to recentTripIds[0] when the persisted id is no longer in the
   * user's trip list.
   *
   * Why a separate id (not just persisting `currentTrip`)? The Trip
   * object contains Firestore Timestamp instances that don't round-trip
   * through JSON.stringify. Persisting only the id keeps the store
   * serialisation safe and lets us rehydrate the object from the
   * TanStack Query cache (the source of truth) on next load.
   */
  selectedTripId: string | null
  /**
   * Most-recent-first id list (cap 5). Used as a fallback ordering for
   * useCurrentTripSync when the selected id is missing.
   */
  recentTripIds: string[]

  // ─── Actions ───────────────────────────────────────────────────
  setCurrentTrip: (trip: Trip | null) => void
  addRecentTrip:  (tripId: string) => void
  clearTrip:      () => void
}

export const useTripStore = create<TripStore>()(
  persist(
    (set) => ({
      currentTrip:    null,
      selectedTripId: null,
      recentTripIds:  [],

      setCurrentTrip: (trip) =>
        set((s) => ({
          currentTrip:    trip,
          selectedTripId: trip?.id ?? null,
          recentTripIds:  trip
            ? [trip.id, ...s.recentTripIds.filter((id) => id !== trip.id)].slice(0, 5)
            : s.recentTripIds,
        })),

      addRecentTrip: (tripId) =>
        set((s) => ({
          recentTripIds: [tripId, ...s.recentTripIds.filter((id) => id !== tripId)].slice(0, 5),
        })),

      clearTrip: () => set({ currentTrip: null, selectedTripId: null }),
    }),
    {
      name: 'tripmate-trip-store',
      // Persist selectedTripId + recentTripIds. The Trip object itself
      // can't round-trip JSON (Timestamp instances) — we rehydrate it
      // from the TanStack Query cache via useCurrentTripSync on boot.
      partialize: (s) => ({
        selectedTripId: s.selectedTripId,
        recentTripIds:  s.recentTripIds,
      }),
    }
  )
)
