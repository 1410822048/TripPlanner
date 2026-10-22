// @vitest-environment jsdom
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

const compatibility = vi.hoisted(() => ({ writeBlockReason: null as string | null }))
vi.mock('@/services/clientCompatibility', () => ({
  getClientWriteBlockReason: () => compatibility.writeBlockReason,
}))

import { useTripActions } from './useTripActions'
import { FORM_SCOPE_CHANGED_MESSAGE } from '@/hooks/useFormModal'
import { OFFLINE_NEEDS_CONNECTION_MESSAGE } from '@/utils/offlineHandOff'

// Stored trip dates are 00:00 UTC (toTripDateTimestamp).
const ts = (iso: string) => {
  const ms = Date.parse(`${iso}T00:00:00Z`)
  return { toDate: () => new Date(ms), toMillis: () => ms }
}

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
    copyTripOpenedUid: 'uid-1',
    ...spies,
    ...over,
  }))
  return { hook, ...spies }
}

beforeEach(() => {
  vi.clearAllMocks()
  compatibility.writeBlockReason = null
})

describe('useTripActions delete', () => {
  it('rejects an obsolete bundle before changing the selected trip', () => {
    compatibility.writeBlockReason = '請先更新 App 才能儲存'
    const { hook, setSelectedTripId } = render()

    act(() => hook.result.current.deleteTrip('a'))

    expect(setSelectedTripId).not.toHaveBeenCalled()
    expect(mutationMocks.remove).not.toHaveBeenCalled()
    expect(toastMocks.error).toHaveBeenCalledWith('請先更新 App 才能儲存')
  })

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

  it('never discards the chosen day, on any delete outcome', () => {
    const { hook, resetActiveDate } = render()

    // The day derivation already falls back when activeDate falls outside the
    // selected trip. Resetting up front dropped the day on every failure, and
    // resetting in onSuccess let a late callback wipe a day the user picked
    // after switching trips — so neither path touches it.
    act(() => hook.result.current.deleteTrip('a'))
    act(() => mutationMocks.remove.mock.calls[0]![1].onError())
    act(() => mutationMocks.remove.mock.calls[0]![1].onSuccess())

    expect(resetActiveDate).not.toHaveBeenCalled()
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

  it('never discards the chosen day, on any leave outcome', () => {
    const { hook, resetActiveDate } = render()

    act(() => hook.result.current.onLeaveTrip())
    act(() => mutationMocks.leave.mock.calls[0]![1].onError())
    act(() => mutationMocks.leave.mock.calls[0]![1].onSuccess())

    expect(resetActiveDate).not.toHaveBeenCalled()
  })
})

describe('useTripActions save', () => {
  it('returns false and preserves the form when the bundle is obsolete', () => {
    compatibility.writeBlockReason = '請先更新 App 才能儲存'
    const { hook, resetActiveDate } = render()
    let accepted = true

    act(() => { accepted = hook.result.current.saveTrip(item('a', { title: 'Draft' })) })

    expect(accepted).toBe(false)
    expect(resetActiveDate).not.toHaveBeenCalled()
    expect(mutationMocks.update).not.toHaveBeenCalled()
    expect(toastMocks.error).toHaveBeenCalledWith('請先更新 App 才能儲存')
  })

  it('sends only the fields that actually changed', () => {
    const { hook } = render()
    let accepted = false

    act(() => { accepted = hook.result.current.saveTrip(item('a', { title: 'Renamed' })) })

    expect(accepted).toBe(true)
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
  const input = { copySchedules: true } as never
  const stillOpen = () => true
  const copied = () => mutationMocks.copy.mockResolvedValueOnce({
    trip: trip('c'), copiedSchedules: 2, copiedPlanItems: 0, orphanedSchedules: 0,
  })

  it('refuses synchronously (no write, draft kept) when the bundle becomes obsolete', () => {
    compatibility.writeBlockReason = '請先更新 App 才能儲存'
    const { hook } = render()
    let result: unknown = 'unset'

    act(() => { result = hook.result.current.onCopyTrip(input, stillOpen) })

    // Nothing returned → the sheet has nothing to track and stays as it is.
    expect(result).toBeUndefined()
    expect(mutationMocks.copy).not.toHaveBeenCalled()
    expect(toastMocks.error).toHaveBeenCalledWith('請先更新 App 才能儲存')
  })

  it('copies from the snapshot, hands the write to the sheet and switches to the new trip while it is still open', async () => {
    copied()
    const { hook, setSelectedTripId, resetActiveDate } = render()

    let pending: unknown
    act(() => { pending = hook.result.current.onCopyTrip(input, stillOpen) })
    await act(async () => { await pending })

    expect(pending).toBeInstanceOf(Promise)
    expect(mutationMocks.copy).toHaveBeenCalledWith(
      expect.objectContaining({ source: expect.objectContaining({ id: 'a' }), user: { uid: 'uid-1' } }),
    )
    expect(setSelectedTripId).toHaveBeenCalledWith('c')
    expect(resetActiveDate).toHaveBeenCalled()
    expect(toastMocks.success).toHaveBeenCalled()
  })

  it('only reports a result that lands after the sheet was dismissed or reopened', async () => {
    // The trip is in the cache via onSuccess; switching to it would yank
    // the user away from whatever they opened since, and closing would hit
    // the NEW sheet instance (useAwaitedSave liveness is per instance).
    copied()
    const { hook, setSelectedTripId, resetActiveDate } = render()

    await act(async () => { await hook.result.current.onCopyTrip(input, () => false) })

    expect(mutationMocks.copy).toHaveBeenCalled()
    expect(toastMocks.success).toHaveBeenCalled()
    expect(setSelectedTripId).not.toHaveBeenCalled()
    expect(resetActiveDate).not.toHaveBeenCalled()
  })

  it('refuses when the account changed under the sheet — never copies with the old uid', () => {
    // The sheet was opened by uid-1; uid-2 is signed in now. The captured
    // uid is not a credential, and the live user must not get uid-1's copy.
    const { hook } = render({
      authState: { status: 'signed-in', user: { uid: 'uid-2' } } as unknown as AuthState,
      uid: 'uid-2',
    })

    act(() => { hook.result.current.onCopyTrip(input, stillOpen) })

    expect(mutationMocks.copy).not.toHaveBeenCalled()
    expect(toastMocks.error).toHaveBeenCalledWith(FORM_SCOPE_CHANGED_MESSAGE)
  })

  it('refuses while offline instead of queueing or pretending: copyTrip needs the server', () => {
    vi.stubGlobal('navigator', { onLine: false })
    try {
      const { hook } = render()
      let result: unknown = 'unset'

      act(() => { result = hook.result.current.onCopyTrip(input, stillOpen) })

      expect(result).toBeUndefined()
      expect(mutationMocks.copy).not.toHaveBeenCalled()
      expect(toastMocks.error).toHaveBeenCalledWith(OFFLINE_NEEDS_CONNECTION_MESSAGE)
      expect(toastMocks.info).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('propagates a failed copy to the sheet without switching trips', async () => {
    mutationMocks.copy.mockRejectedValueOnce(new Error('boom'))
    const { hook, setSelectedTripId } = render()

    let pending: unknown
    act(() => { pending = hook.result.current.onCopyTrip(input, stillOpen) })
    await act(async () => { await expect(pending).rejects.toThrow('boom') })

    expect(setSelectedTripId).not.toHaveBeenCalled()
    // The global MutationCache.onError toasts it (COPY_TRIP) — not here.
    expect(toastMocks.error).not.toHaveBeenCalled()
  })

  it('does nothing without a snapshot', () => {
    const { hook } = render({ copyTripSource: null })

    act(() => { hook.result.current.onCopyTrip(input, stillOpen) })

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
