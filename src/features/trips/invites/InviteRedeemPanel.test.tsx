import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  refetchMock: vi.fn(),
  useQueryMock: vi.fn(),
}))

vi.mock('@tanstack/react-query', () => ({
  useQuery: mocks.useQueryMock,
}))

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    state: { status: 'signed-in', user: { uid: 'user-1' } },
    signInWithGoogle: vi.fn(),
  }),
}))

vi.mock('@/store/tripStore', () => ({
  useTripStore: { getState: vi.fn() },
}))

vi.mock('@/shared/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('./useInvites', () => ({
  useAcceptInvite: () => ({ isPending: false }),
}))

vi.mock('./inviteService', () => {
  class InviteError extends Error {
    readonly code: 'not-found' | 'expired' | 'unavailable' | 'failed'

    constructor(code: 'not-found' | 'expired' | 'unavailable' | 'failed', message: string) {
      super(message)
      this.name = 'InviteError'
      this.code = code
    }
  }
  return {
    InviteError,
    getInvite: vi.fn(),
    formatInviteExpiry: vi.fn(),
  }
})

import InviteRedeemPanel from './InviteRedeemPanel'
import { InviteError } from './inviteService'

beforeEach(() => {
  mocks.refetchMock.mockReset()
  mocks.useQueryMock.mockReset()
})

describe('InviteRedeemPanel unavailable invite', () => {
  it('offers a retry that refetches the same invite', () => {
    mocks.useQueryMock.mockReturnValue({
      error: new InviteError('unavailable', 'Invite could not be confirmed'),
      isError: true,
      isFetching: false,
      isPending: false,
      refetch: mocks.refetchMock,
    })

    render(
      <InviteRedeemPanel
        tripId="trip-1"
        token={'a'.repeat(64)}
        onDone={() => {}}
        onCancel={() => {}}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '再試一次' }))
    expect(mocks.refetchMock).toHaveBeenCalledOnce()
  })
})
