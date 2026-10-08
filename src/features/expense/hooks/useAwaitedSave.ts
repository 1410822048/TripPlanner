// src/features/expense/hooks/useAwaitedSave.ts
// A save that keeps its form open until the Worker answers — used when the
// shown FX rate is still provisional, so a 409 FX_RATE_CHANGED can be
// confirmed in place instead of losing the draft.
//
// The form INSTANCE owns the save, not the page. Every open is a fresh mount
// (the page renders the form only while open, keyed per target), so the
// instance is exactly "this open": closing unmounts it, and reopening even
// the same expense is a new instance. Busy state and the error banner are
// therefore local and die with it, and the outcome is routed at the moment
// it arrives:
//   - still open  → close on success; definitive failure shown in the form
//   - dismissed   → behaves like an optimistic-close save: the global
//                   MutationCache handler reports it (see `stillOpen`, sent
//                   as the mutation's `reportInForm`)
//   - ambiguous   → always the global "still confirming" toast; the form
//                   closes, since keeping the draft would invite saving it
//                   again under a new id while the first may have landed.
import { useEffect, useRef, useState } from 'react'
import { WorkerAmbiguous } from '@/services/workerBase'

export interface AwaitedSave {
  /** True while this form's save is in flight. */
  saving:    boolean
  /** Banner for a definitive failure of this form's save. */
  error:     string | null
  /** Whether this form instance is still open — evaluated when the save
   *  settles, so a form dismissed mid-save hands its outcome to the global
   *  handler instead of swallowing it. */
  stillOpen: () => boolean
  /** Track `pending` for this form. `describe` turns a definitive failure
   *  into the banner text (and may react to it, e.g. adopt a new rate); it
   *  runs only while the form is still open. */
  track:     (pending: Promise<unknown>, describe: (err: unknown) => string) => Promise<void>
}

export function useAwaitedSave(onClose: () => void): AwaitedSave {
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState<string | null>(null)
  // Instance liveness, read only from async callbacks (never during render).
  const open = useRef(true)
  useEffect(() => {
    open.current = true
    return () => { open.current = false }
  }, [])

  const stillOpen = () => open.current

  async function track(pending: Promise<unknown>, describe: (err: unknown) => string) {
    setSaving(true)
    setError(null)
    try {
      await pending
      if (open.current) onClose()
    } catch (err) {
      if (!open.current) return            // dismissed: reported globally
      if (err instanceof WorkerAmbiguous) { onClose(); return }
      setError(describe(err))
    } finally {
      if (open.current) setSaving(false)
    }
  }

  return { saving, error, stillOpen, track }
}
