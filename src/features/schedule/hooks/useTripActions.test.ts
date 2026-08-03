import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { Trip } from '@/types'
import type { TripItem } from '@/features/trips/types'
import type { UseTripSelectionResult } from '@/features/trips/hooks/useTripSelection'
import type { AuthState } from '@/hooks/useAuth'

const mutationMocks = vi.hoisted(() => ({
  update: vi.fn(),
  remove: vi.fn(),
  leave:  vi.fn(),
  copy:   vi.fn(),
}))

vi.mock('@/features/trips/hooks/useTrips', () => ({
  useUpdateTrip: () => ({ mutate: mutationMocks.update }),
  useDeleteTrip: () => ({ mutate: mutationMocks.remove }),
  useLeaveTrip:  () => ({ mutate: mutationMocks.leave }),
  useCopyTrip:   () => ({ mutateAsync: mutationMocks.copy, isPending: false }),
}))

const toastMocks = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }))
vi.mock('@/shared/toast', () => ({ toast: toastMocks }))

import { useTripActions } from './useTripActions'

const ts = (iso: string) => ({ toDate: () => new Date(`${iso}T00:00:00`) })

const trip = (id: string, over: Partial<Trip> = {}): Trip => ({
  id, title: `Trip ${id}`, destination: 'Tokyo', ownerId: 'uid-1',
  startDate: ts('2026-09-18'), endDate: ts('2026-09-22'), currency: 'JPY',
  ...over,
}) as Trip

const item = (id: string, over: Partial<TripItem> = {}): TripItem => ({
  id, title: `Trip ${id}`, dest: 'Tokyo', emoji: '✈️',
  startDate: '2026-09-18', endDate: '2026-09-22', members: [],
  ownedByMe: true, currency: 'JPY', ...over,
}) as TripItem

const demoSelection = {
  trips: [], selectedTrip: item('demo'), selectedTripId: 'demo',
  selectTrip: vi.fn(), saveTrip: vi.fn(), deleteTrip: vi.fn(), reorderTrips: vi.fn(),
} as unknown as UseTripSelectionResult

const signedIn = { status: 'signed-in', user: { uid: 'uid-1' } } as unknown as AuthState

function render(over: Partial<Parameters<typeof useTripActions>[0]> = {}) {
  const spies = {
    setSelectedTripId:   vi.fn(),
    setTripOrder:        vi.fn(),
    resetActiveDate:     vi.fn(),
    clearScheduleDetail: vi.fn(),
    closeMembers:        vi.fn(),
    closeCopyTrip:       vi.fn(),
  }
  const hook = renderHook(() => useTripActions({
    isDemo: false,
    demoSelection,
    uid: 'uid-1',
    authState: signedIn,
    myTrips: [trip('a'), trip('b')],
    currentTrip: trip('a'),
    cloudTripsList: [item('a'), item('b')],
    copyTripSource: trip('a'),
    ...spies,
    ...over,
  }))
  return { hook, ...spies }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useTripActions delete', () => {
  it('switches off the doomed trip before the mutation runs', () => {
    const { hook, setSelectedTripId } = render()

    act(() => hook.result.current.deleteTrip('a'))

    // Ordering is the point: the UI must never render against a trip whose
    // subcollections are being torn down.
    expect(setSelectedTripId).toHaveBeenCalledWith('b')
    expect(setSelectedTripId.mock.invocationCallOrder[0]!)
      .toBeLessThan(mutationMocks.remove.mock.invocationCallOrder[0]!)
  })

  it('restores the previous selection when the delete fails', () => {
    const { hook, setSelectedTripId } = render()

    act(() => hook.result.current.deleteTrip('a'))
    act(() => mutationMocks.remove.mock.calls[0]![1].onError())

    expect(setSelectedTripId).toHaveBeenLastCalledWith('a')
  })

  it('leaves the selection alone when deleting some other trip', () => {
    const { hook, setSelectedTripId } = render()

    act(() => hook.result.current.deleteTrip('b'))

    expect(setSelectedTripId).not.toHaveBeenCalled()
    expect(mutationMocks.remove).toHaveBeenCalled()
  })
})

describe('useTripActions leave', () => {
  it('closes the members modal before switching away', () => {
    const { hook, closeMembers, setSelectedTripId } = render()

    act(() => hook.result.current.onLeaveTrip())

    // Left open, the modal would show a different trip's members.
    expect(closeMembers.mock.invocationCallOrder[0]!)
      .toBeLessThan(setSelectedTripId.mock.invocationCallOrder[0]!)
    expect(setSelectedTripId).toHaveBeenCalledWith('b')
  })

  it('restores the selection when leaving fails', () => {
    const { hook, setSelectedTripId } = render()

    act(() => hook.result.current.onLeaveTrip())
    act(() => mutationMocks.leave.mock.calls[0]![1].onError())

    expect(setSelectedTripId).toHaveBeenLastCalledWith('a')
  })
})

describe('useTripActions save', () => {
  it('sends only the fields that actually changed', () => {
    const { hook } = render()

    act(() => hook.result.current.saveTrip(item('a', { title: 'Renamed' })))

    expect(mutationMocks.update).toHaveBeenCalledWith({
      tripId: 'a', updates: { title: 'Renamed' },
    })
  })

  it('skips the write when nothing changed', () => {
    const { hook } = render()

    act(() => hook.result.current.saveTrip(item('a')))

    expect(mutationMocks.update).not.toHaveBeenCalled()
  })
})

describe('useTripActions reorder', () => {
  it('persists the new id order', () => {
    const { hook, setTripOrder } = render()

    act(() => hook.result.current.reorderTrips(0, 1))

    expect(setTripOrder).toHaveBeenCalledWith(['b', 'a'])
  })

  it('ignores a no-op drag', () => {
    const { hook, setTripOrder } = render()

    act(() => hook.result.current.reorderTrips(1, 1))

    expect(setTripOrder).not.toHaveBeenCalled()
  })
})

describe('useTripActions copy', () => {
  it('copies from the snapshot and closes the modal on success', async () => {
    mutationMocks.copy.mockResolvedValueOnce({
      trip: trip('c'), copiedSchedules: 2, copiedPlanItems: 0, orphanedSchedules: 0,
    })
    const { hook, setSelectedTripId, closeCopyTrip } = render()

    await act(async () => {
      await hook.result.current.onCopyTrip({ copySchedules: true } as never)
    })

    expect(mutationMocks.copy).toHaveBeenCalledWith(
      expect.objectContaining({ source: expect.objectContaining({ id: 'a' }) }),
    )
    expect(setSelectedTripId).toHaveBeenCalledWith('c')
    expect(closeCopyTrip).toHaveBeenCalled()
  })

  it('does nothing without a snapshot', async () => {
    const { hook } = render({ copyTripSource: null })

    await act(async () => {
      await hook.result.current.onCopyTrip({ copySchedules: true } as never)
    })

    expect(mutationMocks.copy).not.toHaveBeenCalled()
  })
})

describe('useTripActions demo mode', () => {
  it('defers to the local store instead of mutating Firestore', () => {
    const { hook } = render({ isDemo: true })

    act(() => hook.result.current.saveTrip(item('a', { title: 'x' })))
    act(() => hook.result.current.deleteTrip('a'))
    act(() => hook.result.current.reorderTrips(0, 1))

    expect(demoSelection.saveTrip).toHaveBeenCalled()
    expect(demoSelection.deleteTrip).toHaveBeenCalled()
    expect(demoSelection.reorderTrips).toHaveBeenCalled()
    expect(mutationMocks.update).not.toHaveBeenCalled()
    expect(mutationMocks.remove).not.toHaveBeenCalled()
  })
})
