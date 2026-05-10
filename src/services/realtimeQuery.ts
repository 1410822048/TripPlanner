// src/services/realtimeQuery.ts
// Common wrapper for the 8 onSnapshot list-listeners across the app
// (schedules / bookings / wishes / planning / expenses / members /
// invites / hotels-CG). Before this helper, each subscriber owned the
// same scaffolding:
//
//   const { db, collection, query, ..., onSnapshot } = await getFirebase()
//   const q = query(collection(db, ...), orderBy(...), limit(LIST_LIMIT))
//   return onSnapshot(q, snap => {
//     if (snap.size >= LIST_LIMIT) captureError(...)
//     onData(snap.docs.map(fromDoc))
//   }, onError)
//
// Lifting it produces a single source of truth for:
//   - lazy Firebase SDK loading
//   - LIST_LIMIT truncation Sentry warning
//   - schema-failed-doc -> Sentry forwarding (via fromDoc throwing)
//   - optional post-processing (e.g. wishes' votes-desc resort)
//
// Each per-collection subscriber drops to a config block that names
// the query shape and the doc parser; everything else is centralised.
import type { Query, QueryDocumentSnapshot, QuerySnapshot } from 'firebase/firestore'
import { getFirebase, type FirebaseBundle } from '@/services/firebase'
import { captureError } from '@/services/sentry'

export interface SubscribeToCollectionOpts<T> {
  /**
   * Build the Firestore query from the lazy-loaded SDK bundle. Receives
   * the full bundle (db + every Firestore fn) so the caller can compose
   * collection / collectionGroup / where / orderBy / limit etc. without
   * importing those types at module scope.
   */
  buildQuery: (bundle: FirebaseBundle) => Query
  /**
   * Convert a single snapshot doc into the domain type. Typically wraps
   * `firestoreDocFromSchema(SomeSchema, d, source)` so schema failures
   * surface in Sentry.
   */
  fromDoc: (doc: QueryDocumentSnapshot) => T
  /**
   * Optional post-processor for the doc array — used by wishes to apply
   * votes-desc client-side ordering on each push. If omitted, the items
   * pass through in Firestore order.
   */
  postProcess?: (items: T[]) => T[]
  /** Identifier for Sentry context on truncation / listener errors. */
  source: string
  /**
   * LIST_LIMIT used by the query — surfaced for the truncation warning.
   * Omit for queries that don't apply a defensive cap (e.g. members,
   * invites: small bounded sets where a cap would be theatre).
   */
  limit?: number
}

/**
 * Open an onSnapshot listener. Returns the unsubscribe fn so the caller
 * can clean up on unmount or scope change. Subscription is async because
 * the Firestore SDK is lazy-imported — useFirestoreSubscription /
 * createRealtimeListHook handle the mount-race between effect and
 * promise resolution.
 */
export async function subscribeToCollection<T>(
  opts:    SubscribeToCollectionOpts<T>,
  onData:  (data: T[]) => void,
  onError: (e: Error) => void,
): Promise<() => void> {
  const bundle = await getFirebase()
  const q = opts.buildQuery(bundle)
  return bundle.onSnapshot(
    q,
    (snap: QuerySnapshot) => {
      if (opts.limit !== undefined && snap.size >= opts.limit) {
        captureError(
          new Error(`${opts.source} truncated at ${opts.limit}`),
          { source: opts.source },
        )
      }
      const items = snap.docs.map(opts.fromDoc)
      onData(opts.postProcess ? opts.postProcess(items) : items)
    },
    onError,
  )
}
