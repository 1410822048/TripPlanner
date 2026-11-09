import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

const harness = vi.hoisted(() => ({
  tripId: 'trip-a',
  display: '2026-06-17',
  uid: 'u1' as string | undefined,
}))

vi.mock('@/hooks/useAuth', () => ({ useUid: () => harness.uid }))
vi.mock('../routeModel', () => ({ routeOptimizationAvailability: () => ({ status: 'ready' }) }))
vi.mock('../hooks/useSchedulePageState', () => ({
  useSchedulePageState: () => ({
    isDemo: false, canWrite: true, roleCanWrite: true, writeCompatible: true,
    isOwner: true, canOwnerWrite: true,
    cloudTripsLoading: false, cloudTripsError: null, cloudTripsEmpty: false, refetchTrips: vi.fn(),
    trips: [], selectedTrip: { id: harness.tripId, currency: 'TWD' },
    dateRange: [harness.display], display: harness.display, items: [], dayTotal: 0,
    schedules: [], tripTotal: 0, grouped: {}, isLoading: false,
    selectTrip: vi.fn(), deleteTrip: vi.fn(), reorderTrips: vi.fn(), handleMenuAction: vi.fn(),
    scheduleModal: { openAdd: vi.fn() }, setActiveDate: vi.fn(),
    setCreateTripOpen: vi.fn(), setEditTripOpen: vi.fn(), setInviteOpen: vi.fn(),
    setInviteScannerOpen: vi.fn(), setSignInOpen: vi.fn(),
    hasOpenModal: false, openScheduleDetail: vi.fn(),
  }),
}))
vi.mock('@/features/trips/components/TripSwitcher', () => ({ default: () => null }))
vi.mock('@/features/trips/components/TripHeaderCard', () => ({ default: () => null }))
vi.mock('./DaySelector', () => ({ default: () => null }))
vi.mock('./DayTimeline', () => ({
  default: (props: { routeAction?: { onClick: () => void } }) => (
    <button type="button" onClick={() => props.routeAction?.onClick()}>open route</button>
  ),
}))
vi.mock('./RoutePreviewModal', () => ({
  default: (props: { isOpen: boolean; tripId: string }) =>
    props.isOpen ? <div role="dialog" aria-label="route-preview">{props.tripId}</div> : null,
}))

import SchedulePage from './SchedulePage'

beforeEach(() => {
  harness.tripId = 'trip-a'
  harness.display = '2026-06-17'
  harness.uid = 'u1'
})

describe('SchedulePage route preview scope', () => {
  it('closes for good when the trip changes underneath it, even on A→B→A', async () => {
    const { rerender } = render(<SchedulePage />)
    fireEvent.click(screen.getByRole('button', { name: 'open route' }))
    expect(await screen.findByRole('dialog', { name: 'route-preview' })).toBeTruthy()

    harness.tripId = 'trip-b'   // background reselect after kick / remote delete
    rerender(<SchedulePage />)
    expect(screen.queryByRole('dialog', { name: 'route-preview' })).toBeNull()

    harness.tripId = 'trip-a'
    rerender(<SchedulePage />)
    expect(screen.queryByRole('dialog', { name: 'route-preview' })).toBeNull()
  })

  it('closes when the account changes', async () => {
    const { rerender } = render(<SchedulePage />)
    fireEvent.click(screen.getByRole('button', { name: 'open route' }))
    expect(await screen.findByRole('dialog', { name: 'route-preview' })).toBeTruthy()

    harness.uid = 'u2'
    rerender(<SchedulePage />)
    expect(screen.queryByRole('dialog', { name: 'route-preview' })).toBeNull()
  })
})
