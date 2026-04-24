// src/store/tripStore.ts
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Trip } from '@/types'

interface TripStore {
  // ─── State ─────────────────────────────────────────────────────
  currentTrip: Trip | null
  recentTripIds: string[]

  // ─── Actions ───────────────────────────────────────────────────
  setCurrentTrip: (trip: Trip | null) => void
  addRecentTrip:  (tripId: string) => void
  clearTrip:      () => void
}

export const useTripStore = create<TripStore>()(
  persist(
    (set) => ({
      currentTrip:  null,
      recentTripIds: [],

      setCurrentTrip: (trip) =>
        set((s) => ({
          currentTrip: trip,
          recentTripIds: trip
            ? [trip.id, ...s.recentTripIds.filter((id) => id !== trip.id)].slice(0, 5)
            : s.recentTripIds,
        })),

      addRecentTrip: (tripId) =>
        set((s) => ({
          recentTripIds: [tripId, ...s.recentTripIds.filter((id) => id !== tripId)].slice(0, 5),
        })),

      clearTrip: () => set({ currentTrip: null }),
    }),
    {
      name: 'tripmate-trip-store',
      // Only persist the recent-ids list. The `currentTrip` object contains
      // Firestore Timestamp instances that don't round-trip through
      // JSON.stringify; SchedulePage rehydrates it from useMyTrips on load
      // using the first recentTripIds entry.
      partialize: (s) => ({ recentTripIds: s.recentTripIds }),
    }
  )
)
