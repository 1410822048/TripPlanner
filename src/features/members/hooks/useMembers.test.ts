// What a snapshot-and-rollback could not do, and an overlay does by
// construction: undo exactly one operation. The roster list is realtime, so
// the cache it would have restored is a moving target.
import { QueryClient, QueryClientProvider, hashKey } from '@tanstack/react-query'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import type { Member } from '@/types'

vi.mock('@/hooks/useAuth', () => ({ useUid: () => 'uid-1' }))

const serviceMocks = vi.hoisted(() => ({
  getMembersByTrip:           vi.fn(),
  getMembersByTripFromServer: vi.fn(),
  subscribeToMembers:         vi.fn(),
  removeMember:               vi.fn(),
  updateMemberRole:           vi.fn(),
  transferOwnership:          vi.fn(),
}))

vi.mock('../services/memberService', () => serviceMocks)

import { memberOverlay, useMembers, useRemoveMember, useUpdateMemberRole } from './useMembers'

const TRIP = 'trip-1'
const KEY_HASH = hashKey(['members', TRIP, 'uid-1'])

const row = (id: string, role: Member['role'] = 'editor') => ({ id, role }) as Member
const rejectedErr = () => Object.assign(new Error('403'), { name: 'WorkerRejected' })

/** Server truth from the listener's last push, with the overlay replayed —
 *  i.e. what the modal actually renders. */
function visible(): { id: string; role: Member['role'] }[] {
  const base = queryClient.getQueryData<Member[]>(['members', TRIP, 'uid-1']) ?? []
  return memberOverlay.merge(base, memberOverlay.getSnapshot(KEY_HASH))
    .map(m => ({ id: m.id, role: m.role }))
}

let queryClient: QueryClient
/** The realtime listener's push channel, captured from the subscribe mock. */
let push: (data: Member[]) => void

function renderMemberHooks() {
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children)
  return renderHook(() => ({
    list:       useMembers(TRIP),
    remove:     useRemoveMember(TRIP),
    updateRole: useUpdateMemberRole(TRIP),
  }), { wrapper })
}

beforeEach(() => {
  memberOverlay.__resetForTest()
  vi.clearAllMocks()
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  serviceMocks.getMembersByTripFromServer.mockResolvedValue([])
  serviceMocks.getMembersByTrip.mockResolvedValue([row('a'), row('b')])
  serviceMocks.subscribeToMembers.mockImplementation(
    async (_trip: string, _uid: string, onData: (d: Member[]) => void) => {
      push = onData
      return () => {}
    },
  )
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useRemoveMember', () => {
  it('hides the row while the write is in flight and restores it when refused', async () => {
    serviceMocks.removeMember.mockRejectedValueOnce(rejectedErr())
    const hook = renderMemberHooks()
    await waitFor(() => expect(hook.result.current.list.data).toHaveLength(2))

    await act(async () => {
      await hook.result.current.remove.mutateAsync('a').catch(() => {})
    })

    expect(visible().map(m => m.id)).toEqual(['a', 'b'])
  })

  it('does not discard a snapshot that arrived while the write was in flight', async () => {
    // The rollback bug: `prev` is captured in onMutate, so restoring it on
    // failure also erases every member the listener pushed since — someone
    // redeeming an invite mid-removal would silently vanish from the roster
    // until the next push.
    serviceMocks.removeMember.mockRejectedValueOnce(rejectedErr())
    const hook = renderMemberHooks()
    await waitFor(() => expect(hook.result.current.list.data).toHaveLength(2))

    await act(async () => {
      const failing = hook.result.current.remove.mutateAsync('a').catch(() => {})
      push([row('a'), row('b'), row('c')])
      await failing
    })

    expect(visible().map(m => m.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('concurrent roster edits', () => {
  it('a refused removal leaves an unrelated role change standing', async () => {
    // Two rows, two writes, one fails. Snapshot rollback restored a whole
    // list and so reverted the sibling edit as well; ops only undo their own
    // row.
    serviceMocks.updateMemberRole.mockResolvedValueOnce(undefined)
    serviceMocks.removeMember.mockRejectedValueOnce(rejectedErr())
    const hook = renderMemberHooks()
    await waitFor(() => expect(hook.result.current.list.data).toHaveLength(2))

    await act(async () => {
      const roleChange = hook.result.current.updateRole
        .mutateAsync({ memberId: 'a', role: 'viewer' })
      const removal = hook.result.current.remove.mutateAsync('b').catch(() => {})
      await Promise.all([roleChange, removal])
    })

    expect(visible()).toEqual([
      { id: 'a', role: 'viewer' },
      { id: 'b', role: 'editor' },
    ])
  })

  it('holds the new role until server truth actually carries it', async () => {
    // `confirms` has to check the role, not just the row: retiring against a
    // base that still says `editor` would snap the badge back.
    serviceMocks.updateMemberRole.mockResolvedValueOnce(undefined)
    const hook = renderMemberHooks()
    await waitFor(() => expect(hook.result.current.list.data).toHaveLength(2))

    await act(async () => {
      await hook.result.current.updateRole.mutateAsync({ memberId: 'a', role: 'viewer' })
      push([row('a', 'editor'), row('b')])
    })
    expect(visible()[0]).toEqual({ id: 'a', role: 'viewer' })

    await act(async () => {
      push([row('a', 'viewer'), row('b')])
    })
    expect(visible()[0]).toEqual({ id: 'a', role: 'viewer' })
    expect(memberOverlay.getSnapshot(KEY_HASH)).toHaveLength(0)
  })
})
