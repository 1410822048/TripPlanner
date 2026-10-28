import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { TripItem } from '@/features/trips/types'
import type { SchedulePageState } from '../hooks/useSchedulePageState'

vi.mock('@/features/trips/components/EditTripModal', () => ({
  default: ({ editTarget, scheduleDates, saveError, onSave }: {
    editTarget: TripItem
    scheduleDates: string[]
    saveError?: string | null
    onSave: (data: TripItem) => void
  }) => (
    <>
      <button type="button" onClick={() => onSave(editTarget)}>save-trip</button>
      <output data-testid="edit-target">{editTarget.id}</output>
      <output data-testid="schedule-dates">{scheduleDates.join(',')}</output>
      {saveError && <div role="alert">{saveError}</div>}
    </>
  ),
}))
vi.mock('@/features/trips/components/CreateTripModal', () => ({
  default: function CreateTripStub() {
    // Fresh instance per key: the counter only advances on mount.
    const [gen] = useState(() => ++createMounts.n)
    return <output data-testid="create-trip">gen-{gen}</output>
  },
}))
const createMounts = vi.hoisted(() => ({ n: 0 }))
vi.mock('./ScheduleFormModal', () => ({ default: () => null }))
vi.mock('./ScheduleReadonlyModal', () => ({ default: () => null }))
vi.mock('@/features/trips/components/CopyTripModal', () => ({ default: () => null }))
vi.mock('@/features/members/components/MembersModal', () => ({ default: () => null }))
vi.mock('@/features/auth/components/SignInPromptModal', () => ({ default: () => null }))

import TripModalsHost from './TripModalsHost'

const selectedTrip = {
  id: 'trip-1', title: 'Tokyo', dest: 'Tokyo', emoji: '✈️',
  startDate: '2026-09-18', endDate: '2026-09-22', members: [],
  ownedByMe: true, currency: 'JPY', defaultCountryCode: 'JP',
} as TripItem

function state(
  saveTrip: (data: TripItem) => boolean,
  setEditTripOpen: (open: boolean) => void,
  over: Partial<SchedulePageState> = {},
) {
  return {
    selectedTrip,
    schedules: [],
    editTripOpen: true,
    editTripScopeChanged: false,
    editTripSaveError: null,
    setEditTripSaveError: vi.fn(),
    editTripGeneration: 1,
    createTripGeneration: 0,
    saveTrip,
    setEditTripOpen,
    scheduleModal: { isOpen: false },
    scheduleDetailTarget: null,
    createTripOpen: false,
    copyTripOpen: false,
    inviteOpen: false,
    inviteScannerOpen: false,
    membersOpen: false,
    signInOpen: false,
    currentTrip: null,
    ...over,
  } as unknown as SchedulePageState
}

describe('TripModalsHost trip-save lifecycle', () => {
  it('keeps the edit sheet mounted when the save preflight rejects', () => {
    const setEditTripOpen = vi.fn()
    render(<TripModalsHost state={state(() => false, setEditTripOpen)} />)

    fireEvent.click(screen.getByRole('button', { name: 'save-trip' }))

    expect(setEditTripOpen).not.toHaveBeenCalled()
  })

  it('closes the edit sheet after an accepted save', () => {
    const setEditTripOpen = vi.fn()
    render(<TripModalsHost state={state(() => true, setEditTripOpen)} />)

    fireEvent.click(screen.getByRole('button', { name: 'save-trip' }))

    expect(setEditTripOpen).toHaveBeenCalledWith(false)
  })

  it('refuses the save in place once the scope changed, before saveTrip can run', () => {
    const saveTrip = vi.fn(() => true)
    const setEditTripOpen = vi.fn()
    const setEditTripSaveError = vi.fn()
    render(<TripModalsHost state={state(saveTrip, setEditTripOpen, { editTripScopeChanged: true, setEditTripSaveError })} />)

    fireEvent.click(screen.getByRole('button', { name: 'save-trip' }))

    expect(saveTrip).not.toHaveBeenCalled()
    expect(setEditTripOpen).not.toHaveBeenCalled()
    expect(setEditTripSaveError).toHaveBeenCalledWith('旅程或帳號已切換，請關閉表單後重新開啟')
  })

  it('shows the refusal in the sheet and keeps it mounted', () => {
    render(<TripModalsHost state={state(() => true, vi.fn(), { editTripScopeChanged: true, editTripSaveError: '旅程或帳號已切換，請關閉表單後重新開啟' })} />)

    expect(screen.getByRole('alert').textContent).toContain('旅程或帳號已切換')
    expect(screen.getByRole('button', { name: 'save-trip' })).toBeTruthy()
  })

  it('drops the scope refusal once the selection is back on the opened trip (A→B→A)', () => {
    const refusal = '旅程或帳號已切換，請關閉表單後重新開啟'
    const { rerender } = render(<TripModalsHost state={state(() => true, vi.fn(), { editTripScopeChanged: true, editTripSaveError: refusal })} />)
    expect(screen.getByRole('alert')).toBeTruthy()

    rerender(<TripModalsHost state={state(() => true, vi.fn(), { editTripScopeChanged: false, editTripSaveError: refusal })} />)
    expect(screen.queryByRole('alert')).toBeNull()

    // 其他錯誤不受影響。
    rerender(<TripModalsHost state={state(() => true, vi.fn(), { editTripSaveError: '儲存失敗' })} />)
    expect(screen.getByRole('alert').textContent).toContain('儲存失敗')
  })

  it('does not compute the orphan warning from another trip schedules after a switch', () => {
    const schedules = [{ date: '2026-09-19' }]
    const { rerender } = render(<TripModalsHost state={state(() => true, vi.fn(), { schedules } as never)} />)
    expect(screen.getByTestId('schedule-dates').textContent).toBe('2026-09-19')

    rerender(<TripModalsHost state={state(() => true, vi.fn(), { schedules: [{ date: '2026-12-01' }], editTripScopeChanged: true } as never)} />)
    expect(screen.getByTestId('schedule-dates').textContent).toBe('')
  })

  it('keeps editing the trip it was opened on when the selection switches underneath', () => {
    // Keyed by open generation, not by the live trip id: a background
    // reselect (kick / remote delete) must not remount the form with
    // trip B's data — the draft is A's, and the save is refused by scope.
    const setEditTripOpen = vi.fn()
    const { rerender } = render(<TripModalsHost state={state(() => true, setEditTripOpen)} />)
    expect(screen.getByTestId('edit-target').textContent).toContain('trip-1')

    const other = { ...selectedTrip, id: 'trip-2', title: 'Osaka' } as TripItem
    rerender(<TripModalsHost state={state(() => true, setEditTripOpen, { selectedTrip: other, editTripScopeChanged: true })} />)

    expect(screen.getByTestId('edit-target').textContent).toContain('trip-1')
    expect(setEditTripOpen).not.toHaveBeenCalled()

    // And when the trip vanishes entirely (no-trip), the sheet still stands.
    rerender(<TripModalsHost state={state(() => true, setEditTripOpen, { selectedTrip: null, editTripScopeChanged: true })} />)
    expect(screen.getByTestId('edit-target').textContent).toContain('trip-1')
  })

  it('mounts a fresh edit sheet per open generation', () => {
    const { rerender } = render(<TripModalsHost state={state(() => true, vi.fn(), { editTripGeneration: 1 })} />)
    const other = { ...selectedTrip, id: 'trip-2', title: 'Osaka' } as TripItem
    rerender(<TripModalsHost state={state(() => true, vi.fn(), { editTripGeneration: 2, selectedTrip: other })} />)

    expect(screen.getByTestId('edit-target').textContent).toContain('trip-2')
  })
})

describe('TripModalsHost create-trip instance', () => {
  it('renders the create sheet only while open, as a new instance per generation', () => {
    const { rerender } = render(<TripModalsHost state={state(() => true, vi.fn(), { editTripOpen: false, createTripOpen: false })} />)
    expect(screen.queryByTestId('create-trip')).toBeNull()

    rerender(<TripModalsHost state={state(() => true, vi.fn(), { editTripOpen: false, createTripOpen: true, createTripGeneration: 1 })} />)
    expect(screen.getByTestId('create-trip').textContent).toContain('gen-1')

    rerender(<TripModalsHost state={state(() => true, vi.fn(), { editTripOpen: false, createTripOpen: true, createTripGeneration: 2 })} />)
    expect(screen.getByTestId('create-trip').textContent).toContain('gen-2')
  })
})
