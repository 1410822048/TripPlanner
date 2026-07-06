// Render + fireEvent test for ExpenseFormModal's re-OCR DISPATCH — the small
// but easy-to-break logic added with the existing-receipt OCR work:
//   - existing saved receipt (no freshly-picked File) → ocr.runExisting with
//     currencyHint = effectiveCurrency (the FOREIGN code for a foreign
//     expense, NOT tripCurrency), plus tripId/expenseId from the doc.
//   - a freshly-picked File present → ocr.run(file), never runExisting.
//
// Strategy: the DISPATCH + effectiveCurrency derivation run for REAL (the
// component's own logic + the pure state hooks useFormReducer/useSplitsState/
// useExpenseItems/useAttachment). Only the context/network hooks
// (useTripCurrency/useTripId/useFxPreview/useOcrFlow) are mocked, and leaf
// widgets are stubbed so the test isn't coupled to their internals.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { Timestamp } from 'firebase/firestore'

// ── Leaf widget stubs ────────────────────────────────────────────────
// FormModalShell MUST render children (the 明細を読み取る button lives there).
vi.mock('@/components/ui/FormModalShell', () => ({
  default: ({ isOpen, children }: { isOpen: boolean; children: ReactNode }) => (isOpen ? <div>{children}</div> : null),
}))
vi.mock('@/components/ui/CurrencyInput', () => ({ default: () => null }))
vi.mock('@/components/ui/CurrencyPicker', () => ({ default: () => null }))
vi.mock('@/components/ui/pickers', () => ({ DatePicker: () => null }))
vi.mock('@/components/ui/MemberAvatar', () => ({ default: () => null }))
vi.mock('@/components/ui/AttachmentRow', () => ({ default: () => null }))
vi.mock('@/features/attachments/components/AttachmentPreviewModal', () => ({ default: () => null }))

// ── Context / network hooks ──────────────────────────────────────────
vi.mock('@/hooks/useTripCurrency', () => ({ useTripCurrency: () => 'JPY' }))
vi.mock('@/hooks/useTripId', () => ({ useTripId: () => 'trip-1' }))
vi.mock('@/hooks/useFxPreview', () => ({
  useFxPreview: () => ({ rateDecimal: null, rateDate: undefined, isLoading: false, isError: false, disabledReason: undefined }),
}))
const ocrApi = vi.hoisted(() => ({
  run: vi.fn(), runFallback: vi.fn(), runExisting: vi.fn(), cancel: vi.fn(), setFile: vi.fn(), reset: vi.fn(),
  lastFile: null as File | null,
  // Captured from useOcrFlow's options each render so a test can simulate the
  // Worker returning a parsed receipt and exercise the REAL onSuccess wire
  // (applyOcrResultToForm + markAnalyzed).
  onSuccess: null as ((result: unknown) => void) | null,
}))
const imageApi = vi.hoisted(() => ({
  compressReceiptImage: vi.fn(async (file: File) => ({ full: file })),
}))
vi.mock('../hooks/useOcrFlow', () => ({
  useOcrFlow: (opts: { onSuccess: (result: unknown) => void }) => {
    ocrApi.onSuccess = opts.onSuccess
    return {
      loading: false, error: null, elapsedMs: 0,
      run: ocrApi.run, runFallback: ocrApi.runFallback, runExisting: ocrApi.runExisting,
      cancel: ocrApi.cancel, setFile: ocrApi.setFile, reset: ocrApi.reset,
      lastFile: ocrApi.lastFile,
    }
  },
}))
vi.mock('@/utils/image', async () => {
  const actual = await vi.importActual<typeof import('@/utils/image')>('@/utils/image')
  return { ...actual, compressReceiptImage: imageApi.compressReceiptImage }
})

import ExpenseFormModal from './ExpenseFormModal'
import type { Expense } from '@/types'
import type { TripMember } from '@/features/trips/types'

const members: TripMember[] = [
  { id: 'a', label: 'A', color: '#000', bg: '#fff' },
  { id: 'b', label: 'B', color: '#000', bg: '#fff' },
]

const ts = (ms: number) => ({ toMillis: () => ms } as unknown as Timestamp)

/** A SAVED foreign-currency expense (sourceCurrency USD ≠ trip JPY) with an
 *  image receipt and NO items (so the form shows the canAnalyze button, not
 *  the by-item UI). */
function foreignExpense(): Expense {
  return {
    id: 'e1', tripId: 'trip-1', title: 'Lunch', amountMinor: 5000, currency: 'JPY',
    category: 'food', paidBy: 'a',
    splits: [{ memberId: 'a', amountMinor: 2500 }, { memberId: 'b', amountMinor: 2500 }],
    date: '2026-06-01', adjustments: [],
    createdBy: 'a', updatedBy: 'a', memberIds: ['a', 'b'],
    createdAt: ts(0), updatedAt: ts(1_700_000_000_000),
    deletedAt: null, receiptPurgedAt: null,
    receipt: { url: 'https://x/r.webp', path: 'trips/trip-1/expenses/e1/receipt.webp', type: 'image/webp' },
    sourceCurrency: 'USD', sourceAmountMinor: 4500,
  } as Expense
}

function foreignExpenseWithItems(): Expense {
  return {
    ...foreignExpense(),
    items: [
      { id: 'item-1', name: 'Old receipt item', amountMinor: 4500, allocations: [{ memberId: 'a', shares: 1 }, { memberId: 'b', shares: 1 }] },
    ],
  } as Expense
}

function renderModal(editTarget: Expense) {
  return render(
    <ExpenseFormModal
      editTarget={editTarget} defaultDate="2026-06-04" members={members}
      isOpen isSaving={false} onClose={() => {}} onSave={vi.fn()}
    />,
  )
}

function renderCreateModal() {
  return render(
    <ExpenseFormModal
      editTarget={null} defaultDate="2026-06-04" members={members}
      isOpen isSaving={false} onClose={() => {}} onSave={vi.fn()}
    />,
  )
}

beforeEach(() => {
  ocrApi.run.mockReset()
  ocrApi.runFallback.mockReset()
  ocrApi.runExisting.mockReset()
  ocrApi.cancel.mockReset()
  ocrApi.setFile.mockReset()
  ocrApi.reset.mockReset()
  ocrApi.lastFile = null
  ocrApi.onSuccess = null
  imageApi.compressReceiptImage.mockReset()
  imageApi.compressReceiptImage.mockImplementation(async (file: File) => ({ full: file }))
})

describe('ExpenseFormModal — re-OCR dispatch', () => {
  it('single receipt entry keeps upload as attach-only', async () => {
    const { container } = renderCreateModal()
    const uploadInput = container.querySelectorAll('input[type="file"]')[1] as HTMLInputElement
    const file = new File(['x'], 'receipt.jpg', { type: 'image/jpeg' })
    const receipt = new File(['prepared'], 'receipt.webp', { type: 'image/webp' })
    imageApi.compressReceiptImage.mockResolvedValueOnce({ full: receipt })

    fireEvent.click(screen.getByRole('button', { name: /レシートを追加/ }))
    fireEvent.click(screen.getByRole('button', { name: /ファイルを添付/ }))
    fireEvent.change(uploadInput, { target: { files: [file] } })

    await waitFor(() => expect(ocrApi.setFile).toHaveBeenCalledWith(receipt))
    expect(ocrApi.run).not.toHaveBeenCalled()
  })

  it('single receipt entry keeps camera as auto-OCR', async () => {
    const { container } = renderCreateModal()
    const cameraInput = container.querySelector('input[capture="environment"]') as HTMLInputElement
    const file = new File(['x'], 'capture.jpg', { type: 'image/jpeg' })
    const receipt = new File(['prepared'], 'capture.webp', { type: 'image/webp' })
    imageApi.compressReceiptImage.mockResolvedValueOnce({ full: receipt })

    fireEvent.click(screen.getByRole('button', { name: /レシートを追加/ }))
    fireEvent.click(screen.getByRole('button', { name: /撮影して読み取る/ }))
    fireEvent.change(cameraInput, { target: { files: [file] } })

    await waitFor(() => expect(ocrApi.run).toHaveBeenCalledWith(receipt))
  })

  it('existing foreign receipt → runExisting with currencyHint = the foreign source currency (not trip)', () => {
    renderModal(foreignExpense())
    fireEvent.click(screen.getByRole('button', { name: /明細を読み取る/ }))

    expect(ocrApi.run).not.toHaveBeenCalled()
    expect(ocrApi.runExisting).toHaveBeenCalledTimes(1)
    expect(ocrApi.runExisting).toHaveBeenCalledWith(expect.objectContaining({
      tripId: 'trip-1',
      expenseId: 'e1',
      currencyHint: 'USD', // effectiveCurrency, NOT 'JPY'
    }))
    // The race guard is wired in as a callable predicate.
    expect(typeof ocrApi.runExisting.mock.calls[0]![0].isStillApplicable).toBe('function')
  })

  it('a freshly-picked File present → run(file), never runExisting', async () => {
    const { container } = renderModal(foreignExpense())
    const uploadInput = container.querySelectorAll('input[type="file"]')[1] as HTMLInputElement
    const file = new File(['x'], 'new.jpg', { type: 'image/jpeg' })
    const receipt = new File(['prepared'], 'new.receipt.webp', { type: 'image/webp' })
    imageApi.compressReceiptImage.mockResolvedValueOnce({ full: receipt })

    fireEvent.change(uploadInput, { target: { files: [file] } })
    await waitFor(() => expect(ocrApi.setFile).toHaveBeenCalledWith(receipt))

    fireEvent.click(screen.getByRole('button', { name: /明細を読み取る/ }))

    expect(ocrApi.runExisting).not.toHaveBeenCalled()
    expect(ocrApi.run).toHaveBeenCalledTimes(1)
    expect(ocrApi.run).toHaveBeenCalledWith(receipt)
  })

  it('shows the first-read CTA after replacing a receipt even when old items are still visible', async () => {
    const { container } = renderModal(foreignExpenseWithItems())
    const uploadInput = container.querySelectorAll('input[type="file"]')[1] as HTMLInputElement
    const file = new File(['x'], 'new.jpg', { type: 'image/jpeg' })
    const receipt = new File(['prepared'], 'new.receipt.webp', { type: 'image/webp' })
    imageApi.compressReceiptImage.mockResolvedValueOnce({ full: receipt })

    expect(screen.getByRole('button', { name: /もう一度読み取る/ })).toBeTruthy()

    fireEvent.change(uploadInput, { target: { files: [file] } })
    await waitFor(() => expect(ocrApi.setFile).toHaveBeenCalledWith(receipt))

    expect(screen.getByRole('button', { name: /明細を読み取る/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /もう一度読み取る/ })).toBeNull()
  })

  it('drops a stale camera prepare result when a newer file finishes first', async () => {
    const { container } = renderModal(foreignExpense())
    const input = container.querySelector('input[capture="environment"]') as HTMLInputElement
    const fileA = new File(['a'], 'a.jpg', { type: 'image/jpeg' })
    const fileB = new File(['b'], 'b.jpg', { type: 'image/jpeg' })
    const receiptA = new File(['a-prepared'], 'a.receipt.webp', { type: 'image/webp' })
    const receiptB = new File(['b-prepared'], 'b.receipt.webp', { type: 'image/webp' })
    let resolveA!: (value: { full: File }) => void
    imageApi.compressReceiptImage
      .mockImplementationOnce(() => new Promise(resolve => { resolveA = resolve }))
      .mockResolvedValueOnce({ full: receiptB })

    fireEvent.change(input, { target: { files: [fileA] } })
    fireEvent.change(input, { target: { files: [fileB] } })

    expect(ocrApi.cancel).toHaveBeenCalledTimes(2)
    expect(ocrApi.run).not.toHaveBeenCalled()

    await waitFor(() => expect(ocrApi.run).toHaveBeenCalledWith(receiptB))
    expect(ocrApi.run).toHaveBeenCalledTimes(1)
    expect(ocrApi.run.mock.calls[0]![0]).toBe(receiptB)

    await act(async () => {
      resolveA({ full: receiptA })
      await Promise.resolve()
    })

    expect(ocrApi.run).toHaveBeenCalledTimes(1)
    expect(ocrApi.run.mock.calls[0]![0]).not.toBe(receiptA)
  })

  it('hides existing-receipt OCR actions while a replacement upload is preparing', async () => {
    const { container } = renderModal(foreignExpense())
    const uploadInput = container.querySelectorAll('input[type="file"]')[1] as HTMLInputElement
    const file = new File(['replacement'], 'replacement.jpg', { type: 'image/jpeg' })
    const receipt = new File(['prepared'], 'replacement.receipt.webp', { type: 'image/webp' })
    let resolvePrepare!: (value: { full: File }) => void
    imageApi.compressReceiptImage.mockImplementationOnce(() => new Promise(resolve => { resolvePrepare = resolve }))

    expect(screen.getByRole('button', { name: /明細を読み取る/ })).toBeTruthy()

    fireEvent.change(uploadInput, { target: { files: [file] } })

    expect(ocrApi.cancel).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: /明細を読み取る/ })).toBeNull()
    expect(ocrApi.runExisting).not.toHaveBeenCalled()

    await act(async () => {
      resolvePrepare({ full: receipt })
      await Promise.resolve()
    })

    expect(ocrApi.setFile).toHaveBeenCalledWith(receipt)
    expect(ocrApi.runExisting).not.toHaveBeenCalled()
  })

  it('flips the CTA 明細を読み取る → もう一度読み取る after a successful OCR apply', async () => {
    // Closes the gap the capability UNIT test can't reach: it verifies the
    // derive logic in isolation, but not that onSuccess actually fires
    // markAnalyzed(sourceKey) → caps recompute → the rendered CTA flips. A
    // broken wire (markAnalyzed not called / wrong key) leaves a stale CTA
    // while the unit test stays green.
    const { container } = renderModal(foreignExpense()) // existing, NO items
    const cameraInput = container.querySelector('input[capture="environment"]') as HTMLInputElement
    const file = new File(['x'], 'r.jpg', { type: 'image/jpeg' })
    const receipt = new File(['prepared'], 'r.receipt.webp', { type: 'image/webp' })
    imageApi.compressReceiptImage.mockResolvedValueOnce({ full: receipt })

    // Camera pick auto-runs OCR (mocked no-op). The freshly-picked source is
    // unanalyzed until onSuccess lands → first-read CTA.
    fireEvent.change(cameraInput, { target: { files: [file] } })
    await waitFor(() => expect(ocrApi.run).toHaveBeenCalledWith(receipt))
    expect(screen.getByRole('button', { name: /明細を読み取る/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /もう一度読み取る/ })).toBeNull()

    // Simulate the Worker returning a parseable receipt — runs the REAL
    // applyOcrResultToForm (items populate) + markAnalyzed(sourceKey).
    act(() => {
      ocrApi.onSuccess!({
        items:        [{ name: 'Lunch', amountText: '3000' }],
        adjustments:  [],
        ignoredLines: [],
        totalText:    '3000',
      })
    })

    expect(screen.getByRole('button', { name: /もう一度読み取る/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /明細を読み取る/ })).toBeNull()
  })

  it('does not OCR a replacement receipt rejected by attachment validation', async () => {
    const { container } = renderModal(foreignExpense())
    const uploadInput = container.querySelectorAll('input[type="file"]')[1] as HTMLInputElement
    const file = new File(['replacement'], 'replacement.jpg', { type: 'image/jpeg' })
    const tooLargeReceipt = new File(
      [new Uint8Array(5 * 1024 * 1024 + 1)],
      'replacement.receipt.webp',
      { type: 'image/webp' },
    )
    imageApi.compressReceiptImage.mockResolvedValueOnce({ full: tooLargeReceipt })

    fireEvent.change(uploadInput, { target: { files: [file] } })

    await waitFor(() => expect(ocrApi.cancel).toHaveBeenCalledTimes(1))
    expect(ocrApi.setFile).not.toHaveBeenCalled()
    expect(ocrApi.run).not.toHaveBeenCalled()

    await waitFor(() => expect(screen.getByRole('button', { name: /明細を読み取る/ })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /明細を読み取る/ }))

    expect(ocrApi.runExisting).toHaveBeenCalledTimes(1)
    expect(ocrApi.runExisting).toHaveBeenCalledWith(expect.objectContaining({
      tripId: 'trip-1',
      expenseId: 'e1',
    }))
  })
})
