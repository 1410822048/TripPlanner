// src/features/bookings/hooks/usePrefetchBookings.ts
// Layout-level cache warmer. Booking data is useful for the next tab, but it
// is not part of /schedule's LCP critical path. The warm-up therefore waits
// for a fixed grace period + browser idle time, then verifies the selected
// trip is present in the current user's authoritative trip cache.
//
// One-shot prefetchQuery, NOT a live subscription. The previous
// implementation called useBookings() here, which opened a persistent
// onSnapshot listener for every app session — even for users who
// never visit /bookings. That listener wasted Firestore bandwidth
// (continuous WebChannel) for zero rendered output. Now:
//
//   - This hook: warms the cache via one delayed HTTP request, no listener.
//   - BookingsPage mount: useBookings() finds cache hit → instant
//     paint, then opens its OWN listener (only while page mounted)
//     to receive co-member updates.
//
// Net: listener is open ONLY while user is on /bookings. Same first-
// paint speed; meaningfully lower steady-state bandwidth + reads.
//
// We don't `await` or surface errors here — a failed prefetch just
// means BookingsPage starts cold (same as if this hook didn't exist),
// not a user-visible regression.
import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTripStore } from '@/store/tripStore'
import { useUid } from '@/hooks/useAuth'
import { tripKeys } from '@/features/trips/queryKeys'
import { captureError } from '@/services/sentry'
import type { Trip } from '@/types'

const PREFETCH_DELAY_MS = 1500
const IDLE_TIMEOUT_MS = 3000

interface NetworkInformationLike {
  saveData?: boolean
  effectiveType?: string
  addEventListener?: (type: 'change', listener: () => void) => void
  removeEventListener?: (type: 'change', listener: () => void) => void
}

function networkInformation(): NetworkInformationLike | undefined {
  return (navigator as Navigator & { connection?: NetworkInformationLike }).connection
}

function shouldSkipBackgroundPrefetch(): boolean {
  if (document.visibilityState === 'hidden') return true
  const connection = networkInformation()
  return connection?.saveData === true
    || connection?.effectiveType === 'slow-2g'
    || connection?.effectiveType === '2g'
}

export function usePrefetchBookings(): void {
  const qc     = useQueryClient()
  const tripId = useTripStore(s => s.selectedTripId)
  const uid    = useUid()

  useEffect(() => {
    if (!tripId || !uid) return

    let cancelled = false
    let attempted = false
    let inFlight = false
    let scheduled = false
    let delayId: number | undefined
    let idleId: number | undefined
    // performance.now()(單調):effect 範圍內的延遲窗,時鐘回撥不該把
    // prefetch 往後推一整段回撥量
    const earliestStartAt = performance.now() + PREFETCH_DELAY_MS

    const isAuthorized = () => {
      const trips = qc.getQueryData<Trip[]>(tripKeys.mine(uid))
      return trips?.some(trip => trip.id === tripId) === true
    }

    const warm = async () => {
      scheduled = false
      idleId = undefined
      if (cancelled || attempted || inFlight || shouldSkipBackgroundPrefetch() || !isAuthorized()) return

      inFlight = true
      try {
        const [{ getBookingsByTrip }, { bookingKeys }] = await Promise.all([
          import('../services/bookingService'),
          import('./useBookings'),
        ])
        // Membership may change while the lazy chunks are loading. Recheck the
        // authoritative cache immediately before issuing the Firestore read.
        if (cancelled || shouldSkipBackgroundPrefetch() || !isAuthorized()) return
        attempted = true
        await qc.prefetchQuery({
          queryKey: bookingKeys.all(tripId, uid),
          queryFn: () => getBookingsByTrip(tripId, uid),
          // Mirrors createRealtimeListHook's staleTime so the cache the page
          // picks up is not immediately refetched before its listener takes over.
          staleTime: Infinity,
        })
      } finally {
        inFlight = false
      }
    }

    const runWarm = () => {
      void warm().catch(error => captureError(error, { source: 'usePrefetchBookings' }))
    }

    const schedule = () => {
      if (cancelled || attempted || inFlight || scheduled
        || shouldSkipBackgroundPrefetch() || !isAuthorized()) return

      scheduled = true
      delayId = window.setTimeout(() => {
        delayId = undefined
        if (cancelled) return
        if (shouldSkipBackgroundPrefetch() || !isAuthorized()) {
          scheduled = false
          return
        }
        if ('requestIdleCallback' in window) {
          idleId = window.requestIdleCallback(runWarm, { timeout: IDLE_TIMEOUT_MS })
        } else {
          runWarm()
        }
      }, Math.max(0, earliestStartAt - performance.now()))
    }

    // QueryCache notification is only an in-memory wake-up signal; it does not
    // open another Firestore listener. This lets a late membership publish arm
    // the one-shot prefetch without polling or a stale authorization TTL.
    const unsubscribeQueryCache = qc.getQueryCache().subscribe(schedule)
    const connection = networkInformation()
    document.addEventListener('visibilitychange', schedule)
    connection?.addEventListener?.('change', schedule)
    schedule()

    return () => {
      cancelled = true
      unsubscribeQueryCache()
      document.removeEventListener('visibilitychange', schedule)
      connection?.removeEventListener?.('change', schedule)
      if (delayId !== undefined) window.clearTimeout(delayId)
      if (idleId !== undefined) window.cancelIdleCallback(idleId)
    }
  }, [qc, tripId, uid])
}
