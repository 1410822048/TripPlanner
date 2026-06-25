// src/hooks/useAttachment.ts
// Single-attachment lifecycle (existing + newly-picked + cleared) for
// any form modal whose entity carries one optional file. Replaces the
// booking-specific useBookingAttachment so booking + expense + future
// callers share the same state machine.
//
// What it owns:
//   - Existing slot (previewPath / fullPath / type from a doc being edited)
//   - Newly-picked File (transient until save)
//   - Blob URL lifecycle for the preview (auto-revoke on change)
//   - Size cap error (5MB, mirrors storage.rules)
//   - Tri-state diff for the service layer (undefined / null / File)
//
// path-only: the existing attachment is identified by Storage PATHS, not a
// bearer download URL. The small `previewPath` (thumbPath) drives the form-
// row thumbnail; the `fullPath` is what the caller resolves for the full-
// size / PDF preview modal.
//
// What it doesn't own:
//   - The user-facing file picker UI (caller wires <input type="file">)
//   - Upload / Storage paths (service layer's concern)
//   - Crop-before-commit (compose with useImageCropFlow)
//
// Mount semantics: form modals re-key per editTarget so this hook
// re-initialises naturally. `originalPath` snapshots the initial path
// on first render so `pickAttachmentChange()` can tell "user cleared
// what was there" apart from "create-flow with no attachment".
import { useRef, useState } from 'react'
import { useBlobUrl } from './useBlobUrl'
import { useAttachmentUrl } from './useAttachmentUrl'

/** Mirrors storage.rules cap. Files larger than this are rejected. */
const MAX_FILE_BYTES = 5 * 1024 * 1024
export const ATTACHMENT_SIZE_ERROR = 'ファイルサイズは 5MB 以下にしてください'

/** Tri-state for the service-layer attachment param.
 *    undefined → unchanged
 *    null      → remove existing
 *    File      → replace / upload new
 */
export type AttachmentChange = File | null | undefined

export interface ExistingAttachment {
  /** Real thumb path ONLY for the form-row thumbnail — do NOT fall back to
   *  the full path (that would pull the full blob into the thumb cache for
   *  thumb-less / PDF attachments). null → row shows the file icon. */
  previewPath: string | null
  /** Full-size object path for the preview modal / PDF open. */
  fullPath:    string | null
  type:        string | null
}

export interface UseAttachmentResult {
  hasAttachment:  boolean
  /** Thumbnail-sized preview URL for the form row (`<img>`). */
  previewUrl:     string | null
  previewMime:    string | undefined
  previewIsImage: boolean
  /** Full-size object path of the EXISTING attachment (null when none /
   *  cleared). The caller resolves this via `useAttachmentUrl(_, 'full')`
   *  when opening the preview modal; for a newly-picked file it uses
   *  `previewUrl` (the local blob) instead. */
  fullPath:       string | null
  attachmentName: string
  error:          string | null
  newFile:        File | null
  hasNewFile:     boolean
  pickFile:       (file: File) => boolean
  clear:          () => void
  /** Diff to send to the service. No args needed — the hook snapshots
   *  the original path at mount so it can detect "user removed what
   *  was there" without the caller passing it again. */
  pickAttachmentChange: () => AttachmentChange
}

export function useAttachment(initial: ExistingAttachment): UseAttachmentResult {
  // Existing slot — seeded from initial; cleared when user removes.
  // Stored as state (not ref) so React 19's ref-purity lint stays happy
  // and updates render correctly when the user clicks the X to remove.
  const [existing, setExisting] = useState<ExistingAttachment>(() => initial)
  const [newFile,  setNewFile]  = useState<File | null>(null)
  const [error,    setError]    = useState<string | null>(null)

  // Snapshot of the original full path captured once on mount. Lets
  // pickAttachmentChange() distinguish "user cleared an existing
  // attachment" (return null) from "create-flow with nothing" (return
  // undefined) without the caller re-passing the editTarget.
  const originalPathRef = useRef(initial.fullPath)

  // Blob URL lifecycle delegated to useBlobUrl — same create + revoke
  // semantics, just without inlining the useMemo + useEffect pair.
  const newFileBlobUrl = useBlobUrl(newFile)

  // path-only: resolve the EXISTING attachment's thumbnail for the form-
  // row preview via getBlob (Storage Rules). The new-file blob (above)
  // takes priority when present.
  const existingThumbUrl = useAttachmentUrl(existing.previewPath ?? undefined, { kind: 'thumb' })

  // Compiler memoises these. The useMemo above for blob URL stays
  // because it's paired with a cleanup effect (URL.revokeObjectURL) —
  // that's functional ownership, not just optimisation.
  const pickFile = (file: File): boolean => {
    if (file.size > MAX_FILE_BYTES) {
      setError(ATTACHMENT_SIZE_ERROR)
      return false
    }
    setError(null)
    setNewFile(file)
    return true
  }

  const clear = () => {
    setNewFile(null)
    setExisting({ previewPath: null, fullPath: null, type: null })
    setError(null)
  }

  const pickAttachmentChange = (): AttachmentChange => {
    if (newFile) return newFile
    if (originalPathRef.current && !existing.fullPath) return null
    return undefined
  }

  const previewUrl  = newFileBlobUrl ?? existingThumbUrl
  const previewMime = newFile ? newFile.type : (existing.type ?? undefined)

  return {
    hasAttachment:  !!newFile || !!existing.fullPath,
    previewUrl,
    previewMime,
    previewIsImage: (previewMime ?? '').startsWith('image/'),
    fullPath:       existing.fullPath,
    attachmentName: newFile?.name
      ?? (existing.fullPath ? existing.fullPath.split('/').pop() : null)
      ?? '添付ファイル',
    error,
    newFile,
    hasNewFile:     !!newFile,
    pickFile,
    clear,
    pickAttachmentChange,
  }
}
