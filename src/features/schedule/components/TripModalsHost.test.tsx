import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { TripItem } from '@/features/trips/types'
import type { SchedulePageState } from '../hooks/useSchedulePageState'

vi.mock('@/features/trips/components/EditTripModal', () => ({
  default: ({ editTarget, onSave }: {
    editTarget: TripItem
    onSave: (data: TripItem) => void
  }) => <button type="button" onClick={() => onSave(editTarget)}>save-trip</button>,
}))
vi.mock('@/features/trips/components/CreateTripModal', () => ({ default: () => null }))
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

function state(saveTrip: (data: TripItem) => boolean, setEditTripOpen: (open: boolean) => void) {
  return {
    selectedTrip,
    schedules: [],
    editTripOpen: true,
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
})
