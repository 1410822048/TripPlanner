// src/features/bookings/services/bookingStorage.ts
// Phase 3.7 trimmed surface: the upload side moved into bookingService
// (Worker-authoritative /booking-file-create + /booking-file-update),
// so this file is purge-only. Kept as a module rather than inlined into
// bookingService because deleteBooking + updateBooking's safePurge
// ladder + trip cascade all reach for `purgeAttachments` independently.

import { deleteStorageObject } from '@/services/storageDelete'
import type { BookingAttachment } from '@/types'

/**
 * Delete the full + thumb storage objects for an existing attachment.
 * Thumb path may be missing on PDFs -- deleteStorageObject tolerates
 * that along with already-deleted objects.
 */
export async function purgeAttachments(
  existing: BookingAttachment | undefined,
): Promise<void> {
  if (!existing) return
  const tasks: Promise<void>[] = [deleteStorageObject(existing.filePath)]
  if (existing.thumbPath) tasks.push(deleteStorageObject(existing.thumbPath))
  await Promise.all(tasks)
}
