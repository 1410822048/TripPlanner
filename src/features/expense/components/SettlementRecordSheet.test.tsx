// Render + fireEvent tests for SettlementRecordSheet — the parts that pure
// fns can't cover: the synchronous double-submit latch and the foreign-mode
// submit gate. The portal/animation shell (FormModalShell→BottomSheet) and
// the input widgets (CurrencyPicker/DatePicker) are stubbed to minimal
// pass-throughs so the test exercises THIS component's logic, not theirs.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen, fireEvent } from '@testing-library/react'
import type { ReactNode } from 'react'

// FormModalShell does exactly this in production: render children + a footer
// SaveButton whose onClick is the passed onSave. The latch under test lives
// in SettlementRecordSheet.handleSubmit, NOT the shell, so a faithful stub
// keeps the test focused.
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
// can drive FOREIGN_CURRENCY mode without the real dropdown.
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

// useFxPreview is controllable per-test via this hoisted holder.
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

import SettlementRecordSheet, { type SettlementRecordSubmit } from './SettlementRecordSheet'
import type { TripMember } from '@/features/trips/types'
import { WorkerRejected } from '@/services/workerBase'
// Stubbed to a value that is deliberately NOT the UTC date: the CI box
// runs in UTC, so asserting against a real toLocalDateString would pass
// just as happily against `new Date().toISOString()` and prove nothing.
const LOCAL_TODAY = '2099-12-31'
vi.mock('@/utils/dates', () => ({ toLocalDateString: () => LOCAL_TODAY }))

const members: TripMember[] = [
  { id: 'a', displayName: 'Alice', avatarLabel: 'A', color: '#000', bg: '#fff' },
  { id: 'b', displayName: 'Bob', avatarLabel: 'B', color: '#000', bg: '#fff' },
]
const suggested = { fromUid: 'a', toUid: 'b', amountMinor: 5000 }

function renderSheet() {
  const onSave = vi.fn<(p: SettlementRecordSubmit) => void>()
  render(
    <SettlementRecordSheet
      isOpen onClose={() => {}} onSave={onSave}
      suggested={suggested} tripCurrency="JPY" members={members} isSaving={false}
    />,
  )
  return onSave
}

beforeEach(() => {
  fx.value = {
    rateDecimal: null, rateDate: undefined, isLoading: false, isError: false, disabledReason: undefined,
    rateQuote: undefined, isFinal: undefined, adoptRate: undefined,
  }
})

describe('SettlementRecordSheet — double-submit latch', () => {
  it('a rapid double-tap on 記録する fires onSave exactly once (TRIP_CURRENCY)', () => {
    const onSave = renderSheet()
    const btn = screen.getByRole('button', { name: '儲存紀錄' })
    fireEvent.click(btn)
    fireEvent.click(btn) // same-tick repeat, before any unmount re-render lands
    expect(onSave).toHaveBeenCalledTimes(1)
    const payload = onSave.mock.calls[0]![0]
    expect(payload).toMatchObject({ mode: 'TRIP_CURRENCY', fromUid: 'a', toUid: 'b', expectedRemainingMinor: 5000 })
    // TRIP_CURRENCY optimistic patch MUST NOT carry a source amount.
    expect(payload.optimistic).not.toHaveProperty('sourceAmountMinor')
  })
})

// The sheet shares useFxPreview's gate, but it also owns three bounds of
// its own — the default value, the submit check and the picker ceiling.
// All three have to be the user's day, or the sheet refuses a date the
// preview just accepted. Asserting the rendered maxDate is the only one
// of the three that no other test would notice going wrong.
describe('SettlementRecordSheet — the date bound is the user\'s day', () => {
  it('defaults settledOn and caps the picker at LOCAL today, not UTC today', () => {
    renderSheet()
    fireEvent.click(screen.getByRole('button', { name: 'pick-foreign' }))  // reveals the date field

    expect(screen.getByText(`date:${LOCAL_TODAY} max:${LOCAL_TODAY}`)).toBeTruthy()
  })

  it('accepts local today on submit', () => {
    fx.value = { ...fx.value, rateDecimal: '0.218', rateDate: '2026-06-03', rateQuote: { rateDecimal: '0.218', rateDate: '2026-06-03' }, isLoading: false, isError: false, disabledReason: undefined }
    const onSave = renderSheet()
    fireEvent.click(screen.getByRole('button', { name: 'pick-foreign' }))
    fireEvent.click(screen.getByRole('button', { name: '儲存紀錄' }))

    // The old UTC bound rejected this with 「無法換算未來日期」 for the
    // whole local morning east of Greenwich.
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave.mock.calls[0]![0]).toMatchObject({ settledOn: LOCAL_TODAY })
  })
})

describe('SettlementRecordSheet — foreign-mode submit gate', () => {
  it('blocks submit (no onSave) until an FX rate is confirmed', () => {
    const onSave = renderSheet()
    fireEvent.click(screen.getByRole('button', { name: 'pick-foreign' })) // → FOREIGN, no rate yet
    fireEvent.click(screen.getByRole('button', { name: '儲存紀錄' }))
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByText(/確認匯率/)).toBeTruthy()
  })

  it('does NOT latch on a blocked submit — a retry after the rate lands succeeds', () => {
    const onSave = renderSheet()
    fireEvent.click(screen.getByRole('button', { name: 'pick-foreign' }))
    fireEvent.click(screen.getByRole('button', { name: '儲存紀錄' })) // blocked (no rate) — must not latch
    expect(onSave).not.toHaveBeenCalled()

    // Rate arrives; the SAME open retries and now goes through.
    fx.value = { ...fx.value, rateDecimal: '0.218', rateDate: '2026-06-03', rateQuote: { rateDecimal: '0.218', rateDate: '2026-06-03' }, isLoading: false, isError: false, disabledReason: undefined }
    fireEvent.click(screen.getByRole('button', { name: 'pick-foreign' })) // re-render with the new fx value
    fireEvent.click(screen.getByRole('button', { name: '儲存紀錄' }))
    expect(onSave).toHaveBeenCalledTimes(1)
    const payload = onSave.mock.calls[0]![0]
    expect(payload).toMatchObject({ mode: 'FOREIGN_CURRENCY', sourceCurrency: 'TWD' })
    expect(payload.optimistic).toHaveProperty('sourceAmountMinor')
  })
})

// FX CAS: the sheet sends the rate it derived the source amount from; a
// refused provisional save unlatches and shows the refusal's rate as-is.
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
    const onSave = vi.fn<(p: SettlementRecordSubmit) => void | Promise<unknown>>()
      .mockRejectedValueOnce(refusal)
      .mockResolvedValueOnce(undefined)
    const onClose = vi.fn()
    render(
      <SettlementRecordSheet
        isOpen onClose={onClose} onSave={onSave}
        suggested={suggested} tripCurrency="JPY" members={members} isSaving={false}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'pick-foreign' }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '儲存紀錄' })) })

    expect(onSave.mock.calls[0]![0]).toMatchObject({
      mode: 'FOREIGN_CURRENCY',
      expectedFxRate: { rateDecimal: '4.6', rateDate: '2099-12-30' },
    })
    expect(typeof onSave.mock.calls[0]![0].reportInForm).toBe('function')
    expect(adoptRate).toHaveBeenCalledWith({ rateDecimal: '4.7', rateDate: '2099-12-31' })
    // The refusal is this sheet's own banner, and the sheet stays open.
    expect(screen.getByRole('alert').textContent).toMatch(/4.6（2099-12-30）→ 4.7（2099-12-31）/)
    expect(onClose).not.toHaveBeenCalled()

    // Unlatched: the user can confirm and save again; success closes it.
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '儲存紀錄' })) })
    expect(onSave).toHaveBeenCalledTimes(2)
    expect(onClose).toHaveBeenCalledOnce()
  })
})

// Whatever stops a foreign submit must be a validation error decided BEFORE
// the double-submit latch — an early return after it would leave the sheet
// silently stuck for the rest of this open.
describe('SettlementRecordSheet — foreign submit never latches without sending', () => {
  it('no confirmed rate yet: shows why, stays usable, and sends once the rate is there', () => {
    fx.value = {
      ...fx.value, rateDecimal: '0.218', rateDate: '2026-06-03', isLoading: false, isError: false,
      disabledReason: undefined, rateQuote: undefined, isFinal: true,
    }
    const onSave = vi.fn<(p: SettlementRecordSubmit) => void>()
    const view = render(
      <SettlementRecordSheet
        isOpen onClose={() => {}} onSave={onSave}
        suggested={suggested} tripCurrency="JPY" members={members} isSaving={false}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'pick-foreign' }))
    fireEvent.click(screen.getByRole('button', { name: '儲存紀錄' }))
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByText('請確認匯率後再儲存')).toBeTruthy()

    fx.value = { ...fx.value, rateQuote: { rateDecimal: '0.218', rateDate: '2026-06-03' } }
    view.rerender(
      <SettlementRecordSheet
        isOpen onClose={() => {}} onSave={onSave}
        suggested={suggested} tripCurrency="JPY" members={members} isSaving={false}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '儲存紀錄' }))
    expect(onSave).toHaveBeenCalledOnce()
    expect(onSave.mock.calls[0]![0]).toMatchObject({
      mode: 'FOREIGN_CURRENCY',
      expectedFxRate: { rateDecimal: '0.218', rateDate: '2026-06-03' },
    })
  })
})
