// src/hooks/useAttachment.ts
// Single-attachment lifecycle (existing + newly-picked + cleared) for
// any form modal whose entity carries one optional file. Replaces the
// booking-specific useBookingAttachment so booking + expense + future
// callers share the same state machine.
//
// What it owns:
//   - Existing slot (url / path / type from a doc being edited)
//   - Newly-picked File (transient until save)
//   - Blob URL lifecycle for the preview (auto-revoke on change)
//   - Size cap error (5MB, mirrors storage.rules)
//   - Tri-state diff for the service layer (undefined / null / File)
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

/** Mirrors storage.rules cap. Files larger than this are rejected. */
const MAX_FILE_BYTES = 5 * 1024 * 1024

/** Tri-state for the service-layer attachment param.
 *    undefined → unchanged
 *    null      → remove existing
 *    File      → replace / upload new
 */
export type AttachmentChange = File | null | undefined

export interface ExistingAttachment {
  url:  string | null
  path: string | null
  type: string | null
}

export interface UseAttachmentResult {
  hasAttachment:  boolean
  previewUrl:     string | null
  previewMime:    string | undefined
  previewIsImage: boolean
  attachmentName: string
  error:          string | null
  hasNewFile:     boolean
  pickFile:       (file: File) => void
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

  // Snapshot of the original path captured once on mount. Lets
  // pickAttachmentChange() distinguish "user cleared an existing
  // attachment" (return null) from "create-flow with nothing" (return
  // undefined) without the caller re-passing the editTarget.
  const originalPathRef = useRef(initial.path)

  // Blob URL lifecycle delegated to useBlobUrl — same create + revoke
  // semantics, just without inlining the useMemo + useEffect pair.
  const newFileBlobUrl = useBlobUrl(newFile)

  // Compiler memoises these. The useMemo above for blob URL stays
  // because it's paired with a cleanup effect (URL.revokeObjectURL) —
  // that's functional ownership, not just optimisation.
  const pickFile = (file: File) => {
    if (file.size > MAX_FILE_BYTES) {
      setError('ファイルサイズは 5MB 以下にしてください')
      return
    }
    setError(null)
    setNewFile(file)
  }

  const clear = () => {
    setNewFile(null)
    setExisting({ url: null, path: null, type: null })
    setError(null)
  }

  const pickAttachmentChange = (): AttachmentChange => {
    if (newFile) return newFile
    if (originalPathRef.current && !existing.path) return null
    return undefined
  }

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
