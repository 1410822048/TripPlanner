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
import { useEffect, useSyncExternalStore } from 'react'
import { useQuery, useQueryClient, type QueryKey, type UseQueryResult, type QueryClient } from '@tanstack/react-query'
import { captureError } from '@/services/sentry'
import { useUid } from '@/hooks/useAuth'
import { filterTombstoned, pruneTombstones, subscribeTombstones, tombstoneVersion } from '@/utils/listTombstones'

// Two-shape config — a discriminated union on `requiresUid` so callbacks
// get the right `uid` type without callers writing `uid!`. Tried a
// `<T, R extends boolean>` generic + conditional types first; TS
// contextual-typing didn't infer R from `requiresUid: true` reliably
// (it kept defaulting to false). The DU narrows cleanly once we check
// `config.requiresUid` in the factory body.

interface RealtimeListConfigBase<T> {
  /** Build the query key from the scope key. Used by both useQuery
   *  (initial fetch + cache slot) and the listener (setQueryData target).
   *  Receives uid so per-user cache scoping is automatic when needed. */
  queryKeyFactory: (key: string, uid?: string) => QueryKey
  /** Identifier for Sentry context on listener errors / init failures. */
  source: string
  /** Caller-side opt-out — when present and false, the hook skips both
   *  the initial fetch and the listener. Used by useInvites where only
   *  trip owners should subscribe. */
  isEnabled?: (key: string) => boolean
  /** Opt-in to the optimistic-delete overlay (see utils/listTombstones).
   *  When provided, the hook (a) `select`-filters out ids that a pending
   *  Worker-authoritative delete has tombstoned, and (b) prunes a
   *  tombstone once that id leaves the raw server snapshot (delete
   *  confirmed). Pair with `useTripListMutation({ tombstone })`. Omit for
   *  the common case (client-SDK deletes are latency-compensated and
   *  don't need this). Returns the doc id for tombstone matching. */
  tombstoneIdOf?: (item: T) => string
}

/** Variant for hooks that need a signed-in uid (trip-scoped subcollection
 *  listeners needing the `memberIds` filter). Callbacks receive
 *  `uid: string` — the factory's `enabled` gate plus the runtime
 *  `!!uid` check guarantees it. */
export interface RealtimeListConfigUidRequired<T> extends RealtimeListConfigBase<T> {
  requiresUid: true
  initialFetch: (key: string, uid: string) => Promise<T[]>
  subscribe: (
    key:     string,
    uid:     string,
    onData:  (data: T[]) => void,
    onError: (e: Error)  => void,
  ) => Promise<() => void>
}

/** Variant for hooks that don't require uid (collection-group queries
 *  with built-in filtering, owner-only listings, etc.). */
export interface RealtimeListConfigUidOptional<T> extends RealtimeListConfigBase<T> {
  requiresUid?: false
  initialFetch: (key: string, uid: string | undefined) => Promise<T[]>
  subscribe: (
    key:     string,
    uid:     string | undefined,
    onData:  (data: T[]) => void,
    onError: (e: Error)  => void,
  ) => Promise<() => void>
}

export type RealtimeListConfig<T> = RealtimeListConfigUidRequired<T> | RealtimeListConfigUidOptional<T>

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
  // Access via `config.X` (not destructure) so the discriminated union
  // narrows on `config.requiresUid` inside the dispatch helpers.
  const { queryKeyFactory, source, isEnabled } = config

  // Type-safe dispatch: pattern-match on the discriminator so each call
  // hits the matching `initialFetch` / `subscribe` overload. The
  // `as` cast in the uid-required branch is sound because callerEnabled
  // gates on `!!uid`, so we never reach this when uid is undefined.
  function runInitialFetch(key: string, uid: string | undefined): Promise<T[]> {
    if (config.requiresUid) return config.initialFetch(key, uid as string)
    return config.initialFetch(key, uid)
  }
  function runSubscribe(
    key:     string,
    uid:     string | undefined,
    onData:  (data: T[]) => void,
    onError: (e: Error)  => void,
  ): Promise<() => void> {
    if (config.requiresUid) return config.subscribe(key, uid as string, onData, onError)
    return config.subscribe(key, uid, onData, onError)
  }

  return function useRealtimeList(key: string | undefined): UseQueryResult<T[]> {
    const qc  = useQueryClient()
    const uid = useUid()
    const callerEnabled = !!key
      && (isEnabled ? isEnabled(key) : true)
      && (config.requiresUid ? !!uid : true)

    const getId = config.tombstoneIdOf
    const result = useQuery<T[]>({
      queryKey:  queryKeyFactory(key ?? '', uid),
      queryFn:   () => runInitialFetch(key!, uid),
      enabled:   callerEnabled,
      staleTime: Infinity,
    })

    useEffect(() => {
      if (!key || !callerEnabled) return
      const release = acquireListener<T>(
        queryKeyFactory(key, uid),
        key,
        qc,
        (onData, onError) => runSubscribe(key, uid, onData, onError),
        source,
      )
      return release
    }, [key, uid, callerEnabled, qc])

    // ── Optimistic-delete overlay (opt-in via config.tombstoneIdOf) ──
    // Subscribe to the tombstone store for this key so the hook re-renders
    // deterministically on every overlay transition (optimistic delete /
    // rollback / server-confirmed prune) — independent of react-query's
    // select memoisation + structural sharing. When no extractor is
    // configured the subscribe is a no-op and getSnapshot is a constant, so
    // there is zero behaviour change for the other list hooks.
    const tombstoneKey = queryKeyFactory(key ?? '', uid)
    useSyncExternalStore(
      cb => (getId ? subscribeTombstones(tombstoneKey, cb) : () => {}),
      () => (getId ? tombstoneVersion(tombstoneKey) : 0),
      () => 0,
    )

    // Prune confirmed deletes against server truth. Runs whenever the raw
    // server list for this key changes (listener push OR initialFetch /
    // refetch): result.data IS the raw list (no select), so any tombstoned
    // id that has left it has been deleted for real and its tombstone is
    // dropped. Structural sharing keeps the ref stable across identical
    // snapshots, so this only fires when contents actually changed.
    useEffect(() => {
      if (!getId || !key || !callerEnabled || !result.data) return
      pruneTombstones(queryKeyFactory(key, uid), result.data, getId)
    }, [result.data, getId, key, uid, callerEnabled])

    if (!getId || !result.data) return result
    // Apply the overlay at read-time. filterTombstoned returns the SAME ref
    // when nothing is tombstoned, so the spread only produces a new object
    // when there's an actual pending delete to hide.
    const filtered = filterTombstoned(tombstoneKey, result.data, getId)
    return (filtered === result.data ? result : { ...result, data: filtered }) as UseQueryResult<T[]>
  }
}
