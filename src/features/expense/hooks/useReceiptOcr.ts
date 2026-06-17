// src/features/expense/hooks/useReceiptOcr.ts
// Feature-specific orchestration hook for the expense receipt OCR flow.
// Consolidates the four pieces ExpenseFormModal used to juggle inline:
//   - useReceiptOcrSource  — source state machine (none/preparing/fresh/
//                            existing) + sourceKey / analyzedSourceKey lifecycle
//   - useOcrFlow           — the bytes→items Worker pipeline + race guards
//   - compare state        — the /ocr-compare side feature (loading/error/result)
//   - pick handlers        — camera (auto-OCR) vs upload (stash) + image prep
//
// It also owns the pendingSourceKeyRef bookkeeping (which source key an
// in-flight OCR will mark analyzed on success) that previously leaked into the
// component as a bare ref + scattered markAnalyzed calls.
//
// DELIBERATELY NOT owned here (stays in the component — these are form domain,
// not OCR):
//   - applyOcrResult: how an OcrResult maps onto the form's sibling hooks
//     (items / money / splits / title / category / errors). Injected as a
//     callback; it THROWS on parse failure and we let that propagate exactly
//     like the inline version did (fresh path → useOcrFlow catches → error
//     banner; compare path → caught here → compareError).
//   - attachment / items / adjustments CLEAR: clearOcrOnly() resets only the
//     OCR / source / compare slices; the component composes the sibling clears.
import { useEffect, useRef, useState } from 'react'
import { useOcrFlow } from './useOcrFlow'
import {
  deriveReceiptOcrCapabilities,
  receiptOcrSourceKey,
  useReceiptOcrSource,
  type ExistingReceiptOcrSeed,
  type ExistingReceiptOcrSource,
  type ReceiptOcrSource,
  type ReceiptOcrSourceKey,
  type ReceiptOcrCapabilities,
} from './useReceiptOcrSource'
import {
  ocrCompareReceipt,
  ocrResultStillApplicable,
  OcrError,
  type OcrCompareResult,
  type OcrResult,
} from '../services/ocrService'
import { compressReceiptImage } from '@/utils/image'

export interface UseReceiptOcrInput {
  /** Source-seed for an existing expense's saved receipt (re-OCR target). */
  existingReceipt: ExistingReceiptOcrSeed
  /** Currency hint for FRESH captures — trip currency (no persisted currency
   *  exists yet). */
  tripCurrency: string
  /** Currency hint for re-OCR of a SAVED receipt + compare — the form's
   *  effective (foreign-aware) currency. Kept SEPARATE from tripCurrency to
   *  preserve the original asymmetry: fresh biases toward trip currency,
   *  existing biases toward the expense's already-known currency. */
  currencyHint: string
  fallbackEnabled: boolean
  compareEnabled: boolean
  /** Sibling reads needed only for capability derivation. */
  hasAttachment: boolean
  previewIsImage: boolean
  hasItems: boolean
  /** att.pickFile — returns false if the file was rejected (then we roll the
   *  prepared source back). */
  pickFile: (file: File) => boolean
  /** Apply an OcrResult onto the form's sibling hooks. THROWS on parse
   *  failure (fail-fast); callers here surface it per path. */
  applyOcrResult: (result: OcrResult) => void
}

export interface UseReceiptOcrResult {
  source: ReceiptOcrSource
  status: { loading: boolean; error: string | null; elapsedMs: number }
  caps: ReceiptOcrCapabilities
  compare: {
    loading: boolean
    error: string | null
    result: OcrCompareResult | null
    run: () => Promise<void>
    apply: (result: OcrResult) => void
  }
  handlers: {
    onCameraPicked: (e: React.ChangeEvent<HTMLInputElement>) => Promise<void>
    onUploadPicked: (e: React.ChangeEvent<HTMLInputElement>) => Promise<void>
    analyze: () => void
    fallback: () => void
    clearOcrOnly: () => void
  }
}

export function useReceiptOcr(input: UseReceiptOcrInput): UseReceiptOcrResult {
  const {
    existingReceipt, tripCurrency, currencyHint,
    fallbackEnabled, compareEnabled,
    hasAttachment, previewIsImage, hasItems,
    pickFile, applyOcrResult,
  } = input

  const receiptSource = useReceiptOcrSource(existingReceipt)
  const pendingSourceKeyRef = useRef<ReceiptOcrSourceKey | null>(null)

  const ocr = useOcrFlow({
    currency: tripCurrency,
    onSuccess: (result) => {
      applyOcrResult(result)
      // markAnalyzed only AFTER a successful apply — a parse-failure throw
      // propagates past this, so analyzedSourceKey stays put and caps keep
      // offering 「明細を読み取る」 for a retry.
      receiptSource.markAnalyzed(pendingSourceKeyRef.current)
      pendingSourceKeyRef.current = null
    },
  })

  const [compareLoading, setCompareLoading] = useState(false)
  const [compareError, setCompareError]     = useState<string | null>(null)
  const [compareResult, setCompareResult]   = useState<OcrCompareResult | null>(null)
  const compareSeqRef   = useRef(0)
  const compareAbortRef = useRef<AbortController | null>(null)

  useEffect(() => () => {
    compareSeqRef.current++
    compareAbortRef.current?.abort()
    compareAbortRef.current = null
  }, [])

  function resetCompare() {
    compareSeqRef.current++
    compareAbortRef.current?.abort()
    compareAbortRef.current = null
    setCompareLoading(false)
    setCompareError(null)
    setCompareResult(null)
  }

  // Pre-compress receipt images at pick-time into the same OCR-grade full image
  // that will be stored. Fresh OCR and future re-OCR then read the same
  // authoritative bytes instead of a low-quality preview derivative. HEIC / PDF
  // / decode failures fall through compressReceiptImage unchanged; catch()
  // swallows any unexpected throw so a quirky format never blocks attaching.
  async function prepareReceiptImage(f: File): Promise<File> {
    try {
      const { full } = await compressReceiptImage(f)
      return full
    } catch {
      return f
    }
  }

  // Two separate <input>s. We CAN'T detect "camera vs gallery" from a single
  // input, so the UX branches on which button was tapped:
  //   - camera button → capture=environment → auto-OCR on result
  //   - upload button → no capture → manual 「明細を読み取る」 button
  async function onCameraPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    const requestId = receiptSource.beginPreparing()
    resetCompare()
    ocr.cancel()
    const receipt = await prepareReceiptImage(f)
    if (!receiptSource.isCurrent(requestId)) return
    if (!pickFile(receipt)) {
      receiptSource.rejectPreparedFile(requestId)
      return
    }
    const source = receiptSource.commitPreparedFile(requestId, receipt)
    if (!source) return
    if (source.kind === 'fresh') {
      pendingSourceKeyRef.current = receiptOcrSourceKey(source)
      void ocr.run(source.file)
    }
    else ocr.setFile(null)
  }
  async function onUploadPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    const requestId = receiptSource.beginPreparing()
    resetCompare()
    ocr.cancel()
    const receipt = await prepareReceiptImage(f)
    if (!receiptSource.isCurrent(requestId)) return
    if (!pickFile(receipt)) {
      receiptSource.rejectPreparedFile(requestId)
      return
    }
    const source = receiptSource.commitPreparedFile(requestId, receipt)
    if (!source) return
    ocr.setFile(source.kind === 'fresh' ? source.file : null)
  }

  function runExistingReceiptOcr(
    source: ExistingReceiptOcrSource,
    useFallback: boolean,
    sourceKey: ReceiptOcrSourceKey | null,
  ) {
    // Race snapshot captured in receiptSource.source. The result is discarded
    // unless the Worker OCR'd the SAME receipt path AND, when both sides carry
    // it, the expense's updatedAt is unchanged.
    pendingSourceKeyRef.current = sourceKey
    void ocr.runExisting({
      tripId:       source.tripId,
      expenseId:    source.expenseId,
      // Hint the form's CURRENT currency (foreign code when this is a foreign
      // expense), not tripCurrency — re-OCRing a saved foreign receipt should
      // bias OCR toward the known currency rather than risk reparsing as trip.
      currencyHint,
      useFallback,
      isStillApplicable: (sourceReceiptPath, expenseUpdatedAt) =>
        ocrResultStillApplicable(
          { receiptPath: source.receiptPath, updatedAtMillis: source.updatedAtMillis },
          { sourceReceiptPath, expenseUpdatedAt },
        ),
    })
  }

  function analyze() {
    const source = receiptSource.source
    const sourceKey = receiptSource.sourceKey
    pendingSourceKeyRef.current = sourceKey
    if (source.kind === 'fresh') { void ocr.run(source.file); return }
    if (source.kind === 'existing') runExistingReceiptOcr(source, false, sourceKey)
  }

  function fallback() {
    const source = receiptSource.source
    const sourceKey = receiptSource.sourceKey
    pendingSourceKeyRef.current = sourceKey
    if (source.kind === 'fresh') { void ocr.runFallback(source.file); return }
    if (source.kind === 'existing') runExistingReceiptOcr(source, true, sourceKey)
  }

  async function runCompare() {
    if (receiptSource.source.kind !== 'fresh') return
    const file = receiptSource.source.file
    const seq = ++compareSeqRef.current
    compareAbortRef.current?.abort()
    const ac = new AbortController()
    compareAbortRef.current = ac
    setCompareLoading(true)
    setCompareError(null)
    setCompareResult(null)
    try {
      const result = await ocrCompareReceipt(file, currencyHint, ac.signal)
      if (seq !== compareSeqRef.current) return
      setCompareResult(result)
    } catch (e) {
      if (seq !== compareSeqRef.current) return
      setCompareError(e instanceof OcrError ? e.message : (e as Error).message)
    } finally {
      if (seq === compareSeqRef.current) setCompareLoading(false)
      if (compareAbortRef.current === ac) compareAbortRef.current = null
    }
  }

  function applyCompareResult(result: OcrResult) {
    try {
      applyOcrResult(result)
      receiptSource.markAnalyzed(receiptSource.sourceKey)
      setCompareError(null)
      setCompareResult(null)
    } catch (e) {
      setCompareError(e instanceof Error ? e.message : 'OCR結果を適用できませんでした')
    }
  }

  // OCR-only reset. The component's handleClearReceipt composes this with the
  // sibling clears (att / items / adjustments) it owns.
  function clearOcrOnly() {
    receiptSource.clear()
    resetCompare()
    ocr.reset()
    pendingSourceKeyRef.current = null
  }

  const caps = deriveReceiptOcrCapabilities({
    source:            receiptSource.source,
    sourceKey:         receiptSource.sourceKey,
    analyzedSourceKey: receiptSource.analyzedSourceKey,
    hasAttachment,
    previewIsImage,
    ocrLoading:        ocr.loading,
    hasItems,
    ocrError:          ocr.error,
    fallbackEnabled,
    compareEnabled,
  })

  return {
    source: receiptSource.source,
    status: { loading: ocr.loading, error: ocr.error, elapsedMs: ocr.elapsedMs },
    caps,
    compare: {
      loading: compareLoading,
      error:   compareError,
      result:  compareResult,
      run:     runCompare,
      apply:   applyCompareResult,
    },
    handlers: {
      onCameraPicked,
      onUploadPicked,
      analyze,
      fallback,
      clearOcrOnly,
    },
  }
}
