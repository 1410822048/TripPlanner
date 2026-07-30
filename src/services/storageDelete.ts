// src/services/storageDelete.ts
// Single private-R2 object deletion that tolerates the "already gone" case.
// Used by every feature that stores per-doc files (bookings / expenses /
// wishes). Centralised because each previously hand-rolled the same
// try/catch on the same error code — easy to miss the swallow on a new
// caller, which would surface as a misleading "delete failed" toast for
// orphaned-object cleanup.
import { deleteAttachmentObject } from './attachmentStorage'

/**
 * Delete an attachment object by path. Two layers of resilience:
 *
 *   1. Worker/R2 delete is idempotent — an absent key is already success.
 *   2. Retry ambiguous failures (network timeout or Worker 5xx).
 *      Without this, every "best-effort purge.catch" in
 *      the calling services (expense / booking / wish) accepted
 *      ONE failure as permanent and would have pushed every blip
 *      down the rest of the ladder (queue write + cron retry).
 *      Catching ~90% of transient failures here keeps the queue
 *      empty under normal conditions, so cron load stays trivial.
 *
 * When this layer's retry budget is exhausted, the calling service
 * doesn't Sentry directly -- it routes through
 * `safePurgeWithEnqueueFallback` which writes a `_purges` queue
 * entry that the Worker `drainOrphanPurges` cron picks up daily.
 * Sentry only fires when BOTH this retry AND the enqueue itself
 * fail (a genuine "no automated cleanup remaining" alert). See the
 * "orphan-blob-durability" memory for the full escalation ladder.
 */
export async function deleteStorageObject(filePath: string): Promise<void> {
  await deleteAttachmentObject(filePath)
}
