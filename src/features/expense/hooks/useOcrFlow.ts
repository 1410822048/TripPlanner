// src/features/expense/hooks/useOcrFlow.ts
// Encapsulates the entire receipt-OCR lifecycle so the form modal
// doesn't have to juggle four pieces of state + an async pipeline.
//
// What it owns:
//   - lastFile           : the most recent File the user picked (camera or
//                          upload). Lets the manual "再讀取" button re-run
//                          OCR without re-uploading.
//   - loading            : true while compressImage + worker call are in flight
//   - error              : Japanese-localised error string (already mapped
//                          via OcrError kind → copy table). null on success
//                          or idle.
//
// What it does NOT own:
//   - The picked File's attachment lifecycle — that's `useAttachment`'s job
//     (Storage upload, blob URL, preview). This hook is purely about
//     "image bytes → items[]".
//   - Image compression — caller compresses the File before handing it in.
//     The form modal already pre-compresses at pick-time so the OCR upload
//     and the Storage upload share one small WebP, avoiding a duplicate
//     2-4s canvas re-encode on save.
//   - Where the result goes — caller's onSuccess populates form state.
//     Keeps the hook agnostic to which fields the OCR result maps to.
import { useEffect, useRef, useState } from 'react'
import { ocrReceipt, ocrExistingExpenseReceipt, OcrError, type OcrResult } from '../services/ocrService'

interface UseOcrFlowOptions {
  /** ISO 4217 currency code. Passed to Gemini as a hint when receipt
   *  symbols are ambiguous (e.g. "$" → USD/TWD/CAD). */
  currency: string
  /** Fires on successful parse — caller decides how to apply items /
   *  total / storeName to its own form state. */
  onSuccess: (result: OcrResult) => void
}

export interface UseOcrFlowResult {
  loading:  boolean
  error:    string | null
  /** Remembered for the "再讀取" button. Null when no file has been
   *  picked yet (or after `reset()`). */
  lastFile: File | null
  /** Milliseconds elapsed since the current `run()` started. Resets to
   *  0 on each new run and freezes at the final value on completion /
   *  error. Driven by a 100ms interval — fine-grained enough for a
   *  smooth-feeling "(3.2s)" counter, coarse enough to avoid wasted
   *  renders. Zero when idle. */
  elapsedMs: number
  /** Stash a file WITHOUT running OCR — used by the upload path which
   *  defers OCR to a manual button. */
  setFile:  (file: File | null) => void
  /** Compress (1920px WebP) → call worker → call onSuccess. Updates
   *  loading + error along the way. */
  run:      (file: File) => Promise<void>
  /** Re-OCR an EXISTING expense receipt (no freshly-picked File — the old
   *  receipt is only a URL). Worker reads receipt.path from the doc. Does
   *  NOT set `lastFile`, so the button keeps using this path on repeat
   *  clicks. `isStillApplicable` is the race guard: called with the
   *  response's receipt path + updatedAt right before applying; return
   *  false to discard a result for a swapped receipt / edited expense. */
  runExisting: (opts: {
    tripId:           string
    expenseId:        string
    currencyHint?:    string
    isStillApplicable: (sourceReceiptPath: string, expenseUpdatedAt?: string) => boolean
  }) => Promise<void>
  /** Reset everything — called when the user clears the receipt. */
  reset:    () => void
}

/** Friendly Japanese copy for OCR error categories. Lives inside the
 *  hook because the hook is the user-facing API; the underlying
 *  OcrError + kind enum stays as the lower-level machine signal. */
function ocrErrorCopy(e: OcrError): string {
  switch (e.kind) {
    case 'auth':       return 'セッションが切れました。再ログインしてください'
    case 'rate-limit': return '読み取りの回数制限に達しました。少し時間を置いてから再試行してください'
    case 'parse':      return 'レシートを読み取れませんでした。明るい場所で撮り直してみてください'
    case 'network':    return 'ネットワークエラー。接続を確認してください'
    case 'unavailable': return '読み取りサービスが混み合っています。少し時間を置いてからもう一度お試しください'
    case 'stale':      return '費用が更新されました。もう一度読み取ってください'
    case 'forbidden':  return 'この費用を編集する権限がありません。精算済みか、権限が変更された可能性があります'
    default:           return e.message || '読み取りに失敗しました'
  }
}

export function useOcrFlow({ currency, onSuccess }: UseOcrFlowOptions): UseOcrFlowResult {
  const [loading,   setLoading]   = useState(false)
  const [error,     setError]     = useState<string | null>(null)
  const [lastFile,  setLastFile]  = useState<File | null>(null)
  const [elapsedMs, setElapsedMs] = useState(0)

  // Tick elapsedMs every 100ms while loading. useRef holds the start
  // timestamp so the tick reads a stable reference even if React reorders
  // state updates. setInterval (not requestAnimationFrame) because:
  //   1) iOS Safari throttles rAF heavily when scrolling — and users
  //      scroll the form while OCR runs.
  //   2) 100ms feels smooth enough; rAF's 60fps would mean 16ms ticks
  //      = 6× more renders for no perceived benefit.
  const startedAtRef = useRef<number>(0)

  // Monotonic request token. Every run / runExisting / setFile / reset bumps
  // it; an in-flight OCR only applies its result (onSuccess / error / loading
  // release) when its captured seq is STILL the latest. This is the
  // correctness guard for the local-attachment race the server can't see:
  // the user fires "再読取" on a saved receipt, then immediately swaps in a
  // new image (or clears) — the persisted receipt.path is UNCHANGED, so the
  // server's sourceReceiptPath/updatedAt guard would pass and the stale
  // result would clobber the fresh draft. The seq bump on setFile/reset drops
  // it instead. (Complements the server post-check + isStillApplicable, which
  // cover changes to the PERSISTED doc.)
  const requestSeqRef = useRef(0)

  useEffect(() => {
    if (!loading) return
    const id = window.setInterval(() => {
      setElapsedMs(Date.now() - startedAtRef.current)
    }, 100)
    return () => window.clearInterval(id)
  }, [loading])

  const run = async (file: File): Promise<void> => {
    const seq = ++requestSeqRef.current
    setLastFile(file)
    startedAtRef.current = Date.now()
    setElapsedMs(0)
    setLoading(true)
    setError(null)
    try {
      const result = await ocrReceipt(file, currency)
      // Superseded by a newer run / setFile / reset → drop silently; the
      // current owner of `loading` will release it.
      if (seq !== requestSeqRef.current) return
      // Freeze elapsedMs at the actual completion time — the interval
      // tick may have lagged a beat behind, and we want the final
      // duration shown briefly (handy when debugging "why was it slow").
      setElapsedMs(Date.now() - startedAtRef.current)
      onSuccess(result)
    } catch (e) {
      if (seq !== requestSeqRef.current) return
      setElapsedMs(Date.now() - startedAtRef.current)
      setError(e instanceof OcrError ? ocrErrorCopy(e) : (e as Error).message)
    } finally {
      // Only the latest request controls the spinner — a superseded run must
      // NOT clear loading out from under the run that replaced it.
      if (seq === requestSeqRef.current) setLoading(false)
    }
  }

  const runExisting: UseOcrFlowResult['runExisting'] = async (opts) => {
    const seq = ++requestSeqRef.current
    startedAtRef.current = Date.now()
    setElapsedMs(0)
    setLoading(true)
    setError(null)
    try {
      const { result, sourceReceiptPath, expenseUpdatedAt } =
        await ocrExistingExpenseReceipt(opts.tripId, opts.expenseId, opts.currencyHint)
      // Superseded locally (new file picked / cleared) → drop. The persisted
      // receipt path may be UNCHANGED, so isStillApplicable below can't catch
      // this; only the seq can.
      if (seq !== requestSeqRef.current) return
      setElapsedMs(Date.now() - startedAtRef.current)
      if (!opts.isStillApplicable(sourceReceiptPath, expenseUpdatedAt)) {
        // The receipt was swapped, or the expense was edited elsewhere,
        // while the request was in flight — applying would write OCR for a
        // different image / over a stale draft. Discard + nudge a re-read.
        setError('費用が更新されました。もう一度読み取ってください')
        return
      }
      onSuccess(result)
    } catch (e) {
      if (seq !== requestSeqRef.current) return
      setElapsedMs(Date.now() - startedAtRef.current)
      setError(e instanceof OcrError ? ocrErrorCopy(e) : (e as Error).message)
    } finally {
      if (seq === requestSeqRef.current) setLoading(false)
    }
  }

  // Stash a file WITHOUT running OCR (upload path). Bumps the seq so an
  // in-flight OCR for the OLD image is dropped, and clears loading since no
  // new run auto-starts here (the user clicks 明細を読み取る to run).
  const setFile = (file: File | null): void => {
    requestSeqRef.current++
    setLastFile(file)
    setLoading(false)
  }

  const reset = () => {
    requestSeqRef.current++
    setLoading(false)
    setError(null)
    setLastFile(null)
    setElapsedMs(0)
  }

  return { loading, error, lastFile, elapsedMs, setFile, run, runExisting, reset }
}
