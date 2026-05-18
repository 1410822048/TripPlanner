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
// `staleTime: Infinity` is intentional. The listener IS the source of
// truth — without infinite staleTime, react-query would fire a
// background getDocs refetch when its stale window expires, racing the
// snapshot-pushed cache and producing UI flicker (and wasting reads).
// Manual `refetch()` still works because that bypasses staleness.
//
// ─── Listener dedup ──────────────────────────────────────────────
// Multiple callsites for the same scope (e.g. AppLayout's
// useFeatureBadges always-on + the matching page's useXxx on mount)
// share ONE onSnapshot. Without this, every same-scope caller opens
// its own listener and pays Firestore reads in parallel (TanStack
// Query dedupes the cache slot but not the underlying snapshot
// subscription). The shared listener is keyed by stringified queryKey
// and is released when the last subscriber unmounts.
import { useEffect } from 'react'
import { useQuery, useQueryClient, type QueryKey, type UseQueryResult, type QueryClient } from '@tanstack/react-query'
import { captureError } from '@/services/sentry'
import { useUid } from '@/hooks/useAuth'

export interface RealtimeListConfig<T> {
  /** Build the query key from the scope key. Used by both useQuery
   *  (initial fetch + cache slot) and the listener (setQueryData target).
   *  The factory also receives uid so per-user cache scoping is automatic
   *  when needed; most callers ignore the second arg. */
  queryKeyFactory: (key: string, uid?: string) => QueryKey
  /** Initial fetch — a regular getDocs. Used until the listener pushes
   *  its first snapshot, then the cache is owned by the listener. uid is
   *  passed so trip-scoped subcollection list queries can include the
   *  `where('memberIds', 'array-contains', uid)` filter required by the
   *  same-doc list rules. Pass-through optional for queries that don't
   *  need it (collection-group queries that already filter, single-doc
   *  reads, owner-only listings). */
  initialFetch: (key: string, uid?: string) => Promise<T[]>
  /** Async-resolved snapshot subscriber. uid is forwarded so listener
   *  queries can apply the same memberIds filter. */
  subscribe: (
    key:     string,
    uid:     string | undefined,
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
  /** When true, the hook requires a signed-in uid before activating.
   *  Trip-scoped subcollection listeners need uid for the memberIds
   *  filter. Hooks that don't (collection-group queries with built-in
   *  uid filtering, etc.) leave this off and accept the empty cache
   *  when signed-out. */
  requiresUid?: boolean
}

interface SharedListener {
  /** Number of mounted callers currently relying on this subscription. */
  refCount:        number
  /** Unsub fn once the subscribe promise resolves. Undefined during the
   *  init race window — held writes / unmounts still increment / decrement
   *  refCount correctly, and the unsub is invoked once available. */
  unsub?:          () => void
  /** True once a 0-refCount cleanup has been requested but the subscribe
   *  promise hadn't resolved yet — when it lands we tear down immediately. */
  pendingRelease?: boolean
}

// Module-level registry — one entry per active queryKey. Keyed by JSON
// stringified queryKey for stable string identity (queryKey is an array
// of primitives by convention in this codebase, so stringify is safe).
const listeners = new Map<string, SharedListener>()

function acquireListener<T>(
  queryKey: QueryKey,
  scope:    string,
  qc:       QueryClient,
  startFn:  (
    onData:  (data: T[]) => void,
    onError: (e: Error)  => void,
  ) => Promise<() => void>,
  source:   string,
): () => void {
  const id = JSON.stringify(queryKey)
  const existing = listeners.get(id)
  if (existing) {
    existing.refCount += 1
    return () => releaseListener(id)
  }

  const entry: SharedListener = { refCount: 1 }
  listeners.set(id, entry)

  void startFn(
    next => {
      // Always write to the cache — entries may have been released
      // between subscribe start and this push. The set is harmless on
      // a stale cache slot and lets late-resolving snapshots land cleanly.
      qc.setQueryData<T[]>(queryKey, next)
    },
    err => {
      const code = (err as { code?: string }).code
      if (code === 'permission-denied') {
        // Now that rules use same-doc memberIds (no cross-document
        // exists() lookup), permission-denied on a list listener means
        // genuine loss of access — trip deleted, member kicked, role
        // revoked. Silently accept; UI elsewhere already reflects the
        // change (empty list / nav away). Real rule bugs surface via
        // WRITE failures (which DO toast the user).
        if (import.meta.env.DEV) {
          console.warn(`[${source}:${scope}] listener permission revoked`, err)
        }
        return
      }
      // Non-permission listener error: prefix with source + scope so
      // Sentry's main event view points straight at the failing
      // listener — no need to dig into "Additional Data".
      const e = err instanceof Error ? err : new Error(String(err))
      const tagged = new Error(`[${source}:${scope}] ${e.message}`)
      tagged.name  = e.name
      tagged.stack = e.stack
      captureError(tagged, { source, key: scope })
    },
  ).then(u => {
    if (entry.pendingRelease) {
      u()
      return
    }
    entry.unsub = u
  }).catch(e => {
    listeners.delete(id)
    captureError(e, { source: `${source}/subscribe-init`, key: scope })
  })

  return () => releaseListener(id)
}

function releaseListener(id: string): void {
  const entry = listeners.get(id)
  if (!entry) return
  entry.refCount -= 1
  if (entry.refCount > 0) return
  listeners.delete(id)
  if (entry.unsub) entry.unsub()
  else entry.pendingRelease = true
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
  const { queryKeyFactory, initialFetch, subscribe, source, isEnabled, requiresUid } = config

  return function useRealtimeList(key: string | undefined): UseQueryResult<T[]> {
    const qc  = useQueryClient()
    const uid = useUid()
    const callerEnabled = !!key
      && (isEnabled ? isEnabled(key) : true)
      && (requiresUid ? !!uid : true)

    const result = useQuery<T[]>({
      queryKey:  queryKeyFactory(key ?? '', uid),
      queryFn:   () => initialFetch(key!, uid),
      enabled:   callerEnabled,
      staleTime: Infinity,
    })

    useEffect(() => {
      if (!key || !callerEnabled) return
      const release = acquireListener<T>(
        queryKeyFactory(key, uid),
        key,
        qc,
        (onData, onError) => subscribe(key, uid, onData, onError),
        source,
      )
      return release
    }, [key, uid, callerEnabled, qc])

    return result
  }
}
