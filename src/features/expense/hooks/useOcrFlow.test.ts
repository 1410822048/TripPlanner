// Hook-level tests for useOcrFlow's monotonic request guard — the subtlest
// new logic in the re-OCR work and the easiest to break on a refactor. The
// network seam (ocrReceipt / ocrExistingExpenseReceipt) is mocked with
// hand-controlled deferred promises so we can interleave requests and assert
// that ONLY the latest one applies (onSuccess / error / loading release).
//
// OcrError + the copy table stay REAL (vi.importActual) so the error-mapping
// path is exercised end-to-end.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

vi.mock('../services/ocrService', async () => {
  const actual = await vi.importActual<typeof import('../services/ocrService')>('../services/ocrService')
  return { ...actual, ocrReceipt: vi.fn(), ocrExistingExpenseReceipt: vi.fn() }
})

import { useOcrFlow } from './useOcrFlow'
import { ocrReceipt, ocrExistingExpenseReceipt, OcrError, type OcrResult } from '../services/ocrService'

/** A promise whose resolve/reject we trigger from the test body, so we can
 *  hold a request "in flight" and resolve requests out of start-order. */
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!:  (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** Flush the microtask queue inside act() so the hook's post-await state
 *  updates (onSuccess / setError / setLoading) are captured by React. */
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve() })

const RESULT = (tag: string): OcrResult => ({
  items: [{ name: tag, amountText: '100' }], adjustments: [], ignoredLines: [], totalText: '100',
})
const file = (name: string) => new File(['x'], name, { type: 'image/jpeg' })

function setup() {
  const onSuccess = vi.fn()
  const view = renderHook(() => useOcrFlow({ currency: 'JPY', onSuccess }))
  return { onSuccess, view }
}

beforeEach(() => { vi.resetAllMocks() })

describe('useOcrFlow — single request lifecycle', () => {
  it('run() → loading true → onSuccess(result) → loading false', async () => {
    const d = deferred<OcrResult>()
    vi.mocked(ocrReceipt).mockReturnValueOnce(d.promise)
    const { onSuccess, view } = setup()

    act(() => { void view.result.current.run(file('a.jpg')) })
    expect(view.result.current.loading).toBe(true)
    expect(view.result.current.lastFile?.name).toBe('a.jpg')

    d.resolve(RESULT('coffee'))
    await flush()

    expect(onSuccess).toHaveBeenCalledTimes(1)
    expect(onSuccess).toHaveBeenCalledWith(expect.objectContaining({ totalText: '100' }))
    expect(view.result.current.loading).toBe(false)
    expect(view.result.current.error).toBeNull()
  })

  it('run() rejecting an OcrError → mapped Japanese copy, loading false', async () => {
    const d = deferred<OcrResult>()
    vi.mocked(ocrReceipt).mockReturnValueOnce(d.promise)
    const { onSuccess, view } = setup()

    act(() => { void view.result.current.run(file('a.jpg')) })
    d.reject(new OcrError('rate', 'rate-limit'))
    await flush()

    expect(onSuccess).not.toHaveBeenCalled()
    expect(view.result.current.error).toMatch(/回数制限/)
    expect(view.result.current.loading).toBe(false)
  })
})

describe('useOcrFlow — monotonic seq guard', () => {
  it('a newer run supersedes an older one: stale result dropped, loading owned by the newer run', async () => {
    const dA = deferred<OcrResult>()
    const dB = deferred<OcrResult>()
    vi.mocked(ocrReceipt).mockReturnValueOnce(dA.promise).mockReturnValueOnce(dB.promise)
    const { onSuccess, view } = setup()

    act(() => { void view.result.current.run(file('A.jpg')) }) // seq 1
    act(() => { void view.result.current.run(file('B.jpg')) }) // seq 2 — supersedes
    expect(view.result.current.loading).toBe(true)

    // Stale request A resolves FIRST — must be dropped, and must NOT clear the
    // spinner out from under B.
    dA.resolve(RESULT('stale-A'))
    await flush()
    expect(onSuccess).not.toHaveBeenCalled()
    expect(view.result.current.loading).toBe(true)

    // Latest request B resolves → it alone applies + releases loading.
    dB.resolve(RESULT('fresh-B'))
    await flush()
    expect(onSuccess).toHaveBeenCalledTimes(1)
    expect(onSuccess).toHaveBeenCalledWith(expect.objectContaining({ items: [expect.objectContaining({ name: 'fresh-B' })] }))
    expect(view.result.current.loading).toBe(false)
  })

  it('a stale rejection is dropped too (no error banner from a superseded run)', async () => {
    const dA = deferred<OcrResult>()
    const dB = deferred<OcrResult>()
    vi.mocked(ocrReceipt).mockReturnValueOnce(dA.promise).mockReturnValueOnce(dB.promise)
    const { onSuccess, view } = setup()

    act(() => { void view.result.current.run(file('A.jpg')) })
    act(() => { void view.result.current.run(file('B.jpg')) })

    dA.reject(new OcrError('boom', 'parse')) // stale failure — must NOT surface
    await flush()
    expect(view.result.current.error).toBeNull()

    dB.resolve(RESULT('B'))
    await flush()
    expect(onSuccess).toHaveBeenCalledTimes(1)
    expect(view.result.current.error).toBeNull()
  })

  it('setFile() invalidates an in-flight runExisting (persisted path unchanged → only seq can catch it)', async () => {
    const d = deferred<{ result: OcrResult; sourceReceiptPath: string; expenseUpdatedAt?: string }>()
    vi.mocked(ocrExistingExpenseReceipt).mockReturnValueOnce(d.promise)
    const { onSuccess, view } = setup()

    act(() => {
      void view.result.current.runExisting({
        tripId: 't', expenseId: 'e',
        isStillApplicable: () => true, // the persisted path/updatedAt still "match"
      })
    })
    expect(view.result.current.loading).toBe(true)

    // User swaps in a new local image mid-flight (upload path → setFile).
    act(() => { view.result.current.setFile(file('new.jpg')) })
    expect(view.result.current.lastFile?.name).toBe('new.jpg')
    expect(view.result.current.loading).toBe(false)

    // The OLD re-OCR resolves — even though isStillApplicable would say true,
    // the seq bump from setFile drops it so it can't clobber the new draft.
    d.resolve({ result: RESULT('OLD'), sourceReceiptPath: 'trips/t/expenses/e/receipt.webp' })
    await flush()
    expect(onSuccess).not.toHaveBeenCalled()
    expect(view.result.current.error).toBeNull()
    expect(view.result.current.loading).toBe(false)
  })

  it('reset() invalidates an in-flight runExisting and clears all state', async () => {
    const d = deferred<{ result: OcrResult; sourceReceiptPath: string; expenseUpdatedAt?: string }>()
    vi.mocked(ocrExistingExpenseReceipt).mockReturnValueOnce(d.promise)
    const { onSuccess, view } = setup()

    act(() => {
      void view.result.current.runExisting({ tripId: 't', expenseId: 'e', isStillApplicable: () => true })
    })
    act(() => { view.result.current.reset() })
    expect(view.result.current.lastFile).toBeNull()
    expect(view.result.current.loading).toBe(false)

    d.resolve({ result: RESULT('OLD'), sourceReceiptPath: 'p' })
    await flush()
    expect(onSuccess).not.toHaveBeenCalled()
    expect(view.result.current.error).toBeNull()
  })
})

describe('useOcrFlow — runExisting applicability', () => {
  it('isStillApplicable=false → stale copy, onSuccess NOT called', async () => {
    vi.mocked(ocrExistingExpenseReceipt).mockResolvedValueOnce({
      result: RESULT('x'), sourceReceiptPath: 'trips/t/expenses/e/receipt-v2.webp', expenseUpdatedAt: '2026-06-04T08:00:00Z',
    })
    const { onSuccess, view } = setup()

    await act(async () => {
      await view.result.current.runExisting({ tripId: 't', expenseId: 'e', isStillApplicable: () => false })
    })

    expect(onSuccess).not.toHaveBeenCalled()
    expect(view.result.current.error).toMatch(/費用が更新されました/)
  })

  it('isStillApplicable=true (latest) → onSuccess applies the result', async () => {
    vi.mocked(ocrExistingExpenseReceipt).mockResolvedValueOnce({
      result: RESULT('apply'), sourceReceiptPath: 'p', expenseUpdatedAt: '2026-06-04T08:00:00Z',
    })
    const { onSuccess, view } = setup()

    await act(async () => {
      await view.result.current.runExisting({ tripId: 't', expenseId: 'e', isStillApplicable: () => true })
    })

    expect(onSuccess).toHaveBeenCalledTimes(1)
    expect(view.result.current.loading).toBe(false)
    // runExisting must NOT stash a lastFile (it has no local File — repeat
    // clicks keep using the existing-receipt path, not run()).
    expect(view.result.current.lastFile).toBeNull()
  })
})
