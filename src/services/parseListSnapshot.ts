// src/services/parseListSnapshot.ts
// Per-row resilience for list-from-snapshot parsing. One bad doc must
// not poison the entire list payload — otherwise schema drift, stale
// IndexedDB cache, or pre-migration leftovers would crash whichever
// tab is unlucky enough to land on the row first.
//
// Strictness is preserved at the layers that matter:
//   - Write path: firestore.rules + Zod create/update schemas reject
//     non-conformant payloads at commit time. The server is always
//     clean.
//   - Single-doc reads: still throw via firestoreDocFromSchema —
//     "I asked for X, X is corrupted" should fail loudly.
//   - List reads: tolerant. Bad rows skipped; firestoreDocFromSchema's
//     captureError() has already shipped the ZodError to Sentry from
//     inside fromDoc before the throw escapes here, so observability
//     is unaffected.
//
// Used by realtimeQuery.subscribeToCollection AND every service's
// getXxxByTrip one-shot read — both code paths suffer the same
// failure mode, so they share the same swallow.
import type { QuerySnapshot, QueryDocumentSnapshot } from 'firebase/firestore'

export function parseListSnapshot<T>(
  snap:    QuerySnapshot,
  fromDoc: (d: QueryDocumentSnapshot) => T,
): T[] {
  const out: T[] = []
  for (const d of snap.docs) {
    try {
      out.push(fromDoc(d))
    } catch {
      // fromDoc already called captureError with the ZodError + docId
      // before throwing — no need to re-report. Silently skip the row.
    }
  }
  return out
}
