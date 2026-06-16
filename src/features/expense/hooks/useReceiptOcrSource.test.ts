import { describe, it, expect } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import {
  deriveExistingReceiptOcrSource,
  deriveReceiptOcrCapabilities,
  useReceiptOcrSource,
} from './useReceiptOcrSource'

const jpeg = (name: string) => new File(['x'], name, { type: 'image/jpeg' })
const heic = (name: string) => new File(['x'], name, { type: 'image/heic' })

describe('deriveReceiptOcrCapabilities', () => {
  it('suppresses all actions while a receipt is preparing', () => {
    expect(deriveReceiptOcrCapabilities({
      source:          { kind: 'preparing', requestId: 1 },
      hasAttachment:   true,
      previewIsImage:  true,
      ocrLoading:      false,
      hasItems:        false,
      ocrError:        null,
      fallbackEnabled: true,
      compareEnabled:  true,
    })).toEqual({
      canAnalyze:   false,
      canReanalyze: false,
      canFallback:  false,
      canCompare:   false,
    })
  })

  it('allows compare only for fresh local files', () => {
    const common = {
      hasAttachment:   true,
      previewIsImage:  true,
      ocrLoading:      false,
      hasItems:        true,
      ocrError:        null,
      fallbackEnabled: true,
      compareEnabled:  true,
    }

    expect(deriveReceiptOcrCapabilities({
      ...common,
      source: { kind: 'fresh', file: jpeg('fresh.jpg') },
    }).canCompare).toBe(true)
    expect(deriveReceiptOcrCapabilities({
      ...common,
      source: {
        kind:        'existing',
        tripId:      'trip-1',
        expenseId:   'expense-1',
        receiptPath: 'trips/trip-1/expenses/expense-1/receipt.webp',
      },
    }).canCompare).toBe(false)
  })
})

describe('useReceiptOcrSource', () => {
  it('derives an existing source only for provider-readable images', () => {
    expect(deriveExistingReceiptOcrSource({
      tripId:      'trip-1',
      expenseId:   'expense-1',
      receiptPath: 'trips/trip-1/expenses/expense-1/receipt.webp',
      receiptType: 'image/webp',
    })?.kind).toBe('existing')
    expect(deriveExistingReceiptOcrSource({
      tripId:      'trip-1',
      expenseId:   'expense-1',
      receiptPath: 'trips/trip-1/expenses/expense-1/receipt.heic',
      receiptType: 'image/heic',
    })).toBeNull()
  })

  it('keeps the newest prepared file as the only OCR source', () => {
    const view = renderHook(() => useReceiptOcrSource({
      tripId:      'trip-1',
      expenseId:   'expense-1',
      receiptPath: 'trips/trip-1/expenses/expense-1/receipt.webp',
      receiptType: 'image/webp',
    }))

    let firstId = 0
    let secondId = 0
    act(() => {
      firstId = view.result.current.beginPreparing()
      secondId = view.result.current.beginPreparing()
    })

    let committed = null as ReturnType<typeof view.result.current.commitPreparedFile>
    act(() => {
      committed = view.result.current.commitPreparedFile(secondId, jpeg('b.jpg'))
    })
    expect(committed?.kind).toBe('fresh')
    expect(view.result.current.source).toMatchObject({ kind: 'fresh' })

    act(() => {
      committed = view.result.current.commitPreparedFile(firstId, jpeg('a.jpg'))
    })
    expect(committed).toBeNull()
    expect(view.result.current.source).toMatchObject({ kind: 'fresh' })
    if (view.result.current.source.kind === 'fresh') {
      expect(view.result.current.source.file.name).toBe('b.jpg')
    }
  })

  it('commits unsupported local images as no OCR source', () => {
    const view = renderHook(() => useReceiptOcrSource({}))
    let requestId = 0
    act(() => {
      requestId = view.result.current.beginPreparing()
    })
    act(() => {
      view.result.current.commitPreparedFile(requestId, heic('receipt.heic'))
    })

    expect(view.result.current.source).toEqual({ kind: 'none' })
  })

  it('restores the previous source when the prepared file is rejected by attachment validation', () => {
    const view = renderHook(() => useReceiptOcrSource({
      tripId:      'trip-1',
      expenseId:   'expense-1',
      receiptPath: 'trips/trip-1/expenses/expense-1/receipt.webp',
      receiptType: 'image/webp',
    }))

    let requestId = 0
    act(() => {
      requestId = view.result.current.beginPreparing()
    })
    expect(view.result.current.source).toMatchObject({ kind: 'preparing' })

    act(() => {
      view.result.current.rejectPreparedFile(requestId)
    })

    expect(view.result.current.source).toMatchObject({
      kind:        'existing',
      tripId:      'trip-1',
      expenseId:   'expense-1',
      receiptPath: 'trips/trip-1/expenses/expense-1/receipt.webp',
    })
  })
})
