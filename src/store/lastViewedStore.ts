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
  /**
   * The uid these watermarks belong to; `null` before any account claims
   * them. Load-bearing because two accounts can be members of the SAME
   * trip: inherited watermarks would suppress the new user's badges for
   * activity they have never seen, which reads as "no updates" rather than
   * as a bug.
   */
  ownerUid: string | null
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
  /** Bind these watermarks to `uid`, discarding them first when they
   *  belonged to somebody else. Idempotent for the same uid. */
  claimForOwner: (uid: string) => void
}

export const useLastViewedStore = create<LastViewedStore>()(
  persist(
    (set, get) => ({
      viewed: {},
      ownerUid: null,
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
      claimForOwner: (uid) => {
        // Bail before set() — see tripStore.claimForOwner: persist writes on
        // every set, dirty or not.
        if (get().ownerUid === uid) return
        set((s) => {
          // Unowned is claimed as-is; only another account's watermarks are
          // discarded.
          if (s.ownerUid === null) return { ownerUid: uid }
          return { viewed: {}, ownerUid: uid }
        })
      },
    }),
    {
      name: 'tripmate-last-viewed',
      // Schema version — bump + add a `migrate` handler when the `viewed`
      // shape changes (e.g. adding a new BadgeFeature key, switching to a
      // nested per-feature object). Without a version, an old shape would
      // hydrate into the new typed slot and silently break badge math.
      //
      // v2 added `ownerUid`; a blob predating it has unknown provenance and
      // is discarded rather than claimed by whoever signs in next. The cost
      // is one round of unread dots, which clears as the user visits tabs —
      // far cheaper than silently hiding a co-member's updates.
      version: 2,
      migrate: () => ({ viewed: {}, ownerUid: null }),
      partialize: (s) => ({ viewed: s.viewed, ownerUid: s.ownerUid }),
    },
  ),
)
