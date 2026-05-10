// src/hooks/createRealtimeListHook.ts
// Factory for "list of T scoped to a stable string key" hooks backed by:
//
//   1. an initial getDocs (via useQuery — populates the cache and hands
//      callers a Result with status / error / refetch APIs they're used
//      to from every other list hook), and
//   2. a Firestore onSnapshot listener that pipes pushed updates into
//      the same cache via setQueryData.
//
// The "key" is whatever string scopes the query — most often a tripId
// (schedules, bookings, members of a trip), but can also be a uid for
// user-scoped queries like "trips I belong to" or "all my hotel
// bookings via collection-group".
//
// Why a factory: every realtime list hook wants the exact same wiring
// — the only differences are the queryKey shape, the initial fetch fn,
// and the subscriber. Wrapping them once here means each feature's
// hook drops to ~5 lines of config instead of 40 lines of useEffect /
// cleanup / race-handling boilerplate duplicated per collection.
//
// `staleTime: Infinity` is intentional. The listener IS the source of
// truth — without infinite staleTime, react-query would fire a
// background getDocs refetch when its stale window expires, racing the
// snapshot-pushed cache and producing UI flicker (and wasting reads).
// Manual `refetch()` still works because that bypasses staleness.
//
// Subscription lifecycle:
//   - subscribe() is async because the firestore SDK is lazy-imported.
//     A `mounted` flag prevents the case where a component unmounts
//     between effect run and subscribe-promise resolution from leaking
//     a live listener.
//   - When `key` changes, the effect re-runs: old listener is torn
//     down via the cleanup, new one starts against the new scope. The
//     query-cache transition is automatic — useQuery's queryKey changes
//     too, so the new key starts from the cache for that scope.
import { useEffect } from 'react'
import { useQuery, useQueryClient, type QueryKey, type UseQueryResult } from '@tanstack/react-query'
import { captureError } from '@/services/sentry'

export interface RealtimeListConfig<T> {
  /** Build the query key from the scope key. Used by both useQuery
   *  (initial fetch + cache slot) and the listener (setQueryData target). */
  queryKeyFactory: (key: string) => QueryKey
  /** Initial fetch — a regular getDocs. Used until the listener pushes
   *  its first snapshot, then the cache is owned by the listener. */
  initialFetch: (key: string) => Promise<T[]>
  /** Async-resolved snapshot subscriber. Returns the unsubscribe fn so
   *  the hook can clean up on unmount or scope switch. */
  subscribe: (
    key:     string,
    onData:  (data: T[]) => void,
    onError: (e: Error)  => void,
  ) => Promise<() => void>
  /** Identifier for Sentry context on listener errors / init failures. */
  source: string
  /** Caller-side opt-out — when present and false, the hook skips both
   *  the initial fetch and the listener. Used by useInvites where only
   *  trip owners should subscribe (rules permit list anyway, but no
   *  point spending the read for non-owners that won't render anything). */
  isEnabled?: (key: string) => boolean
}

/**
 * Builds a hook with the same surface as a useQuery-based list hook,
 * but with a live snapshot listener attached underneath.
 *
 * Usage:
 *   export const useThings = createRealtimeListHook<Thing>({
 *     queryKeyFactory: thingKeys.all,
 *     initialFetch:    getThingsByTrip,
 *     subscribe:       subscribeToThings,
 *     source:          'useThings',
 *   })
 *
 * The hook signature: `(key: string | undefined) => UseQueryResult<T[]>`.
 * Pass `undefined` when the scope is unknown (e.g. uid before auth resolves);
 * the hook short-circuits without firing any reads.
 */
export function createRealtimeListHook<T>(
  config: RealtimeListConfig<T>,
): (key: string | undefined) => UseQueryResult<T[]> {
  const { queryKeyFactory, initialFetch, subscribe, source, isEnabled } = config

  return function useRealtimeList(key: string | undefined): UseQueryResult<T[]> {
    const qc = useQueryClient()
    const callerEnabled = !!key && (isEnabled ? isEnabled(key) : true)

    const result = useQuery<T[]>({
      queryKey:  queryKeyFactory(key ?? ''),
      queryFn:   () => initialFetch(key!),
      enabled:   callerEnabled,
      staleTime: Infinity,
    })

    useEffect(() => {
      if (!key || !callerEnabled) return
      let mounted = true
      let unsub: (() => void) | undefined

      void subscribe(
        key,
        next => {
          if (mounted) qc.setQueryData<T[]>(queryKeyFactory(key), next)
        },
        err => captureError(err, { source, key }),
      ).then(u => {
        if (mounted) unsub = u
        else u()  // resolved after unmount → drop the listener immediately
      }).catch(e => {
        captureError(e, { source: `${source}/subscribe-init`, key })
      })

      return () => {
        mounted = false
        unsub?.()
      }
    }, [key, callerEnabled, qc])

    return result
  }
}
