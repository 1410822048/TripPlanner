// @vitest-environment jsdom
// FX CAS confirmation inside the expense form. The form sends the rate it
// converted with as `expectedFxRate`; when the Worker refuses it
// (409 FX_RATE_CHANGED) the form must show the refusal's rate — not ask
// /fx-rate again — and the NEXT save must send that new rate and convert
// with it. That last part is a closure / state-ordering property, so
// useFxPreview runs for real here; only the network is stubbed.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { Timestamp } from 'firebase/firestore'

vi.mock('@/components/ui/FormModalShell', () => ({
  default: ({ isOpen, children, onSave, saveError }: {
    isOpen: boolean; children: ReactNode; onSave: () => void; saveError?: string | null
  }) => (isOpen ? (
    <div>
      {saveError && <p role="alert">{saveError}</p>}
      {children}
      <button onClick={onSave}>save</button>
    </div>
  ) : null),
}))
vi.mock('@/components/ui/CurrencyInput', () => ({ default: () => null }))
vi.mock('@/components/ui/CurrencyPicker', () => ({ default: () => null }))
vi.mock('@/components/ui/SingleSelectPicker', () => ({ default: () => null }))
vi.mock('@/components/ui/pickers', () => ({ DatePicker: () => null }))
vi.mock('@/components/ui/MemberAvatar', () => ({ default: () => null }))
vi.mock('@/features/attachments/components/AttachmentPreviewModal', () => ({ default: () => null }))
vi.mock('@/hooks/useTripCurrency', () => ({ useTripCurrency: () => 'JPY' }))
vi.mock('@/hooks/useTripId', () => ({ useTripId: () => 'trip-1' }))
vi.mock('@/hooks/useAttachmentUrl', () => ({ useAttachmentUrl: () => null }))
vi.mock('../hooks/useOcrFlow', () => ({
  useOcrFlow: () => ({
    loading: false, error: null, elapsedMs: 0, lastFile: null,
    run: vi.fn(), runFallback: vi.fn(), runExisting: vi.fn(), cancel: vi.fn(), setFile: vi.fn(), reset: vi.fn(),
  }),
}))
vi.mock('@/services/firebase', () => ({
  getFirebaseAuth: vi.fn(async () => ({ auth: { currentUser: { getIdToken: async () => 'id-token' } } })),
}))
vi.mock('@/services/workerBase', async importOriginal => ({
  ...await importOriginal<typeof import('@/services/workerBase')>(),
  requireWorkerWriteBase: () => 'https://worker.test',
}))

import ExpenseFormModal, { type ExpenseFormResult } from './ExpenseFormModal'
import { WorkerRejected } from '@/services/workerBase'
import type { Expense } from '@/types'
import type { TripMember } from '@/features/trips/types'

const members: TripMember[] = [
  { id: 'a', displayName: 'Alice', avatarLabel: 'A', color: '#000', bg: '#fff' },
  { id: 'b', displayName: 'Bob', avatarLabel: 'B', color: '#000', bg: '#fff' },
]
const ts = (ms: number) => ({ toMillis: () => ms } as unknown as Timestamp)

/** Foreign (USD 45.00 on a JPY trip), dated "today", no stored rate — so the
 *  preview comes from /fx-rate, and an earlier rateDate is provisional. */
function foreignExpenseToday(): Expense {
  return {
    id: 'e1', tripId: 'trip-1', title: 'Lunch', amountMinor: 6705, currency: 'JPY',
    category: 'food', paidBy: 'a',
    splits: [{ memberId: 'a', amountMinor: 3352 }, { memberId: 'b', amountMinor: 3353 }],
    date: '2026-06-01', adjustments: [],
    createdBy: 'a', updatedBy: 'a', memberIds: ['a', 'b'],
    createdAt: ts(0), updatedAt: ts(1),
    deletedAt: null, receiptPurgedAt: null,
    sourceCurrency: 'USD', sourceAmountMinor: 4500,
    sourceSplits: [{ memberId: 'a', sourceAmountMinor: 2250 }, { memberId: 'b', sourceAmountMinor: 2250 }],
  } as Expense
}

function workerRate(rateDecimal: string, rateDate: string) {
  return new Response(JSON.stringify({ degenerate: false, tripCurrency: 'JPY', rateDecimal, rateDate }), { status: 200 })
}

function renderForm(onSave: (r: ExpenseFormResult) => void | Promise<unknown>, onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(
    <QueryClientProvider client={client}>
      <ExpenseFormModal
        editTarget={foreignExpenseToday()} defaultDate="2026-06-01" members={members}
        isOpen isSaving={false} onClose={onClose} onSave={onSave}
      />
    </QueryClientProvider>,
  )
  return { ...view, onClose }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('ExpenseFormModal — FX rate confirmation', () => {
  it('a refused provisional save shows the refusal rate, and the next save sends and converts with it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-06-01T12:00:00Z'))
    // Before publication: the preview answers with the previous day's rate.
    const fetchMock = vi.fn(async () => workerRate('149', '2026-05-31'))
    vi.stubGlobal('fetch', fetchMock)

    const refusal = new WorkerRejected(409, 'rate changed', 'FX_RATE_CHANGED', undefined, {
      rateDecimal: '150', rateDate: '2026-06-01',
    })
    const onSave = vi.fn<(r: ExpenseFormResult) => Promise<void>>()
      .mockRejectedValueOnce(refusal)
      .mockResolvedValueOnce(undefined)
    renderForm(onSave)

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    await act(async () => { await Promise.resolve() })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'save' })) })

    expect(onSave).toHaveBeenCalledTimes(1)
    const first = onSave.mock.calls[0]![0]
    expect(first.expectedFxRate).toEqual({ rateDecimal: '149', rateDate: '2026-05-31' })
    expect(typeof first.reportInForm).toBe('function')
    expect(first.input.amountMinor).toBe(6705)   // USD 45.00 × 149
    // The refusal is shown in THIS form (its own banner), and the form stays.
    expect(screen.getByRole('alert').textContent).toMatch(/149（2026-05-31）→ 150（2026-06-01）/)

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'save' })) })
    expect(onSave).toHaveBeenCalledTimes(2)
    const second = onSave.mock.calls[1]![0]
    expect(second.expectedFxRate).toEqual({ rateDecimal: '150', rateDate: '2026-06-01' })
    expect(second.input.amountMinor).toBe(6750)  // USD 45.00 × 150
    // The published rate is final: this save may close optimistically.
    expect(second.reportInForm).toBeUndefined()
    // The refusal's rate was used as-is — no second /fx-rate request.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('a final rate does not ask the page to wait', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-06-01T12:00:00Z'))
    vi.stubGlobal('fetch', vi.fn(async () => workerRate('150', '2026-06-01')))
    const onSave = vi.fn()
    renderForm(onSave)

    await waitFor(() => expect(screen.queryByText(/150/)).not.toBeNull())
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'save' })) })
    expect(onSave.mock.calls[0]![0]).toMatchObject({
      expectedFxRate: { rateDecimal: '150', rateDate: '2026-06-01' },
    })
    expect(onSave.mock.calls[0]![0].reportInForm).toBeUndefined()
  })

  it('a waited save that succeeds closes this form', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-06-01T12:00:00Z'))
    vi.stubGlobal('fetch', vi.fn(async () => workerRate('149', '2026-05-31')))
    const { onClose } = renderForm(async () => {})
    await waitFor(() => expect(screen.queryByText(/149/)).not.toBeNull())
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'save' })) })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('a form dismissed while waiting hands its outcome to the global handler and touches nothing', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-06-01T12:00:00Z'))
    vi.stubGlobal('fetch', vi.fn(async () => workerRate('149', '2026-05-31')))
    let reject!: (e: unknown) => void
    let resolve!: () => void
    const onSave = vi.fn<(r: ExpenseFormResult) => Promise<unknown>>()
      .mockReturnValueOnce(new Promise((_, r) => { reject = r }))
      .mockReturnValueOnce(new Promise<void>(r => { resolve = r }))

    // Dismissed, then refused: no close (another form may be open by now),
    // and reportInForm() turns false so the global toast reports it.
    const a = renderForm(onSave)
    await waitFor(() => expect(screen.queryByText(/149/)).not.toBeNull())
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'save' })) })
    const reportA = onSave.mock.calls[0]![0].reportInForm!
    expect(reportA()).toBe(true)
    a.unmount()
    expect(reportA()).toBe(false)
    await act(async () => { reject(new WorkerRejected(409, 'x', 'FX_RATE_CHANGED', undefined, { rateDecimal: '150', rateDate: '2026-06-01' })) })
    expect(a.onClose).not.toHaveBeenCalled()

    // Dismissed, then succeeded: a late success must not close what is open now.
    const b = renderForm(onSave)
    await waitFor(() => expect(screen.queryByText(/149/)).not.toBeNull())
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'save' })) })
    b.unmount()
    await act(async () => { resolve() })
    expect(b.onClose).not.toHaveBeenCalled()
  })
})
