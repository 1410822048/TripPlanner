import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { Invite, Trip } from '@/types'

const harness = vi.hoisted(() => ({
  writeBlockReason: null as string | null,
  createInvite:     vi.fn(async () => undefined),
  revokeInvite:     vi.fn(async () => undefined),
  toastError:       vi.fn(),
}))

vi.mock('@/components/ui/BottomSheet', () => ({
  default: ({ children, title }: { children: ReactNode; title: string }) => (
    <div role="dialog" aria-label={title}>{children}</div>
  ),
}))
vi.mock('@/components/ui/LoadingText', () => ({ default: () => null }))
vi.mock('qrcode.react', () => ({ QRCodeSVG: () => null }))

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ state: { status: 'signed-in', user: { uid: 'owner-1' } } }),
}))
vi.mock('@/services/clientCompatibility', () => ({
  getClientWriteBlockReason: () => harness.writeBlockReason,
}))
vi.mock('@/shared/toast', () => ({
  toast: { error: harness.toastError, success: vi.fn() },
}))

// A live, non-expired invite so the sheet renders the revoke button.
const invite = {
  id: 'invite-1', tripId: 'trip-1', role: 'editor',
  expiresAt: { toMillis: () => Date.now() + 3_600_000 },
} as unknown as Invite

vi.mock('./useInvites', () => ({
  useInvites:      () => ({ data: [invite], isLoading: false }),
  useCreateInvite: () => ({ mutateAsync: harness.createInvite, isPending: false }),
  useRevokeInvite: () => ({ mutateAsync: harness.revokeInvite, isPending: false }),
}))
vi.mock('./inviteService', () => ({ formatInviteExpiry: () => '剩餘 5 小時' }))

import InviteModal from './InviteModal'

const trip = { id: 'trip-1', ownerId: 'owner-1', title: 'Trip' } as unknown as Trip

const renderModal = () => render(
  <InviteModal isOpen onClose={vi.fn()} trip={trip} />,
)
const generateButton = () => screen.getByRole('button', { name: /建立邀請連結/ })
const revokeButton   = () => screen.getByRole('button', { name: '撤銷' })

beforeEach(() => {
  harness.writeBlockReason = null
  harness.createInvite.mockClear()
  harness.revokeInvite.mockClear()
  harness.toastError.mockClear()
})

// The invite entry point is hidden once the epoch flips, but a sheet that is
// ALREADY open stays mounted — and the global MutationCache deliberately
// swallows UpdateRequiredError, so without an in-handler preflight the two
// buttons would silently do nothing.
describe('InviteModal stale-open write gating', () => {
  it('generates an invite when the bundle is compatible (positive control)', async () => {
    renderModal()

    fireEvent.click(generateButton())
    await Promise.resolve()

    expect(harness.createInvite).toHaveBeenCalledOnce()
    expect(harness.toastError).not.toHaveBeenCalled()
  })

  it('refuses to generate on a stale bundle and says why', () => {
    harness.writeBlockReason = '請先更新 App 才能儲存'
    renderModal()

    fireEvent.click(generateButton())

    expect(harness.createInvite).not.toHaveBeenCalled()
    expect(harness.toastError).toHaveBeenCalledWith('請先更新 App 才能儲存')
  })

  it('refuses to revoke on a stale bundle and says why', () => {
    harness.writeBlockReason = '請先更新 App 才能儲存'
    renderModal()

    fireEvent.click(revokeButton())

    expect(harness.revokeInvite).not.toHaveBeenCalled()
    expect(harness.toastError).toHaveBeenCalledWith('請先更新 App 才能儲存')
  })
})
