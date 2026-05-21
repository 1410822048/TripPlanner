// src/features/trips/services/tripCascade.ts
// Trip cascade-delete — delegates to the Cloudflare Worker's
// /cascade-trip-delete endpoint.
//
// History: this used to walk Storage + every subcollection from the
// client. That worked but had a fundamental gap — to delete each
// expense doc, firestore.rules had to allow owner hard-delete inside
// a 5-minute "cascade window" marker (`deletionStartedAt`). The
// marker itself was owner-writable, so a malicious owner could open
// the window via raw SDK and selectively hard-delete a single
// expense, bypassing the phase-2 soft-delete tombstone that
// settlement chronological replay relies on. KNOWN BROKEN, accepted
// risk until this Worker migration shipped — see CLAUDE.md "P1
// accepted risk".
//
// With the Worker doing the cascade via admin SDK:
//   - firestore.rules has `allow delete: if false` specifically on
//     the docs whose hard-delete would corrupt invariants -- the
//     trip root (cascade integrity) and expenses (settlement
//     chronological replay needs tombstones). Other subcollections
//     keep their normal client-side delete permissions for ordinary
//     editing UX; the Worker still owns the bulk cascade because
//     it's atomic at the trust boundary.
//   - `deletionStartedAt` field is gone (no longer needed)
//   - Client side shrinks from ~80 LOC to a single HTTP call
import { getFirebaseAuth } from '@/services/firebase'

/** OCR worker base URL — same Worker that hosts /cascade-member and
 *  /ocr. Hard-coded because Cloudflare Pages doesn't expose runtime
 *  env vars and we don't want a build-time-only constant scattered
 *  across the codebase. */
const WORKER_BASE = 'https://tripmate-ocr.tripmate.workers.dev'

/**
 * Cascade-delete a trip and every subcollection doc that lives under
 * it. Idempotent: re-running after a partial failure (network blip,
 * Worker timeout) converges — every step the Worker takes is
 * idempotent on its own.
 *
 * Throws a single `Error` whose message names the failing layer so the
 * caller's toast can surface "where it stopped". The Worker reads the
 * caller's uid from the Firebase ID token, so we don't pass it here.
 */
export async function deleteTrip(tripId: string): Promise<void> {
  const { auth } = await getFirebaseAuth()
  const idToken = await auth.currentUser?.getIdToken()
  if (!idToken) {
    throw new Error('Trip cascade failed: no Firebase ID token (not signed in?)')
  }

  let res: Response
  try {
    res = await fetch(`${WORKER_BASE}/cascade-trip-delete`, {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${idToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tripId }),
    })
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    throw new Error(
      `Trip cascade could not reach the cleanup service: ${reason}. ` +
      `Check your connection and retry.`,
    )
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '<unreadable>')
    // 403 / 404 / 429 / 500 all surface as a single error to the caller;
    // the message includes status + body so devs / Sentry can see what
    // tripped. The hook layer turns this into a toast.
    throw new Error(
      `Trip cascade rejected: ${res.status} ${detail.slice(0, 200)}. ` +
      `Retry to continue cleanup (operation is idempotent).`,
    )
  }
}
