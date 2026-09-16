// src/features/trips/hooks/useCurrentTripSync.ts
// Keeps `selectedTripId` (Zustand, persisted) pointing at a trip the
// user actually has access to. Runs at the layout level so a hard
// reload landing on any tab picks the user's last trip without
// forcing them through /schedule first.
//
// The full `Trip` object is no longer hydrated here — consumers read
// it via `useCurrentTrip()`, which derives from this id + the React
// Query trip cache. That single source removed the create / copy
// flash bugs that the previous dual-store had needed flushSync to
// paper over.
//
// Rehydration rules (evaluated in order):
//   1. Demo mode (no uid)               → no-op
//   1.5. selectedTripId freshly set     → grace skip (let the trips
//        listener catch up before snapping away or clearing). Solves
//        the invite-accept race: the Worker's admin SDK write isn't
//        visible to this client's onSnapshot until ~hundreds of ms
//        later, so a stale listener push briefly shrinks myTrips after
//        navigate even though useAcceptInvite.onSuccess seeded the new
//        id. Without this grace, rule 2 (empty-clear) or rule 4
//        (reselect) would snap selectedTripId back to null /
//        recents[0] — particularly bad for a brand-new user accepting
//        their FIRST trip via invite, whose myTrips is empty until the
//        listener fires.
//
//        Grace runs BEFORE the empty-clear branch so the first-invite
//        case doesn't get nulled out. Freshness signal lives in the
//        *persisted* tripStore field `selectedTripAt`, not in a
//        render-scoped ref: InvitePage's setSelectedTripId fires
//        while /invite is mounted, then navigates to /schedule which
//        mounts a *fresh* useCurrentTripSync — a ref initialised at
//        mount can't tell that case apart from "hard reload of a stale
//        persisted id" (the kicked-then-reload scenario, where we want
//        to reselect *immediately*, not grace). A persisted timestamp
//        distinguishes them cleanly.
//   2. myTrips empty                    → clear selectedTripId
//   3. selectedTripId still in list     → no-op (don't churn recents)
//   4. selectedTripId missing/null      → recents[0] in list ?? myTrips[0]
import { useEffect } from 'react'
import { useUid } from '@/hooks/useAuth'
import { useTripStore } from '@/store/tripStore'
import { useMyTrips } from './useTrips'

const SELECTION_GRACE_MS = 3000

export function useCurrentTripSync(): void {
  const uid = useUid()
  const { selectedTripId, selectedTripAt, recentTripIds, setSelectedTripId } = useTripStore()
  const { data: myTrips } = useMyTrips(uid)

  useEffect(() => {
    if (!uid || !myTrips) return
    // Selection still valid → no write (avoid recents churn on every
    // trip-doc cache push).
    if (selectedTripId && myTrips.some(t => t.id === selectedTripId)) return
    const reconcile = () => {
      if (myTrips.length === 0) {
        if (selectedTripId) setSelectedTripId(null)
        return
      }
      // Reselect priority: most-recent that's still accessible → newest.
      const tripIds = new Set(myTrips.map(t => t.id))
      const recent = recentTripIds.find(id => tripIds.has(id))
      setSelectedTripId(recent ?? myTrips[0]?.id ?? null)
    }
    const remaining = selectedTripId ? SELECTION_GRACE_MS - (Date.now() - selectedTripAt) : 0
    if (remaining <= 0) {
      reconcile()
      return
    }
    // Expiry must run even when no further snapshot arrives. A new list,
    // selection, account or unmount cancels this captured reconciliation.
    const timer = setTimeout(reconcile, remaining)
    return () => clearTimeout(timer)
  }, [uid, myTrips, selectedTripId, selectedTripAt, recentTripIds, setSelectedTripId])
}
