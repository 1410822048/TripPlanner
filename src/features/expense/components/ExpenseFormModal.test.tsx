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
import { render, screen, fireEvent } from '@testing-library/react'
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
vi.mock('@/components/ui/MemberChip', () => ({ default: () => null }))
vi.mock('@/components/ui/MemberAvatar', () => ({ default: () => null }))
vi.mock('@/components/ui/AttachmentRow', () => ({ default: () => null }))
vi.mock('@/features/bookings/components/AttachmentPreviewModal', () => ({ default: () => null }))

// ── Context / network hooks ──────────────────────────────────────────
vi.mock('@/hooks/useTripCurrency', () => ({ useTripCurrency: () => 'JPY' }))
vi.mock('@/hooks/useTripId', () => ({ useTripId: () => 'trip-1' }))
vi.mock('@/hooks/useFxPreview', () => ({
  useFxPreview: () => ({ rateDecimal: null, rateDate: undefined, isLoading: false, isError: false, disabledReason: undefined }),
}))
const ocrApi = vi.hoisted(() => ({
  run: vi.fn(), runExisting: vi.fn(), setFile: vi.fn(), reset: vi.fn(),
  lastFile: null as File | null,
}))
vi.mock('../hooks/useOcrFlow', () => ({
  useOcrFlow: () => ({
    loading: false, error: null, elapsedMs: 0,
    run: ocrApi.run, runExisting: ocrApi.runExisting, setFile: ocrApi.setFile, reset: ocrApi.reset,
    lastFile: ocrApi.lastFile,
  }),
}))

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
    receipt: { url: 'https://x/r.webp', path: 'trips/trip-1/expenses/e1/receipt.webp', type: 'image/webp' },
    sourceCurrency: 'USD', sourceAmountMinor: 4500,
  } as Expense
}

function renderModal(editTarget: Expense) {
  render(
    <ExpenseFormModal
      editTarget={editTarget} defaultDate="2026-06-04" members={members}
      isOpen isSaving={false} onClose={() => {}} onSave={vi.fn()}
    />,
  )
}

beforeEach(() => {
  ocrApi.run.mockReset()
  ocrApi.runExisting.mockReset()
  ocrApi.lastFile = null
})

describe('ExpenseFormModal — re-OCR dispatch', () => {
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

  it('a freshly-picked File present → run(file), never runExisting', () => {
    ocrApi.lastFile = new File(['x'], 'new.jpg', { type: 'image/jpeg' })
    renderModal(foreignExpense())
    fireEvent.click(screen.getByRole('button', { name: /明細を読み取る/ }))

    expect(ocrApi.runExisting).not.toHaveBeenCalled()
    expect(ocrApi.run).toHaveBeenCalledTimes(1)
    expect(ocrApi.run).toHaveBeenCalledWith(ocrApi.lastFile)
  })
})
