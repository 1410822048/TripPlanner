import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { ReactNode } from 'react'
import type { Trip } from '@/types'

const toastMocks = vi.hoisted(() => ({ info: vi.fn() }))
vi.mock('@/shared/toast', () => ({ toast: toastMocks }))

import { useScheduleModals } from './useScheduleModals'

const TRIP = { id: 'trip-1', title: 'Tokyo' } as Trip

type RouterEntries = NonNullable<Parameters<typeof MemoryRouter>[0]['initialEntries']>

/** Real router, so the deep-link consume/replace runs for real. */
function wrapper(entries: RouterEntries) {
  return ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={entries}>{children}</MemoryRouter>
  )
}

function render(
  opts: { isDemo?: boolean; currentTrip?: Trip | null } = {},
  entries: RouterEntries = ['/schedule'],
) {
  // `??` would swallow an explicit null, which is the case that matters
  // for the no-trip branch.
  const currentTrip = 'currentTrip' in opts ? opts.currentTrip! : TRIP
  return renderHook(
    () => useScheduleModals({ isDemo: opts.isDemo ?? false, currentTrip }),
    { wrapper: wrapper(entries) },
  )
}

beforeEach(() => {
  toastMocks.info.mockReset()
})

describe('useScheduleModals deep link', () => {
  it('opens the create-trip modal once and clears the navigation state', () => {
    const hook = render({}, [{ pathname: '/schedule', state: { openCreateTrip: true } }])

    expect(hook.result.current.createTripOpen).toBe(true)

    // The flag was replaced away, so dismissing the modal must not let a
    // re-render (or a back-button revisit) pop it open again.
    act(() => hook.result.current.setCreateTripOpen(false))
    hook.rerender()

    expect(hook.result.current.createTripOpen).toBe(false)
  })

  it('leaves the modal shut without the flag', () => {
    expect(render().result.current.createTripOpen).toBe(false)
  })
})

describe('useScheduleModals trip menu', () => {
  it('opens the matching modal when signed in', () => {
    const hook = render()

    act(() => hook.result.current.handleMenuAction('members'))
    expect(hook.result.current.membersOpen).toBe(true)

    act(() => hook.result.current.handleMenuAction('share'))
    expect(hook.result.current.inviteOpen).toBe(true)
  })

  it('diverts every cloud-only action to the sign-in prompt in demo mode', () => {
    for (const key of ['members', 'share', 'copy'] as const) {
      const hook = render({ isDemo: true })
      act(() => hook.result.current.handleMenuAction(key))

      expect(hook.result.current.signInOpen).toBe(true)
      expect(hook.result.current.membersOpen).toBe(false)
      expect(hook.result.current.inviteOpen).toBe(false)
      expect(hook.result.current.copyTripOpen).toBe(false)
    }
  })

  it('still allows editing in demo mode', () => {
    const hook = render({ isDemo: true })
    act(() => hook.result.current.handleMenuAction('edit'))

    expect(hook.result.current.editTripOpen).toBe(true)
    expect(hook.result.current.signInOpen).toBe(false)
  })

  it('snapshots the copy source so a later trip switch cannot re-key the modal', () => {
    const hook = render()
    act(() => hook.result.current.handleMenuAction('copy'))

    expect(hook.result.current.copyTripOpen).toBe(true)
    expect(hook.result.current.copyTripSource).toBe(TRIP)

    // currentTrip changes underneath (the copy mutation selects the new
    // trip); the snapshot must not follow, or the modal re-keys mid-close.
    hook.rerender()
    expect(hook.result.current.copyTripSource).toBe(TRIP)
  })

  it('does not open the copy modal without a trip to copy', () => {
    const hook = render({ currentTrip: null })
    act(() => hook.result.current.handleMenuAction('copy'))

    expect(hook.result.current.copyTripOpen).toBe(false)
    expect(hook.result.current.copyTripSource).toBeNull()
  })
})

describe('useScheduleModals anyOpen', () => {
  it('stays false until something opens, and covers each flag', () => {
    const hook = render()
    expect(hook.result.current.anyOpen).toBe(false)

    act(() => hook.result.current.setInviteScannerOpen(true))
    expect(hook.result.current.anyOpen).toBe(true)

    act(() => hook.result.current.setInviteScannerOpen(false))
    expect(hook.result.current.anyOpen).toBe(false)

    act(() => hook.result.current.scheduleModal.openAdd())
    expect(hook.result.current.anyOpen).toBe(true)
  })

  it('excludes the detail sheet, which the page gates on a resolved schedule', () => {
    const hook = render()
    act(() => hook.result.current.openScheduleDetail({ id: 's-1' } as never))

    expect(hook.result.current.scheduleDetailId).toBe('s-1')
    expect(hook.result.current.anyOpen).toBe(false)
  })
})
