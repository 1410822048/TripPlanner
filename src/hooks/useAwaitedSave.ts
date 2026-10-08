// src/hooks/useAwaitedSave.ts
// A write that keeps its form open until it settles: the modal-wait saves
// (schedule / planning), their in-form deletes, and the expense / settlement
// saves whose FX rate is still provisional (so a 409 FX_RATE_CHANGED can be
// confirmed in place instead of losing the draft).
//
// The form INSTANCE owns the write, not the page. Every open is a fresh mount
// (the page renders the form only while open, keyed per target), so the
// instance is exactly "this open": closing unmounts it, and reopening even
// the same expense is a new instance. Busy state and the error banner are
// therefore local and die with it, and the outcome is routed at the moment
// it arrives:
//   - still open  → close on success; definitive failure shown in the form
//                   (or, without `describe`, left to the global toast)
//   - dismissed   → behaves like an optimistic-close save: the global
//                   MutationCache handler reports it (see `stillOpen`, sent
//                   as the mutation's `reportInForm`)
//   - ambiguous   → always the global "still confirming" toast; the form
//                   closes, since keeping the draft would invite saving it
//                   again under a new id while the first may have landed.
import { useEffect, useRef, useState } from 'react'
import { WorkerAmbiguous } from '@/services/workerBase'
import { userErrorMessage } from '@/utils/errorMessage'

/** The default banner for a failed save. */
export function describeSaveFailure(err: unknown): string {
  return userErrorMessage(err, '儲存失敗')
}

export interface AwaitedSave {
  /** True while this form's write is in flight. */
  saving:    boolean
  /** Banner for a definitive failure of this form's last write. */
  error:     string | null
  /** Whether this form instance is still open — evaluated when the write
   *  settles, so a form dismissed mid-write hands its outcome to the global
   *  handler instead of swallowing it. Pass it as the mutation's
   *  `reportInForm`. */
  stillOpen: () => boolean
  /** Run one write attempt for this form.
   *   - Ignored while another write of this form is in flight: a save and
   *     an in-form delete share this gate, so they can never race.
   *   - Clears the previous failure banner first: whatever this attempt
   *     turns into (the page refusing it synchronously, or a new write) is
   *     now the newest word, and a stale failure must not cover it.
   *   - When `run` returns a promise (a write was issued) it is tracked;
   *     `describe` turns a definitive failure into the banner text and may
   *     react to it (e.g. adopt a new rate). Omit `describe` when the global
   *     toast already reports failures — the form then only closes itself
   *     on success. */
  submit:    (run: () => void | Promise<unknown>, describe?: (err: unknown) => string) => void
}

/** Instance liveness. Built outside the hook so `stillOpen` closes over
 *  this one boolean only: the predicate travels in mutation variables,
 *  which TanStack keeps in the MutationCache after settling — it must not
 *  pin the form's whole render scope (setters, onClose) there. */
function createLiveness() {
  let open = true
  return {
    stillOpen: () => open,
    /** Mount effect: open while mounted (re-armed on StrictMode remount). */
    attach:    () => {
      open = true
      return () => { open = false }
    },
  }
}

export function useAwaitedSave(onClose: () => void): AwaitedSave {
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState<string | null>(null)
  // Created once per instance; read only from event handlers and async
  // callbacks, flipped only by the mount effect.
  const [{ stillOpen, attach }] = useState(createLiveness)
  useEffect(attach, [attach])
  // In-flight gate: a ref, not `saving`, so a same-tick second tap sees it
  // before any re-render.
  const inFlight = useRef(false)

  async function track(pending: Promise<unknown>, describe?: (err: unknown) => string) {
    inFlight.current = true
    setSaving(true)
    try {
      await pending
      if (stillOpen()) onClose()
    } catch (err) {
      if (!stillOpen()) return            // dismissed: reported globally
      if (err instanceof WorkerAmbiguous) { onClose(); return }
      if (describe) setError(describe(err))
    } finally {
      inFlight.current = false
      if (stillOpen()) setSaving(false)
    }
  }

  function submit(run: () => void | Promise<unknown>, describe?: (err: unknown) => string) {
    if (inFlight.current) return
    setError(null)
    const pending = run()
    if (pending) void track(pending, describe)
  }

  return { saving, error, stillOpen, submit }
}
