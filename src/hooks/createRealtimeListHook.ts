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
import { useEffect, useSyncExternalStore } from 'react'
import { hashKey, useQuery, useQueryClient, type QueryClient, type QueryKey, type UseQueryResult } from '@tanstack/react-query'
import { captureError } from '@/services/sentry'
import { useUid } from '@/hooks/useAuth'
import type { ListOverlayController, OverlayOp } from '@/hooks/listOverlay'
import type { ListSnapshotMetadata } from '@/services/realtimeQuery'

const NO_OPS: readonly OverlayOp<never>[] = Object.freeze([])

interface RealtimeListConfigBase {
  /** initialFetch 必須 server-only。dataUpdatedAt > 0 才代表目前資料
   *  已由 server 確認；0 的快取／pending 資料只供預覽，不可用於結算。 */
  requireServerConfirmation?: boolean
  /** Build the query key from the scope key. Receives uid so per-user cache
   *  scoping stays automatic when needed. */
  queryKeyFactory: (key: string, uid?: string) => QueryKey
  /** Identifier for Sentry context on listener errors / init failures. */
  source: string
  /** Caller-side opt-out. Used by useInvites where only owners subscribe. */
  isEnabled?: (key: string) => boolean
}

interface RealtimeListOverlayConfig<T> {
  /** Optimistic ops replayed over server truth at read time. Applying it
   *  here means every consumer of the list gets the merge — there is no
   *  unmerged read path to forget about. Conditional on T so lists that
   *  aren't row-shaped (e.g. string[]) can't opt in. */
  overlay?: T extends { id: string } ? ListOverlayController<T> : never
}

/** Variant for hooks that need a signed-in uid. */
export interface RealtimeListConfigUidRequired<T> extends RealtimeListConfigBase, RealtimeListOverlayConfig<T> {
  requiresUid: true
  initialFetch: (key: string, uid: string) => Promise<T[]>
  subscribe: (
    key:     string,
    uid:     string,
    onData:  (data: T[], metadata?: ListSnapshotMetadata) => void,
    onError: (e: Error)  => void,
  ) => Promise<() => void>
}

/** Variant for hooks that don't require uid. */
export interface RealtimeListConfigUidOptional<T> extends RealtimeListConfigBase, RealtimeListOverlayConfig<T> {
  requiresUid?: false
  initialFetch: (key: string, uid: string | undefined) => Promise<T[]>
  subscribe: (
    key:     string,
    uid:     string | undefined,
    onData:  (data: T[], metadata?: ListSnapshotMetadata) => void,
    onError: (e: Error)  => void,
  ) => Promise<() => void>
}

export type RealtimeListConfig<T> = RealtimeListConfigUidRequired<T> | RealtimeListConfigUidOptional<T>

interface SharedListener {
  refCount:        number
  unsub?:          () => void
  disposed:        boolean
  error?:          Error
  retry:           () => void
}

const registries = new WeakMap<QueryClient, Map<string, SharedListener>>()

/** 共用 queryFn 的恢復入口；只重啟失敗且仍有使用者的訂閱。 */
export function retrySharedListener(qc: QueryClient, queryKey: QueryKey): void {
  registries.get(qc)?.get(hashKey(queryKey))?.retry()
}

export function acquireListener<T>(
  queryKey: QueryKey,
  scope:    string,
  qc:       QueryClient,
  startFn:  (
    onData:  (data: T[], metadata?: ListSnapshotMetadata) => void,
    onError: (e: Error)  => void,
  ) => Promise<() => void>,
  source:   string,
  requireServerConfirmation = false,
): () => void {
  let listeners = registries.get(qc)
  if (!listeners) {
    listeners = new Map()
    registries.set(qc, listeners)
  }
  const registry = listeners
  const id = hashKey(queryKey)
  const existing = listeners.get(id)
  if (existing) {
    existing.refCount += 1
    existing.retry()
    return () => releaseListener(registry, id, existing)
  }

  const entry: SharedListener = { refCount: 1, disposed: false, retry: () => {} }
  registry.set(id, entry)
  if (requireServerConfirmation) {
    const cached = qc.getQueryData<T[]>(queryKey)
    if (cached !== undefined) qc.setQueryData(queryKey, cached, { updatedAt: 0 })
  }
  let generation = 0

  const start = () => {
    const attempt = ++generation
    entry.error = undefined
    const isCurrent = () => !entry.disposed && generation === attempt && registry.get(id) === entry
    const fail = (error: Error, failureSource: string) => {
      if (!isCurrent() || entry.refCount === 0) return
      // A listen error is terminal. Keep consumer ownership, but invalidate
      // this attempt so late callbacks / init completion cannot revive it.
      generation += 1
      entry.error = error
      entry.unsub?.()
      entry.unsub = undefined
      void qc.cancelQueries({ queryKey, exact: true })
      qc.getQueryCache().find<T[]>({ queryKey, exact: true })?.setState({
        status: 'error', error, fetchStatus: 'idle', errorUpdatedAt: Date.now(),
      })
      captureError(error, { source: failureSource, key: scope })
    }

    void Promise.resolve().then(() => {
      if (!isCurrent()) return
      return startFn(
        (next, metadata) => {
          if (!isCurrent() || entry.refCount === 0) return
          const confirmed = !requireServerConfirmation ||
            (!!metadata && !metadata.fromCache && !metadata.hasPendingWrites)
          // 快取不得取消尚未完成的 server read。資料與權威更新時間由 Query
          // 同一次更新發布；0 表示目前資料尚未確認，不另存 ready boolean。
          if (confirmed) void qc.cancelQueries({ queryKey, exact: true })
          qc.setQueryData<T[]>(queryKey, next, { updatedAt: confirmed ? Date.now() : 0 })
        },
        error => fail(error, source),
      )
    }).then(unsub => {
      if (!unsub) return
      if (!isCurrent()) {
        unsub()
        return
      }
      entry.unsub = unsub
    }).catch(error => {
      fail(error instanceof Error ? error : new Error(String(error)), source + '/subscribe-init')
    })
  }
  entry.retry = () => {
    if (entry.error && !entry.disposed && entry.refCount > 0) start()
  }
  start()

  return () => releaseListener(registry, id, entry)
}

/** `expected` pins the generation this release belongs to. A consumer that
 *  outlived its own entry (subscribe failed, or it was already released)
 *  must not decrement whatever entry now holds the same key. */
function releaseListener(listeners: Map<string, SharedListener>, id: string, expected: SharedListener): void {
  const entry = listeners.get(id)
  if (entry !== expected) return
  entry.refCount -= 1
  if (entry.refCount > 0) return
  // StrictMode reacquires in the same task. Final unmount still disables
  // callbacks immediately (refCount == 0) and closes pending init later.
  queueMicrotask(() => {
    if (listeners.get(id) !== entry || entry.refCount > 0) return
    entry.disposed = true
    listeners.delete(id)
    entry.unsub?.()
  })
}

/**
 * Builds a hook with the same surface as a useQuery-based list hook, with a
 * live snapshot listener attached underneath.
 */
export function createRealtimeListHook<T>(
  config: RealtimeListConfig<T>,
): (key: string | undefined) => UseQueryResult<T[]> {
  const { queryKeyFactory, source, isEnabled } = config
  const overlay = config.overlay as ListOverlayController<T & { id: string }> | undefined

  function runInitialFetch(key: string, uid: string | undefined): Promise<T[]> {
    if (config.requiresUid) return config.initialFetch(key, uid as string)
    return config.initialFetch(key, uid)
  }

  function runSubscribe(
    key:     string,
    uid:     string | undefined,
    onData:  (data: T[], metadata?: ListSnapshotMetadata) => void,
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

    const queryKey = queryKeyFactory(key ?? '', uid)
    const result = useQuery<T[]>({
      queryKey,
      queryFn:   async ({ signal }) => {
        // Refetch can restart a failed listener while its consumers remain.
        retrySharedListener(qc, queryKey)
        const data = await runInitialFetch(key!, uid)
        signal.throwIfAborted()
        return data
      },
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
        config.requireServerConfirmation,
      )
      return release
    }, [key, uid, callerEnabled, qc])

    const queryKeyHash = hashKey(queryKey)
    const ops = useSyncExternalStore(
      cb    => overlay?.subscribe(queryKeyHash, cb) ?? (() => {}),
      ()    => overlay?.getSnapshot(queryKeyHash) ?? NO_OPS,
      ()    => NO_OPS,
    ) as readonly OverlayOp<T & { id: string }>[]

    // Depends on `ops` as well as the data: a local Firestore echo often
    // makes server truth agree BEFORE the mutation resolves, so the
    // pending → succeeded flip is the only thing that changes. Without it
    // that op would wait for its grace timer.
    useEffect(() => {
      if (!overlay || !result.data || (config.requireServerConfirmation && result.dataUpdatedAt === 0)) return
      overlay.reconcile(queryKeyHash, result.data as (T & { id: string })[])
    }, [queryKeyHash, result.data, result.dataUpdatedAt, ops])

    // Remount is one of the three retry triggers: the browser can stay
    // online throughout while the backend is the thing that was failing.
    useEffect(() => {
      overlay?.retryUnconfirmed(queryKeyHash)
    }, [queryKeyHash])

    if (!overlay || !result.data || ops.length === 0) return result
    const merged = overlay.merge(result.data as (T & { id: string })[], ops)
    return (merged === result.data ? result : { ...result, data: merged }) as UseQueryResult<T[]>
  }
}
