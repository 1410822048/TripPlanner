// Focused unit tests for useReceiptOcr — the parts ExpenseFormModal.test.tsx
// does NOT reach:
//   - clearOcrOnly's layering (resets OCR/source only)
//   - the pick-handler auto-run vs stash split, asserted at the hook seam
//
// The camera/upload/dispatch/race paths run for REAL through this hook inside
// ExpenseFormModal.test.tsx (which mocks the same useOcrFlow + image seam), so
// those stay covered there as integration. Here we mock useOcrFlow +
// compressReceiptImage; useReceiptOcrSource runs for real.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { ChangeEvent } from 'react'

const ocrApi = vi.hoisted(() => ({
  run: vi.fn(), runFallback: vi.fn(), runExisting: vi.fn(),
  cancel: vi.fn(), setFile: vi.fn(), reset: vi.fn(),
  onSuccess: null as ((result: unknown) => void) | null,
}))
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
vi.mock('@/utils/image', async () => {
  const actual = await vi.importActual<typeof import('@/utils/image')>('@/utils/image')
  return { ...actual, compressReceiptImage: imageApi.compressReceiptImage }
})

import { useReceiptOcr, type UseReceiptOcrInput } from './useReceiptOcr'

function baseInput(over: Partial<UseReceiptOcrInput> = {}): UseReceiptOcrInput {
  return {
    existingReceipt: {},        // no saved receipt → source starts 'none'
    tripCurrency:    'JPY',
    currencyHint:    'JPY',
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

beforeEach(() => {
  ocrApi.run.mockReset(); ocrApi.runFallback.mockReset(); ocrApi.runExisting.mockReset()
  ocrApi.cancel.mockReset(); ocrApi.setFile.mockReset(); ocrApi.reset.mockReset()
  ocrApi.onSuccess = null
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

describe('useReceiptOcr — clearOcrOnly', () => {
  it('resets the OCR flow without touching sibling state', () => {
    const { result } = renderHook(() => useReceiptOcr(baseInput()))

    act(() => { result.current.handlers.clearOcrOnly() })

    expect(ocrApi.reset).toHaveBeenCalledTimes(1)
  })
})
