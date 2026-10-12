// Render + fireEvent tests for SettlementRecordSheet — the parts that pure
// fns can't cover: the synchronous double-submit latch, re-routing a stale
// suggestion on the live ledger,「記錄收款」's cap, the offset staleness
// refusal and the foreign-mode submit gate. The portal/animation shell
// (FormModalShell→BottomSheet) and the input widgets (CurrencyPicker /
// DatePicker) are stubbed to minimal pass-throughs so the test exercises
// THIS component's logic, not theirs.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen, fireEvent } from '@testing-library/react'
import type { ReactNode } from 'react'

vi.mock('@/components/ui/FormModalShell', () => ({
  default: ({ isOpen, saveLabel, onSave, children, saveError }: {
    isOpen: boolean; saveLabel: string; onSave: () => void; children: ReactNode; saveError?: string | null
  }) => (isOpen ? (
    <div>
      {saveError && <p role="alert">{saveError}</p>}
      {children}<button type="button" onClick={onSave}>{saveLabel}</button>
    </div>
  ) : null),
}))
// CurrencyPicker stub exposes a button that flips to a foreign code so a test
// can drive foreign mode without the real dropdown.
vi.mock('@/components/ui/CurrencyPicker', () => ({
  default: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <div><span>cur:{value}</span><button type="button" onClick={() => onChange('TWD')}>pick-foreign</button></div>
  ),
}))
vi.mock('@/components/ui/pickers/DatePicker', () => ({
  // maxDate is surfaced so the local-vs-UTC bound can be asserted; it is
  // the thing that used to refuse the user's own today.
  default: ({ value, maxDate }: { value: string; maxDate?: string }) =>
    <div>date:{value} max:{maxDate}</div>,
}))

const fx = vi.hoisted(() => ({
  value: {
    rateDecimal:    null as string | null,
    rateDate:       undefined as string | undefined,
    isLoading:      false,
    isError:        false,
    disabledReason: undefined as string | undefined,
    rateQuote:      undefined as { rateDecimal: string; rateDate: string } | undefined,
    isFinal:        undefined as boolean | undefined,
    adoptRate:      undefined as ((q: { rateDecimal: string; rateDate: string }) => void) | undefined,
  },
}))
vi.mock('@/hooks/useFxPreview', () => ({ useFxPreview: () => fx.value }))

import SettlementRecordSheet, { type RecordIntent, type RouteRecordSubmit } from './SettlementRecordSheet'
import type { TripMember } from '@/features/trips/types'
import { WorkerRejected } from '@/services/workerBase'
const LOCAL_TODAY = '2099-12-31'
vi.mock('@/utils/dates', () => ({ toLocalDateString: () => LOCAL_TODAY }))

const members: TripMember[] = [
  { id: 'a', displayName: 'Alice', avatarLabel: 'A', color: '#000', bg: '#fff' },
  { id: 'b', displayName: 'Bob', avatarLabel: 'B', color: '#000', bg: '#fff' },
  { id: 'c', displayName: 'Carol', avatarLabel: 'C', color: '#000', bg: '#fff' },
]
// a owes b 5000; b owes c 5000 → "a pays c 5000 via b".
const LEDGER = { a: { b: 5000 }, b: { c: 5000 } }
const PLANNED = {
  kind: 'TRANSFER' as const, payerUid: 'a', receiverUid: 'c', amountMinor: 5000,
  legs: [
    { fromUid: 'a', toUid: 'b', amountMinor: 5000, expectedRemainingMinor: 5000 },
    { fromUid: 'b', toUid: 'c', amountMinor: 5000, expectedRemainingMinor: 5000 },
  ],
}
const SUGGESTION: RecordIntent = { kind: 'TRANSFER', mode: 'suggestion', payerUid: 'a', receiverUid: 'c', amountMinor: 5000, planned: PLANNED }

type SaveFn = (p: RouteRecordSubmit) => false | void | Promise<unknown>

function renderSheet(opts: { intent?: RecordIntent; pairwise?: Record<string, Record<string, number>>; onSave?: SaveFn; onClose?: () => void } = {}) {
  const onSave = vi.fn<SaveFn>(opts.onSave)
  const props = {
    isOpen: true, onClose: opts.onClose ?? (() => {}), onSave,
    intent: opts.intent ?? SUGGESTION, pairwise: opts.pairwise ?? LEDGER,
    tripCurrency: 'JPY', members, isSaving: false,
  }
  const view = render(<SettlementRecordSheet {...props} />)
  return { onSave, rerender: (pairwise: Record<string, Record<string, number>>) => view.rerender(<SettlementRecordSheet {...props} pairwise={pairwise} />) }
}

const save = () => fireEvent.click(screen.getByRole('button', { name: '儲存紀錄' }))
const withRate = (over: Partial<typeof fx.value> = {}) => {
  fx.value = { ...fx.value, rateDecimal: '0.218', rateDate: '2026-06-03', rateQuote: { rateDecimal: '0.218', rateDate: '2026-06-03' }, isLoading: false, isError: false, disabledReason: undefined, ...over }
}

beforeEach(() => {
  fx.value = {
    rateDecimal: null, rateDate: undefined, isLoading: false, isError: false, disabledReason: undefined,
    rateQuote: undefined, isFinal: undefined, adoptRate: undefined,
  }
})

describe('SettlementRecordSheet — suggestion', () => {
  it('sends the planned route and shows who it passes through; a double-tap sends once', () => {
    const { onSave } = renderSheet()
    expect(screen.getByText(/經 Bob 轉交/)).toBeTruthy()
    save()
    save()
    expect(onSave).toHaveBeenCalledTimes(1)
    const payload = onSave.mock.calls[0]![0]
    expect(payload.route).toEqual(PLANNED)
    expect(payload).not.toHaveProperty('foreign')
    expect(payload).not.toHaveProperty('sourceAmountMinor')
  })

  it('a synchronous page refusal (returns false) releases the latch so the next tap retries', () => {
    const { onSave } = renderSheet({ onSave: vi.fn<SaveFn>().mockReturnValueOnce(false) })
    save()
    save()
    expect(onSave).toHaveBeenCalledTimes(2)
    save()
    expect(onSave).toHaveBeenCalledTimes(2)
  })

  it('a suggestion gone stale is re-routed on the live ledger, never sent with old CAS numbers', () => {
    // Since the sheet opened, b paid c 1000 directly: b→c is now 4000, so
    // only 4000 of a's 5000 can still pass through b.
    const { onSave, rerender } = renderSheet()
    rerender({ a: { b: 5000 }, b: { c: 4000 } })
    save()
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByText(/帳上目前最多只能記錄 ¥4,000/)).toBeTruthy()

    // Another path appears: the sheet re-routes the same payment over it.
    rerender({ a: { b: 5000, d: 1000 }, b: { c: 4000 }, d: { c: 1000 } })
    save()
    expect(onSave).toHaveBeenCalledTimes(1)
    const route = onSave.mock.calls[0]![0].route
    expect(route).toMatchObject({ kind: 'TRANSFER', payerUid: 'a', receiverUid: 'c', amountMinor: 5000 })
    expect(route.legs.map(l => [l.fromUid, l.toUid, l.amountMinor, l.expectedRemainingMinor])).toEqual([
      ['a', 'b', 4000, 5000], ['a', 'd', 1000, 1000], ['b', 'c', 4000, 4000], ['d', 'c', 1000, 1000],
    ])
  })
})

describe('SettlementRecordSheet —「記錄收款」', () => {
  const PAYMENT: RecordIntent = { kind: 'TRANSFER', mode: 'payment', receiverUid: 'c' }

  it('lists only people the ledger can explain paying me, prefilled with the most it can be', () => {
    renderSheet({ intent: PAYMENT })
    expect(screen.getByRole('radio', { name: /Alice/ })).toBeTruthy()
    expect(screen.getByRole('radio', { name: /Bob/ })).toBeTruthy()
    expect(screen.queryByRole('radio', { name: /Carol/ })).toBeNull()
    // Alice (first payer) can pay at most 5000 via Bob.
    expect((screen.getByLabelText('清算金額') as HTMLInputElement).value).toBe('5000')
  })

  it('records a partial amount over the real debt path', () => {
    const { onSave } = renderSheet({ intent: PAYMENT })
    fireEvent.change(screen.getByLabelText('清算金額'), { target: { value: '1,200' } })
    save()
    expect(onSave.mock.calls[0]![0].route).toEqual({
      kind: 'TRANSFER', payerUid: 'a', receiverUid: 'c', amountMinor: 1200,
      legs: [
        { fromUid: 'a', toUid: 'b', amountMinor: 1200, expectedRemainingMinor: 5000 },
        { fromUid: 'b', toUid: 'c', amountMinor: 1200, expectedRemainingMinor: 5000 },
      ],
    })
  })

  it('refuses more than the ledger can explain, and an empty amount', () => {
    const { onSave } = renderSheet({ intent: PAYMENT })
    fireEvent.change(screen.getByLabelText('清算金額'), { target: { value: '5001' } })
    save()
    expect(screen.getByText(/最多只能記錄 ¥5,000/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('清算金額'), { target: { value: '' } })
    save()
    expect(screen.getByText('請輸入金額')).toBeTruthy()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('switching payer refills their maximum', () => {
    renderSheet({ intent: PAYMENT, pairwise: { a: { b: 5000 }, b: { c: 7000 } } })
    fireEvent.click(screen.getByRole('radio', { name: /Bob/ }))
    expect((screen.getByLabelText('清算金額') as HTMLInputElement).value).toBe('7000')
  })
})

describe('SettlementRecordSheet — offset', () => {
  const CYCLE = { a: { b: 300 }, b: { c: 300 }, c: { a: 300 } }
  const OFFSET: RecordIntent = {
    kind: 'OFFSET',
    route: { kind: 'OFFSET', participantUids: ['a', 'b', 'c'], legs: [
      { fromUid: 'a', toUid: 'b', amountMinor: 300, expectedRemainingMinor: 300 },
      { fromUid: 'b', toUid: 'c', amountMinor: 300, expectedRemainingMinor: 300 },
      { fromUid: 'c', toUid: 'a', amountMinor: 300, expectedRemainingMinor: 300 },
    ] },
  }

  it('says no one pays, has no currency choice, and sends the offset', () => {
    const { onSave } = renderSheet({ intent: OFFSET, pairwise: CYCLE })
    expect(screen.getByText(/不需要任何人付款/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'pick-foreign' })).toBeNull()
    save()
    expect(onSave.mock.calls[0]![0].route).toEqual((OFFSET as Extract<RecordIntent, { kind: 'OFFSET' }>).route)
  })

  it('refuses an offset the ledger has moved past (it is not a payment to re-route)', () => {
    const { onSave } = renderSheet({ intent: OFFSET, pairwise: { ...CYCLE, a: { b: 200 } } })
    save()
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toMatch(/請關閉後重新確認/)
  })
})

describe('SettlementRecordSheet — the date bound is the user\'s day', () => {
  it('defaults settledOn and caps the picker at LOCAL today, not UTC today', () => {
    renderSheet()
    fireEvent.click(screen.getByRole('button', { name: 'pick-foreign' }))
    expect(screen.getByText(`date:${LOCAL_TODAY} max:${LOCAL_TODAY}`)).toBeTruthy()
  })

  it('accepts local today on submit', () => {
    withRate()
    const { onSave } = renderSheet()
    fireEvent.click(screen.getByRole('button', { name: 'pick-foreign' }))
    save()
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave.mock.calls[0]![0].foreign).toMatchObject({ settledOn: LOCAL_TODAY })
  })
})

describe('SettlementRecordSheet — foreign-mode submit gate', () => {
  it('blocks submit until an FX rate is confirmed, without latching', () => {
    const { onSave } = renderSheet()
    fireEvent.click(screen.getByRole('button', { name: 'pick-foreign' }))
    save()
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByText(/確認匯率/)).toBeTruthy()

    withRate()
    fireEvent.click(screen.getByRole('button', { name: 'pick-foreign' })) // re-render with the new fx value
    save()
    expect(onSave).toHaveBeenCalledTimes(1)
    const payload = onSave.mock.calls[0]![0]
    expect(payload.foreign).toMatchObject({ sourceCurrency: 'TWD', expectedFxRate: { rateDecimal: '0.218', rateDate: '2026-06-03' } })
    // Display/audit only: the at-most source amount for the cleared 5000.
    expect(payload.sourceAmountMinor).toBeGreaterThan(0)
    // The ledger amount is the route's, in trip currency.
    expect(payload.route).toEqual(PLANNED)
  })

  it('refuses a source amount that rounds to nothing', () => {
    withRate({ rateDecimal: '100000', rateQuote: { rateDecimal: '100000', rateDate: '2026-06-03' } })
    const { onSave } = renderSheet()
    fireEvent.click(screen.getByRole('button', { name: 'pick-foreign' }))
    save()
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByText(/換算後的金額過小/)).toBeTruthy()
  })
})

describe('SettlementRecordSheet — FX rate confirmation', () => {
  it('sends the shown rate, and on FX_RATE_CHANGED adopts the refusal rate and allows a resubmit', async () => {
    const adoptRate = vi.fn()
    fx.value = {
      rateDecimal: '4.6', rateDate: '2099-12-30', isLoading: false, isError: false, disabledReason: undefined,
      rateQuote: { rateDecimal: '4.6', rateDate: '2099-12-30' }, isFinal: false, adoptRate,
    }
    const refusal = new WorkerRejected(409, 'rate changed', 'FX_RATE_CHANGED', undefined, {
      rateDecimal: '4.7', rateDate: '2099-12-31',
    })
    const onClose = vi.fn()
    const { onSave } = renderSheet({
      onClose,
      onSave: vi.fn<SaveFn>().mockRejectedValueOnce(refusal).mockResolvedValueOnce(undefined),
    })
    fireEvent.click(screen.getByRole('button', { name: 'pick-foreign' }))
    await act(async () => { save() })

    expect(onSave.mock.calls[0]![0].foreign).toMatchObject({ expectedFxRate: { rateDecimal: '4.6', rateDate: '2099-12-30' } })
    expect(typeof onSave.mock.calls[0]![0].reportInForm).toBe('function')
    expect(adoptRate).toHaveBeenCalledWith({ rateDecimal: '4.7', rateDate: '2099-12-31' })
    expect(screen.getByRole('alert').textContent).toMatch(/4.6（2099-12-30）→ 4.7（2099-12-31）/)
    expect(onClose).not.toHaveBeenCalled()

    await act(async () => { save() })
    expect(onSave).toHaveBeenCalledTimes(2)
    expect(onClose).toHaveBeenCalledOnce()
  })
})
