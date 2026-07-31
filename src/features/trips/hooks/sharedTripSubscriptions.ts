import type { QueryClient } from '@tanstack/react-query'
import { subscribeToTrip } from '../services/tripService'
import { captureError } from '@/services/sentry'
import { markPerf } from '@/utils/perf'
import { tripKeys } from '../queryKeys'
import type { Trip } from '@/types'

interface TripHandle {
  active: boolean
  unsubscribe?: () => void
}

interface SharedTripSubscription {
  readonly queryClient: QueryClient
  readonly uid: string
  readonly handles: Map<string, TripHandle>
  readonly resolvedIds: Set<string>
  readonly trips: Map<string, Trip>
  ids: string[]
  refCount: number
  releaseGeneration: number
  disposed: boolean
  firstPublishMarked: boolean
}

// QueryClient is part of the identity: tests, Storybook, or a future
// multi-root shell may mount independent clients with identical query keys.
// A plain module-level Map keyed only by uid would publish one root's data
// into another root's cache.
const registries = new WeakMap<QueryClient, Map<string, SharedTripSubscription>>()

function registryFor(queryClient: QueryClient): Map<string, SharedTripSubscription> {
  let registry = registries.get(queryClient)
  if (!registry) {
    registry = new Map()
    registries.set(queryClient, registry)
  }
  return registry
}

function publish(entry: SharedTripSubscription): void {
  if (entry.disposed) return

  // Preserve a complete one-shot query result while individual listeners
  // deliver their first snapshots. Once a listener resolves an id (including
  // a missing doc), its value becomes authoritative over the cached fallback.
  const cached = entry.queryClient.getQueryData<Trip[]>(tripKeys.mine(entry.uid)) ?? []
  const cachedById = new Map(cached.map(trip => [trip.id, trip]))
  const next = entry.ids
    .flatMap(id => {
      const trip = entry.resolvedIds.has(id) ? entry.trips.get(id) : (entry.trips.get(id) ?? cachedById.get(id))
      return trip ? [trip] : []
    })
    .sort((a, b) => b.createdAt.toMillis() - a.createdAt.toMillis())

  entry.queryClient.setQueryData<Trip[]>(tripKeys.mine(entry.uid), next)
  if (!entry.firstPublishMarked && next.length > 0) {
    entry.firstPublishMarked = true
    markPerf('mytrips-first-publish')
  }
}

function stopHandle(handle: TripHandle): void {
  handle.active = false
  handle.unsubscribe?.()
}

function startTrip(entry: SharedTripSubscription, tripId: string): void {
  const handle: TripHandle = { active: true }
  entry.handles.set(tripId, handle)

  void subscribeToTrip(
    tripId,
    trip => {
      if (!handle.active || entry.disposed || entry.handles.get(tripId) !== handle) return
      entry.resolvedIds.add(tripId)
      if (trip) entry.trips.set(tripId, trip)
      else entry.trips.delete(tripId)
      publish(entry)
    },
    err => {
      if (!handle.active || entry.disposed || entry.handles.get(tripId) !== handle) return
      const code = (err as { code?: string }).code
      if (code === 'permission-denied') {
        if (import.meta.env.DEV) {
          console.warn(`[useMyTrips/tripDoc:${tripId}] listener permission revoked`, err)
        }
        return
      }
      const error = err instanceof Error ? err : new Error(String(err))
      const tagged = new Error(`[useMyTrips/tripDoc:${tripId}] ${error.message}`)
      tagged.name = error.name
      tagged.stack = error.stack
      captureError(tagged, { source: 'useMyTrips/tripDoc', tripId })
    },
  ).then(unsubscribe => {
    if (!handle.active || entry.disposed || entry.handles.get(tripId) !== handle) {
      unsubscribe()
      return
    }
    handle.unsubscribe = unsubscribe
  }).catch(err => {
    if (!handle.active || entry.disposed || entry.handles.get(tripId) !== handle) return
    entry.handles.delete(tripId)
    captureError(err, { source: 'useMyTrips/subscribe-init', tripId })
  })
}

function dispose(entry: SharedTripSubscription): void {
  if (entry.disposed) return
  entry.disposed = true
  registryFor(entry.queryClient).delete(entry.uid)
  for (const handle of entry.handles.values()) stopHandle(handle)
  entry.handles.clear()
  entry.resolvedIds.clear()
  entry.trips.clear()
}

/**
 * Retain the single per-user trip-doc controller used by every useMyTrips
 * observer mounted under the same QueryClient.
 */
export function acquireSharedTripSubscription(queryClient: QueryClient, uid: string): () => void {
  const registry = registryFor(queryClient)
  let entry = registry.get(uid)
  if (!entry) {
    entry = {
      queryClient,
      uid,
      handles: new Map(),
      resolvedIds: new Set(),
      trips: new Map(),
      ids: [],
      refCount: 0,
      releaseGeneration: 0,
      disposed: false,
      firstPublishMarked: false,
    }
    registry.set(uid, entry)
  }

  entry.refCount += 1
  entry.releaseGeneration += 1

  let released = false
  return () => {
    if (released) return
    released = true
    entry!.refCount -= 1
    if (entry!.refCount > 0) return

    // React StrictMode releases and reacquires effects in the same task.
    // Microtask deferral avoids opening a duplicate Firestore target in dev
    // while still tearing down promptly after a real final unmount.
    const generation = ++entry!.releaseGeneration
    queueMicrotask(() => {
      if (entry!.refCount === 0 && entry!.releaseGeneration === generation) dispose(entry!)
    })
  }
}

/** Synchronise the controller to the authoritative membership-derived ids. */
export function syncSharedTripIds(queryClient: QueryClient, uid: string, ids: readonly string[]): void {
  const entry = registryFor(queryClient).get(uid)
  if (!entry || entry.disposed) return

  const nextIds = Array.from(new Set(ids))
  const unchanged = nextIds.length === entry.ids.length && nextIds.every((id, index) => id === entry.ids[index])
  if (unchanged) return

  const nextSet = new Set(nextIds)
  let removed = false
  for (const [tripId, handle] of entry.handles) {
    if (nextSet.has(tripId)) continue
    entry.handles.delete(tripId)
    entry.resolvedIds.delete(tripId)
    entry.trips.delete(tripId)
    stopHandle(handle)
    removed = true
  }

  entry.ids = nextIds
  for (const tripId of nextIds) {
    if (!entry.handles.has(tripId)) startTrip(entry, tripId)
  }

  // Removing/reordering ids must update the aggregate immediately. Pure adds
  // wait for their first snapshot so an existing complete cache is not
  // replaced by a partial list.
  if (removed || nextIds.length === 0) publish(entry)
}
