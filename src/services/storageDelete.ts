// src/services/storageDelete.ts
// Single Storage object deletion that tolerates the "already gone" case.
// Used by every feature that stores per-doc files (bookings / expenses /
// wishes). Centralised because each previously hand-rolled the same
// try/catch on the same error code — easy to miss the swallow on a new
// caller, which would surface as a misleading "delete failed" toast for
// orphaned-object cleanup.
import { getFirebaseStorage } from './firebase'

/** Delete a Storage object by path. Swallows "object not found" — the doc
 *  may reference a path that's already been cleaned up by a prior failed
 *  attempt, and callers care only about the post-condition. */
export async function deleteStorageObject(filePath: string): Promise<void> {
  const { storage, ref, deleteObject } = await getFirebaseStorage()
  try {
    await deleteObject(ref(storage, filePath))
  } catch (e) {
    const code = (e as { code?: string }).code
    if (code === 'storage/object-not-found') return
    throw e
  }
}
