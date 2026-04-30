// src/features/bookings/hooks/useBookingAttachment.ts
// Encapsulates the tri-state attachment lifecycle the form modal cares
// about: an optional existing file (URL + storage path + mime), an
// optional newly-picked File, and a transient size-error message. Also
// owns blob-URL creation / revocation for previewing the picked file
// before it's uploaded.
//
// Callers (BookingFormModal) get a small bag of values + actions and
// don't have to track 5 useStates by hand. The form's `attachment` arg
// for save is computed by the caller from `pickAttachmentChange()` so
// the tri-state mapping (undefined / null / File) stays in one place.
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Booking } from '@/types'

const MAX_FILE_BYTES = 5 * 1024 * 1024  // mirrors storage.rules cap

/** Tri-state for the service-layer attachment param.
 *    undefined → unchanged
 *    null      → remove existing
 *    File      → replace / upload new
 */
export type AttachmentChange = File | null | undefined

interface ExistingAttachment {
  url:  string | null
  path: string | null
  type: string | null
}

export interface UseBookingAttachmentResult {
  /** True when there's something (existing OR newly picked) to display. */
  hasAttachment: boolean
  /** Blob URL for newly picked file, or the existing download URL. */
  previewUrl:    string | null
  /** Mime type for routing image vs PDF rendering. */
  previewMime:   string | undefined
  previewIsImage: boolean
  /** User-friendly filename (picked file name, or trailing path segment). */
  attachmentName: string
  /** Size-cap error message, or null when valid / no error. */
  error:         string | null
  /** Whether the user has any picked-but-unsaved File. */
  hasNewFile:    boolean

  /** Replace existing with a newly picked file. Validates size cap. */
  pickFile:      (file: File) => void
  /** Drop both new and existing — for the X button. */
  clear:         () => void

  /**
   * Compute the tri-state arg for bookingService.updateBooking. The
   * caller passes `editTarget` so we can tell "removed an existing
   * attachment" (null) apart from "create-flow with no attachment"
   * (undefined).
   */
  pickAttachmentChange: (editTarget: Booking | null) => AttachmentChange
}

/** Initialise from an existing booking when editing, or empty when creating. */
function initFromBooking(b: Booking | null): ExistingAttachment {
  return {
    url:  b?.fileUrl  ?? null,
    path: b?.filePath ?? null,
    type: b?.fileType ?? null,
  }
}

export function useBookingAttachment(editTarget: Booking | null): UseBookingAttachmentResult {
  // Existing attachment slot — seeded from editTarget; cleared on "remove".
  // Stored as state (not ref) so React 19's ref-purity lint stays happy and
  // updates render correctly when the user clicks the X to remove.
  const [existing, setExisting] = useState<ExistingAttachment>(() => initFromBooking(editTarget))
  const [newFile,  setNewFile]  = useState<File | null>(null)
  const [error,    setError]    = useState<string | null>(null)

  // Memoised blob URL for the newly-picked file. Revoked on change /
  // unmount so we don't leak. The previous render's URL stays alive
  // until the next effect cleanup runs (which captures the old value
  // in its closure).
  const newFileBlobUrl = useMemo(
    () => newFile ? URL.createObjectURL(newFile) : null,
    [newFile],
  )
  useEffect(() => {
    if (!newFileBlobUrl) return
    return () => URL.revokeObjectURL(newFileBlobUrl)
  }, [newFileBlobUrl])

  const pickFile = useCallback((file: File) => {
    if (file.size > MAX_FILE_BYTES) {
      setError('ファイルサイズは 5MB 以下にしてください')
      return
    }
    setError(null)
    setNewFile(file)
  }, [])

  const clear = useCallback(() => {
    setNewFile(null)
    setExisting({ url: null, path: null, type: null })
    setError(null)
  }, [])

  const existingPath = existing.path
  const pickAttachmentChange = useCallback((target: Booking | null): AttachmentChange => {
    if (newFile) return newFile
    if (target?.filePath && !existingPath) return null
    return undefined
  }, [newFile, existingPath])

  const previewUrl  = newFileBlobUrl ?? existing.url
  const previewMime = newFile ? newFile.type : (existing.type ?? undefined)

  return {
    hasAttachment:  !!newFile || !!existing.url,
    previewUrl,
    previewMime,
    previewIsImage: (previewMime ?? '').startsWith('image/'),
    attachmentName: newFile?.name
      ?? (existing.path ? existing.path.split('/').pop() : null)
      ?? '添付ファイル',
    error,
    hasNewFile:     !!newFile,
    pickFile,
    clear,
    pickAttachmentChange,
  }
}
