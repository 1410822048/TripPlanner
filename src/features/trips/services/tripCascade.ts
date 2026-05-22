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
import {
  requireWorkerWriteBase, preflightIdToken, workerFetch,
  WorkerRejected,
} from '@/services/workerBase'

/**
 * Cascade-delete a trip and every subcollection doc that lives under
 * it. Idempotent: re-running after a partial failure (network blip,
 * Worker timeout) converges — every step the Worker takes is
 * idempotent on its own.
 *
 * Throws a single `Error` whose message names the failing layer so the
 * caller's toast can surface "where it stopped". The Worker reads the
 * caller's uid from the Firebase ID token, so we don't pass it here.
 *
 * Preflight ordering (env → auth → call) matches the expense write
 * path so a misconfigured deploy / signed-out user fails closed BEFORE
 * the destructive Worker call. workerFetch then wraps the actual HTTP
 * with AbortSignal.timeout + WorkerRejected/Ambiguous discrimination
 * -- 5xx mid-cascade is now distinguishable from 4xx pre-cascade,
 * which matters because the former may have partially deleted
 * subcollections and the user retry is the ONLY path to convergence.
 */
export async function deleteTrip(tripId: string): Promise<void> {
  const workerBase = requireWorkerWriteBase()
  const idToken    = await preflightIdToken()

  try {
    await workerFetch(workerBase, idToken, '/cascade-trip-delete', { tripId })
  } catch (e) {
    if (e instanceof WorkerRejected) {
      // 4xx -- Worker definitively refused. Nothing was deleted.
      // Caller's toast can surface the status for the user to fix.
      throw new Error(
        `Trip cascade rejected (${e.status}): ${e.message}. ` +
        `Fix the issue and retry.`,
      )
    }
    // WorkerAmbiguous (timeout / network / 5xx) OR unrecognised.
    // Cascade may be partially applied; the operation is idempotent
    // so the user should retry until success.
    const reason = e instanceof Error ? e.message : String(e)
    throw new Error(
      `Trip cascade did not complete: ${reason}. ` +
      `Retry to continue cleanup (operation is idempotent).`,
    )
  }
}
