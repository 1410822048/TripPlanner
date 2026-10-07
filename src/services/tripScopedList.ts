// src/services/tripScopedList.ts
// Factory for the matched `getXxxByTrip` + `subscribeToXxx` pair every
// trip-scoped entity service implements. Variation axes kept as config:
//   - `path`        — subcollection (P.expenses, P.bookings, etc.)
//   - `fromDoc`     — entity-specific schema parse
//   - `orderBy`     — (field, dir) tuples; multi-column supported
//   - `limit`       — defensive cap; entity-specific (100-200 typical)
//   - `postProcess` — optional client-side re-sort (wish votes-desc)
//
// What's NOT abstracted: create / update / delete. Per-entity variation
// (attachment shapes, deleteField key lists, creator field aliases like
// wish's `proposedBy`) makes a generic write factory uglier than the
// hand-written variants.
import type { QueryDocumentSnapshot } from 'firebase/firestore'
import { getFirebase, type FirebaseBundle } from '@/services/firebase'
import { captureError } from '@/services/sentry'
import { parseListSnapshot, parseServerListSnapshot } from '@/services/parseListSnapshot'
import { subscribeToCollection, type ListSnapshotMetadata } from '@/services/realtimeQuery'

export interface TripScopedListServices<T> {
  /** One-shot fetch with the same shape as the realtime subscriber so
   *  cache prefill (eg. usePrefetchBookings) and the live listener
   *  agree on row order. */
  fetch:     (tripId: string, uid: string) => Promise<T[]>
  /** Same query, but never answered from Firestore's local cache. Used to
   *  settle an ambiguous write, where the local cache is precisely the
   *  state under question. */
  fetchFromServer: (tripId: string, uid: string) => Promise<T[]>
  /** Realtime listener. Returns an unsubscribe fn promised lazily
   *  alongside the Firebase SDK. */
  subscribe: (
    tripId:  string,
    uid:     string,
    onData:  (data: T[], metadata?: ListSnapshotMetadata) => void,
    onError: (e: Error)  => void,
  ) => Promise<() => void>
}

export interface CreateTripScopedListServicesOpts<T> {
  /** Builder for the Firestore path tuple. Tuple-typed (not `string[]`)
   *  because `collection(db, path, ...segments)` requires at least one
   *  fixed first segment — passing P.expenses / P.bookings etc. works
   *  out of the box; passing a generic `string[]` would lose that
   *  constraint and trip TS's spread-into-variadic check. */
  path:    (tripId: string) => readonly [string, ...string[]]
  fromDoc: (doc: QueryDocumentSnapshot) => T
  /** [field, dir?] tuples; applied in order. `dir` defaults to 'asc'.
   *  Use multiple entries for tiebreaker columns. */
  orderBy: ReadonlyArray<readonly [field: string, dir?: 'asc' | 'desc']>
  limit:   number
  /** 帳務列表禁止截斷或略過壞資料；查詢多取一筆以偵測溢出。 */
  requireComplete?: boolean
  /** Sentry tag for truncation warnings + subscriber errors. Keep it
   *  short (e.g. `'expenses'`, not `'subscribeToExpenses'`). */
  source:  string
  /** Optional last-mile re-order (eg. wish votes-desc). Applied on both
   *  the one-shot fetch result AND every realtime push so the two paths
   *  produce identical row order. */
  postProcess?: (items: T[]) => T[]
}

export function createTripScopedListServices<T>(
  opts: CreateTripScopedListServicesOpts<T>,
): TripScopedListServices<T> {
  const { path, fromDoc, orderBy, limit: LIM, source, postProcess, requireComplete } = opts

  // One query for both the one-shot read and the listener, so the two can
  // never drift apart on filters, order or the +1 completeness probe.
  function buildQuery(fb: FirebaseBundle, tripId: string, uid: string) {
    return fb.query(
      fb.collection(fb.db, ...path(tripId)),
      fb.where('memberIds', 'array-contains', uid),
      ...orderBy.map(([f, d]) => fb.orderBy(f, d ?? 'asc')),
      fb.limit(LIM + (requireComplete ? 1 : 0)),
    )
  }

  async function read(tripId: string, uid: string, fromServer: boolean): Promise<T[]> {
    const fb = await getFirebase()
    const q = buildQuery(fb, tripId, uid)
    const snap = await (fromServer || requireComplete ? fb.getDocsFromServer(q) : fb.getDocs(q))
    if (!requireComplete && snap.size >= LIM) {
      captureError(new Error(`${source} truncated at ${LIM}`), { tripId, source })
    }
    const items = requireComplete ? parseServerListSnapshot(snap, fromDoc, LIM) : parseListSnapshot(snap, fromDoc)
    return postProcess ? postProcess(items) : items
  }

  return {
    fetch:           (tripId, uid) => read(tripId, uid, false),
    fetchFromServer: (tripId, uid) => read(tripId, uid, true),

    subscribe(tripId, uid, onData, onError) {
      return subscribeToCollection<T>({
        buildQuery: fb => buildQuery(fb, tripId, uid),
        fromDoc,
        source,
        limit: LIM,
        requireComplete,
        ...(postProcess && { postProcess }),
      }, onData, onError)
    },
  }
}
