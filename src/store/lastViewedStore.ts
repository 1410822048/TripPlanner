// src/store/lastViewedStore.ts
// Per-(trip, feature) timestamp of when the user last looked at a tab,
// persisted to localStorage so badges survive PWA reload.
//
// Used together with useFeatureBadges + bottom nav: if any item in a
// feature's list has updatedAt > lastViewed, the tab shows a dot. The
// dot clears when the user opens the tab(AppLayout's route-change
// effect calls markViewed).
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type BadgeFeature = 'schedule' | 'expense' | 'bookings' | 'wish' | 'planning'

interface LastViewedStore {
  /** { [tripId]: { feature: epochMs } } — 0 / missing means never viewed. */
  viewed: Record<string, Partial<Record<BadgeFeature, number>>>
  /** Set lastViewed timestamp.
   *
   *  `ts` lets callers pass a server-aligned watermark(typically
   *  `max(item.updatedAt) + 1`)instead of `Date.now()`, so when a
   *  user creates an item on the same tab they're viewing, the new
   *  item's server timestamp doesn't out-rank lastViewed and trip
   *  a phantom "unread" badge after they navigate away.
   *
   *  Idempotent: a lower `ts` is a no-op(prevents accidental
   *  regression e.g. clock skew). */
  markViewed: (tripId: string, feature: BadgeFeature, ts?: number) => void
  /** Drop a trip's entry — called from useDeleteTrip onSuccess so
   *  localStorage doesn't accumulate stale entries indefinitely. */
  clearTrip: (tripId: string) => void
}

export const useLastViewedStore = create<LastViewedStore>()(
  persist(
    (set) => ({
      viewed: {},
      markViewed: (tripId, feature, ts) =>
        set((s) => {
          const next = ts ?? Date.now()
          const current = s.viewed[tripId]?.[feature] ?? 0
          if (next <= current) return s
          return {
            viewed: {
              ...s.viewed,
              [tripId]: { ...s.viewed[tripId], [feature]: next },
            },
          }
        }),
      clearTrip: (tripId) =>
        set((s) => {
          if (!(tripId in s.viewed)) return s
          const next = { ...s.viewed }
          delete next[tripId]
          return { viewed: next }
        }),
    }),
    {
      name: 'tripmate-last-viewed',
      partialize: (s) => ({ viewed: s.viewed }),
    },
  ),
)
