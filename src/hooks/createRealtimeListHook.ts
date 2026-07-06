// src/hooks/createRealtimeListHook.ts
// Factory for "list of T scoped to a stable string key" hooks backed by:
//
//   1. an initial getDocs fetch through useQuery, and
//   2. a Firestore onSnapshot listener that writes pushed updates into
//      the same TanStack Query cache slot.
//
// `staleTime: Infinity` is intentional. The listener is the source of truth;
// without infinite staleTime, React Query would run background getDocs
// refetches that race snapshot-pushed cache updates and waste reads.
//
// Listener dedup:
// Multiple callsites for the same scope share one onSnapshot. TanStack Query
// dedupes cache entries, but not the underlying Firestore subscription.
import { useEffect } from 'react'
import { useQuery, useQueryClient, type QueryClient, type QueryKey, type UseQueryResult } from '@tanstack/react-query'
import { captureError } from '@/services/sentry'
import { useUid } from '@/hooks/useAuth'

interface RealtimeListConfigBase {
  /** Build the query key from the scope key. Receives uid so per-user cache
   *  scoping stays automatic when needed. */
  queryKeyFactory: (key: string, uid?: string) => QueryKey
  /** Identifier for Sentry context on listener errors / init failures. */
  source: string
  /** Caller-side opt-out. Used by useInvites where only owners subscribe. */
  isEnabled?: (key: string) => boolean
}

/** Variant for hooks that need a signed-in uid. */
export interface RealtimeListConfigUidRequired<T> extends RealtimeListConfigBase {
  requiresUid: true
  initialFetch: (key: string, uid: string) => Promise<T[]>
  subscribe: (
    key:     string,
    uid:     string,
    onData:  (data: T[]) => void,
    onError: (e: Error)  => void,
  ) => Promise<() => void>
}

/** Variant for hooks that don't require uid. */
export interface RealtimeListConfigUidOptional<T> extends RealtimeListConfigBase {
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
  refCount:        number
  unsub?:          () => void
  pendingRelease?: boolean
}

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
      qc.setQueryData<T[]>(queryKey, next)
    },
    err => {
      const code = (err as { code?: string }).code
      if (code === 'permission-denied') {
        if (import.meta.env.DEV) {
          console.warn(`[${source}:${scope}] listener permission revoked`, err)
        }
        return
      }
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
 * Builds a hook with the same surface as a useQuery-based list hook, with a
 * live snapshot listener attached underneath.
 */
export function createRealtimeListHook<T>(
  config: RealtimeListConfig<T>,
): (key: string | undefined) => UseQueryResult<T[]> {
  const { queryKeyFactory, source, isEnabled } = config

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

    return result
  }
}
