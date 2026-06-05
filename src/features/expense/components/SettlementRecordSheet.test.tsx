// Render + fireEvent tests for SettlementRecordSheet — the parts that pure
// fns can't cover: the synchronous double-submit latch and the foreign-mode
// submit gate. The portal/animation shell (FormModalShell→BottomSheet) and
// the input widgets (CurrencyPicker/DatePicker) are stubbed to minimal
// pass-throughs so the test exercises THIS component's logic, not theirs.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { ReactNode } from 'react'

// FormModalShell does exactly this in production: render children + a footer
// SaveButton whose onClick is the passed onSave. The latch under test lives
// in SettlementRecordSheet.handleSubmit, NOT the shell, so a faithful stub
// keeps the test focused.
vi.mock('@/components/ui/FormModalShell', () => ({
  default: ({ isOpen, saveLabel, onSave, children }: {
    isOpen: boolean; saveLabel: string; onSave: () => void; children: ReactNode
  }) => (isOpen ? <div>{children}<button type="button" onClick={onSave}>{saveLabel}</button></div> : null),
}))
// CurrencyPicker stub exposes a button that flips to a foreign code so a test
// can drive FOREIGN_CURRENCY mode without the real dropdown.
vi.mock('@/components/ui/CurrencyPicker', () => ({
  default: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <div><span>cur:{value}</span><button type="button" onClick={() => onChange('TWD')}>pick-foreign</button></div>
  ),
}))
vi.mock('@/components/ui/pickers/DatePicker', () => ({
  default: ({ value }: { value: string }) => <div>date:{value}</div>,
}))

// useFxPreview is controllable per-test via this hoisted holder.
const fx = vi.hoisted(() => ({
  value: {
    rateDecimal:    null as string | null,
    rateDate:       undefined as string | undefined,
    isLoading:      false,
    isError:        false,
    disabledReason: undefined as string | undefined,
  },
}))
vi.mock('@/hooks/useFxPreview', () => ({ useFxPreview: () => fx.value }))

import SettlementRecordSheet, { type SettlementRecordSubmit } from './SettlementRecordSheet'
import type { TripMember } from '@/features/trips/types'

const members: TripMember[] = [
  { id: 'a', label: 'A', color: '#000', bg: '#fff' },
  { id: 'b', label: 'B', color: '#000', bg: '#fff' },
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
  fx.value = { rateDecimal: null, rateDate: undefined, isLoading: false, isError: false, disabledReason: undefined }
})

describe('SettlementRecordSheet — double-submit latch', () => {
  it('a rapid double-tap on 記録する fires onSave exactly once (TRIP_CURRENCY)', () => {
    const onSave = renderSheet()
    const btn = screen.getByRole('button', { name: '記録する' })
    fireEvent.click(btn)
    fireEvent.click(btn) // same-tick repeat, before any unmount re-render lands
    expect(onSave).toHaveBeenCalledTimes(1)
    const payload = onSave.mock.calls[0]![0]
    expect(payload).toMatchObject({ mode: 'TRIP_CURRENCY', fromUid: 'a', toUid: 'b', expectedRemainingMinor: 5000 })
    // TRIP_CURRENCY optimistic patch MUST NOT carry a source amount.
    expect(payload.optimistic).not.toHaveProperty('sourceAmountMinor')
  })
})

describe('SettlementRecordSheet — foreign-mode submit gate', () => {
  it('blocks submit (no onSave) until an FX rate is confirmed', () => {
    const onSave = renderSheet()
    fireEvent.click(screen.getByRole('button', { name: 'pick-foreign' })) // → FOREIGN, no rate yet
    fireEvent.click(screen.getByRole('button', { name: '記録する' }))
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByText(/換算レートを確定/)).toBeTruthy()
  })

  it('does NOT latch on a blocked submit — a retry after the rate lands succeeds', () => {
    const onSave = renderSheet()
    fireEvent.click(screen.getByRole('button', { name: 'pick-foreign' }))
    fireEvent.click(screen.getByRole('button', { name: '記録する' })) // blocked (no rate) — must not latch
    expect(onSave).not.toHaveBeenCalled()

    // Rate arrives; the SAME open retries and now goes through.
    fx.value = { rateDecimal: '0.218', rateDate: '2026-06-03', isLoading: false, isError: false, disabledReason: undefined }
    fireEvent.click(screen.getByRole('button', { name: 'pick-foreign' })) // re-render with the new fx value
    fireEvent.click(screen.getByRole('button', { name: '記録する' }))
    expect(onSave).toHaveBeenCalledTimes(1)
    const payload = onSave.mock.calls[0]![0]
    expect(payload).toMatchObject({ mode: 'FOREIGN_CURRENCY', sourceCurrency: 'TWD' })
    expect(payload.optimistic).toHaveProperty('sourceAmountMinor')
  })
})
