// Focused unit tests for useReceiptOcr — the parts ExpenseFormModal.test.tsx
// does NOT reach:
//   - the /ocr-compare sub-feature (compareEnabled is env-gated OFF in the
//     component tests, so compare.run / compare.apply never execute there)
//   - clearOcrOnly's layering (resets OCR/source/compare only)
//   - the pick-handler auto-run vs stash split, asserted at the hook seam
//
// The camera/upload/dispatch/race paths run for REAL through this hook inside
// ExpenseFormModal.test.tsx (which mocks the same useOcrFlow + image seam), so
// those stay covered there as integration. Here we mock useOcrFlow +
// ocrCompareReceipt + compressReceiptImage; useReceiptOcrSource runs for real.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { ChangeEvent } from 'react'

const ocrApi = vi.hoisted(() => ({
  run: vi.fn(), runFallback: vi.fn(), runExisting: vi.fn(),
  cancel: vi.fn(), setFile: vi.fn(), reset: vi.fn(),
  onSuccess: null as ((result: unknown) => void) | null,
}))
const compareApi = vi.hoisted(() => ({ ocrCompareReceipt: vi.fn() }))
const imageApi = vi.hoisted(() => ({
  compressReceiptImage: vi.fn(async (file: File) => ({ full: file })),
}))

vi.mock('./useOcrFlow', () => ({
  useOcrFlow: (opts: { onSuccess: (result: unknown) => void }) => {
    ocrApi.onSuccess = opts.onSuccess
    return {
      loading: false, error: null, elapsedMs: 0, lastFile: null,
      run: ocrApi.run, runFallback: ocrApi.runFallback, runExisting: ocrApi.runExisting,
      cancel: ocrApi.cancel, setFile: ocrApi.setFile, reset: ocrApi.reset,
    }
  },
}))
vi.mock('../services/ocrService', async () => {
  // Keep OcrError + ocrResultStillApplicable + the isOcrSupported* guards real
  // (useReceiptOcrSource depends on the guards); only stub the network call.
  const actual = await vi.importActual<typeof import('../services/ocrService')>('../services/ocrService')
  return { ...actual, ocrCompareReceipt: compareApi.ocrCompareReceipt }
})
vi.mock('@/utils/image', async () => {
  const actual = await vi.importActual<typeof import('@/utils/image')>('@/utils/image')
  return { ...actual, compressReceiptImage: imageApi.compressReceiptImage }
})

import { useReceiptOcr, type UseReceiptOcrInput } from './useReceiptOcr'
import type { OcrCompareResult, OcrResult } from '../services/ocrService'

function baseInput(over: Partial<UseReceiptOcrInput> = {}): UseReceiptOcrInput {
  return {
    existingReceipt: {},        // no saved receipt → source starts 'none'
    tripCurrency:    'JPY',
    currencyHint:    'JPY',
    fallbackEnabled: true,
    compareEnabled:  true,
    hasAttachment:   true,
    previewIsImage:  true,
    hasItems:        false,
    pickFile:        vi.fn(() => true),
    applyOcrResult:  vi.fn(),
    ...over,
  }
}

const fileEvent = (file: File) =>
  ({ target: { files: [file], value: '' } } as unknown as ChangeEvent<HTMLInputElement>)

const okResult = (): OcrResult => ({
  items: [{ name: 'A', amountText: '100' }], adjustments: [], ignoredLines: [], totalText: '100',
})

beforeEach(() => {
  ocrApi.run.mockReset(); ocrApi.runFallback.mockReset(); ocrApi.runExisting.mockReset()
  ocrApi.cancel.mockReset(); ocrApi.setFile.mockReset(); ocrApi.reset.mockReset()
  ocrApi.onSuccess = null
  compareApi.ocrCompareReceipt.mockReset()
  imageApi.compressReceiptImage.mockReset()
  imageApi.compressReceiptImage.mockImplementation(async (file: File) => ({ full: file }))
})

describe('useReceiptOcr — pick handlers', () => {
  it('onUploadPicked stashes the file without auto-running OCR', async () => {
    const { result } = renderHook(() => useReceiptOcr(baseInput()))
    const file = new File(['x'], 'r.webp', { type: 'image/webp' })

    await act(async () => { await result.current.handlers.onUploadPicked(fileEvent(file)) })

    expect(ocrApi.setFile).toHaveBeenCalledWith(file)
    expect(ocrApi.run).not.toHaveBeenCalled()
  })

  it('onCameraPicked auto-runs OCR on the prepared file', async () => {
    const { result } = renderHook(() => useReceiptOcr(baseInput()))
    const file = new File(['x'], 'r.webp', { type: 'image/webp' })

    await act(async () => { await result.current.handlers.onCameraPicked(fileEvent(file)) })

    expect(ocrApi.run).toHaveBeenCalledWith(file)
  })
})

describe('useReceiptOcr — compare', () => {
  it('compare.run drops a superseded result (seq guard)', async () => {
    const resultB = { tag: 'B' } as unknown as OcrCompareResult
    let resolveA!: (value: unknown) => void
    compareApi.ocrCompareReceipt
      .mockImplementationOnce(() => new Promise(resolve => { resolveA = resolve }))
      .mockResolvedValueOnce(resultB)

    const { result } = renderHook(() => useReceiptOcr(baseInput()))
    await act(async () => {
      await result.current.handlers.onUploadPicked(fileEvent(new File(['x'], 'r.webp', { type: 'image/webp' })))
    })

    // First compare in flight; the second supersedes it and lands.
    act(() => { void result.current.compare.run() })
    await act(async () => { await result.current.compare.run() })
    expect(result.current.compare.result).toBe(resultB)

    // The stale first compare resolving must NOT clobber the latest result.
    await act(async () => { resolveA({ tag: 'A' }); await Promise.resolve() })
    expect(result.current.compare.result).toBe(resultB)
  })

  it('compare.apply surfaces a parse failure as compareError (no throw)', () => {
    const applyOcrResult = vi.fn(() => { throw new Error('JPY grammar') })
    const { result } = renderHook(() => useReceiptOcr(baseInput({ applyOcrResult })))

    act(() => { result.current.compare.apply(okResult()) })

    expect(applyOcrResult).toHaveBeenCalledTimes(1)
    expect(result.current.compare.error).toMatch(/JPY grammar/)
  })

  it('compare.apply applies the result and clears compare state on success', () => {
    const applyOcrResult = vi.fn()
    const { result } = renderHook(() => useReceiptOcr(baseInput({ applyOcrResult })))
    const r = okResult()

    act(() => { result.current.compare.apply(r) })

    expect(applyOcrResult).toHaveBeenCalledWith(r)
    expect(result.current.compare.error).toBeNull()
    expect(result.current.compare.result).toBeNull()
  })
})

describe('useReceiptOcr — clearOcrOnly', () => {
  it('resets the OCR flow and wipes compare state', () => {
    const applyOcrResult = vi.fn(() => { throw new Error('boom') })
    const { result } = renderHook(() => useReceiptOcr(baseInput({ applyOcrResult })))

    act(() => { result.current.compare.apply(okResult()) })
    expect(result.current.compare.error).toMatch(/boom/)

    act(() => { result.current.handlers.clearOcrOnly() })

    expect(ocrApi.reset).toHaveBeenCalledTimes(1)
    expect(result.current.compare.error).toBeNull()
  })
})
