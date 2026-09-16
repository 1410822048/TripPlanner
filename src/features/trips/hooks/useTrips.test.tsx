import { createElement, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { Timestamp } from 'firebase/firestore'
import type { User } from 'firebase/auth'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Trip } from '@/types/trip'

const mocks = vi.hoisted(() => ({
  uid: 'u1' as string | undefined,
  getMyTrips: vi.fn(), subscribeToMyTrips: vi.fn(), createTrip: vi.fn(), copyTrip: vi.fn(),
  deleteTrip: vi.fn(), leaveMember: vi.fn(), acceptInvite: vi.fn(), clearTrip: vi.fn(),
  getMembersByTrip: vi.fn(), subscribeToMembers: vi.fn(),
}))
vi.mock('@/hooks/useAuth', () => ({ useUid: () => mocks.uid }))
vi.mock('../services/tripService', () => ({
  getMyTrips: mocks.getMyTrips, subscribeToMyTrips: mocks.subscribeToMyTrips,
  createTrip: mocks.createTrip, updateTrip: vi.fn(), setWishVotingDeadline: vi.fn(),
}))
vi.mock('../services/tripCopy', () => ({ copyTrip: mocks.copyTrip }))
vi.mock('../services/tripCascade', () => ({ deleteTrip: mocks.deleteTrip }))
vi.mock('@/features/members/services/memberService', () => ({
  leaveMember: mocks.leaveMember, getMembersByTrip: mocks.getMembersByTrip,
  subscribeToMembers: mocks.subscribeToMembers,
}))
vi.mock('../invites/inviteService', () => ({
  acceptInvite: mocks.acceptInvite, createInvite: vi.fn(), listInvites: vi.fn(),
  listInvitesFromServer: vi.fn(), subscribeToInvites: vi.fn(), revokeInvite: vi.fn(),
}))
vi.mock('@/store/lastViewedStore', () => ({ useLastViewedStore: { getState: () => ({ clearTrip: mocks.clearTrip }) } }))
vi.mock('@/services/sentry', () => ({ captureError: vi.fn() }))
import { useMyTrips, useCreateTrip, useCopyTrip, useDeleteTrip, useLeaveTrip } from './useTrips'
import { useAcceptInvite } from '../invites/useInvites'
import { useAllTripMembers } from '@/features/members/hooks/useAllTripMembers'
import { tripKeys } from '../queryKeys'

const USER = { uid: 'u1' } as User
function trip(id: string): Trip {
  const ts = Timestamp.fromMillis(1)
  return { id, title: id, destination: 'Taipei', startDate: ts, endDate: ts,
    currency: 'TWD', defaultCountryCode: 'TW', ownerId: 'u1', memberIds: ['u1'],
    formerMemberNames: {}, createdAt: ts, updatedAt: ts,
    wishVotingDeadlineAt: null, wishVotingDeadlineNotifiedAt: null }
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: qc }, children)
  return { qc, wrapper }
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.uid = 'u1'
  mocks.getMyTrips.mockResolvedValue([trip('a'), trip('b')])
  mocks.subscribeToMyTrips.mockResolvedValue(vi.fn())
  mocks.getMembersByTrip.mockResolvedValue([])
  mocks.subscribeToMembers.mockResolvedValue(vi.fn())
})

describe('useMyTrips integration', () => {
  it('shares its query with member consumers, derives IDs and ignores metadata-only changes for member listeners', async () => {
    const { qc, wrapper } = setup()
    const view = renderHook(() => ({ trips: useMyTrips('u1'), members: useAllTripMembers('u1') }), { wrapper })
    await waitFor(() => expect(view.result.current.members.tripIds).toEqual(['a', 'b']))
    expect(mocks.subscribeToMyTrips).toHaveBeenCalledTimes(1)
    expect(mocks.subscribeToMembers).toHaveBeenCalledTimes(2)
    expect(qc.getQueryData(['trips', 'my-ids', 'u1'])).toBeUndefined()
    const push = mocks.subscribeToMyTrips.mock.calls[0]![1] as (rows: Trip[]) => void
    act(() => push([{ ...trip('a'), title: 'renamed' }, trip('b')]))
    await waitFor(() => expect(view.result.current.members.trips?.[0]?.title).toBe('renamed'))
    expect(mocks.subscribeToMembers).toHaveBeenCalledTimes(2)
    act(() => push([trip('b')]))
    await waitFor(() => expect(view.result.current.members.tripIds).toEqual(['b']))
    expect(view.result.current.members.memberResults).toHaveLength(1)
  })

  it('retains a complete initial result until the first full snapshot', async () => {
    const { wrapper } = setup()
    const view = renderHook(() => useMyTrips('u1'), { wrapper })
    await waitFor(() => expect(view.result.current.data).toHaveLength(2))
    const push = mocks.subscribeToMyTrips.mock.calls[0]![1] as (rows: Trip[]) => void
    act(() => push([]))
    await waitFor(() => expect(view.result.current.data).toEqual([]))
  })

  it('disables signed-out reads and isolates an account switch from late pushes', async () => {
    mocks.uid = undefined
    const { wrapper, qc } = setup()
    const view = renderHook(() => useMyTrips(mocks.uid), { wrapper })
    expect(mocks.getMyTrips).not.toHaveBeenCalled()
    expect(mocks.subscribeToMyTrips).not.toHaveBeenCalled()
    mocks.uid = 'u1'; view.rerender()
    await waitFor(() => expect(view.result.current.data).toHaveLength(2))
    const oldPush = mocks.subscribeToMyTrips.mock.calls[0]![1] as (rows: Trip[]) => void
    mocks.getMyTrips.mockResolvedValue([trip('other-account')])
    mocks.uid = 'u2'; view.rerender()
    await waitFor(() => expect(view.result.current.data?.[0]?.id).toBe('other-account'))
    act(() => oldPush([trip('old-account')]))
    expect(qc.getQueryData(tripKeys.mine('u2'))).toEqual([trip('other-account')])
    expect(qc.getQueryData(tripKeys.mine('u1'))).toEqual([trip('a'), trip('b')])
  })

  it('seeds only the trip list on create, copy and redeem', async () => {
    const { qc, wrapper } = setup()
    qc.setQueryData(tripKeys.mine('u1'), [trip('a')])
    mocks.createTrip.mockResolvedValue(trip('created'))
    mocks.copyTrip.mockResolvedValue({ trip: trip('copied'), copiedSchedules: 0, copiedPlanItems: 0, warning: null })
    mocks.acceptInvite.mockResolvedValue({ trip: trip('joined') })
    const view = renderHook(() => ({ create: useCreateTrip(), copy: useCopyTrip(), redeem: useAcceptInvite() }), { wrapper })
    await act(async () => {
      await view.result.current.create.mutateAsync({ user: USER, input: { title: 'new', destination: 'Taipei', currency: 'TWD', defaultCountryCode: 'TW', startDate: '2026-09-15', endDate: '2026-09-16' } })
      await view.result.current.copy.mutateAsync({ user: USER, source: trip('a'), input: { title: 'copy', newStartDate: '2026-09-15', copySchedules: false, copyPlanning: false } })
      await view.result.current.redeem.mutateAsync({ user: USER, tripId: 'joined', token: 'token' })
    })
    expect(qc.getQueryData<Trip[]>(tripKeys.mine('u1'))?.map(t => t.id)).toEqual(['joined', 'copied', 'created', 'a'])
    expect(qc.getQueryData(['trips', 'my-ids', 'u1'])).toBeUndefined()
  })

  describe.each(['delete', 'leave'] as const)('%s mutation', kind => {
    function useRemoval() {
      const deletion = useDeleteTrip('u1'), leave = useLeaveTrip('u1')
      return kind === 'delete' ? deletion : leave
    }
    it('removes optimistically, rolls back a real failure, and reconciles a lost success response', async () => {
      const { qc, wrapper } = setup()
      const pending = deferred<void>()
      const mutate = kind === 'delete' ? mocks.deleteTrip : mocks.leaveMember
      mutate.mockReturnValue(pending.promise)
      const view = renderHook(() => ({ trips: useMyTrips('u1'), mutation: useRemoval() }), { wrapper })
      await waitFor(() => expect(view.result.current.trips.data).toHaveLength(2))
      let finished!: Promise<unknown>
      act(() => { finished = view.result.current.mutation.mutateAsync('a').catch(e => e) })
      await waitFor(() => expect(qc.getQueryData<Trip[]>(tripKeys.mine('u1'))?.map(t => t.id)).toEqual(['b']))
      await act(async () => { pending.reject(new Error('actual failure')); await finished })
      await waitFor(() => expect(view.result.current.trips.data).toHaveLength(2))
      const lost = deferred<void>()
      mutate.mockReturnValue(lost.promise)
      act(() => { finished = view.result.current.mutation.mutateAsync('a').catch(e => e) })
      await waitFor(() => expect(qc.getQueryData<Trip[]>(tripKeys.mine('u1'))?.map(t => t.id)).toEqual(['b']))
      const push = mocks.subscribeToMyTrips.mock.calls[0]![1] as (rows: Trip[]) => void
      mocks.getMyTrips.mockResolvedValue([trip('b')])
      act(() => push([trip('b')]))
      await act(async () => { lost.reject(new Error('response lost')); await finished })
      await waitFor(() => expect(view.result.current.trips.data?.map(t => t.id)).toEqual(['b']))
      expect(mocks.getMyTrips).toHaveBeenCalledTimes(3)
    })

    it('cleans lastViewed and reconciles after success', async () => {
      const { wrapper } = setup()
      const mutate = kind === 'delete' ? mocks.deleteTrip : mocks.leaveMember
      mutate.mockResolvedValue(undefined)
      const view = renderHook(() => ({ trips: useMyTrips('u1'), mutation: useRemoval() }), { wrapper })
      await waitFor(() => expect(view.result.current.trips.data).toHaveLength(2))
      mocks.getMyTrips.mockResolvedValue([trip('b')])
      await act(async () => { await view.result.current.mutation.mutateAsync('a') })
      await waitFor(() => expect(view.result.current.trips.data?.map(t => t.id)).toEqual(['b']))
      expect(mocks.clearTrip).toHaveBeenCalledWith('a')
    })
  })
})
