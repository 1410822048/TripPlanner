import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { Member, Trip } from '@/types'

const harness = vi.hoisted(() => ({
  uid:            'member-1',
  updateRequired: false,
}))

vi.mock('@/components/ui/BottomSheet', () => ({
  default: ({ children, title }: { children: ReactNode; title: string }) => (
    <div role="dialog" aria-label={title}>{children}</div>
  ),
}))
vi.mock('@/components/ui/ConfirmSheet', () => ({ default: () => null }))
vi.mock('@/components/ui/LoadingText', () => ({ default: () => null }))
vi.mock('@/components/ui/MemberAvatar', () => ({ default: () => null }))

const members: Member[] = [
  { id: 'm-owner',  userId: 'owner-1',  role: 'owner',  displayName: 'Owner' },
  { id: 'm-editor', userId: 'member-1', role: 'editor', displayName: 'Editor' },
] as unknown as Member[]

vi.mock('@/features/members/hooks/useMembers', () => ({
  useMembers:           () => ({ data: members, isLoading: false }),
  useRemoveMember:      () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateMemberRole:  () => ({ mutateAsync: vi.fn(), isPending: false }),
  useTransferOwnership: () => ({ mutateAsync: vi.fn(), isPending: false }),
}))
vi.mock('@/hooks/useAuth', () => ({ useUid: () => harness.uid }))
vi.mock('@/hooks/useClientCompatibility', () => ({
  useClientCompatibility: () => ({ updateRequired: harness.updateRequired }),
}))
vi.mock('@/shared/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

import MembersModal from './MembersModal'

const trip = { id: 'trip-1', ownerId: 'owner-1', title: 'Trip' } as unknown as Trip

const renderModal = () => render(
  <MembersModal isOpen onClose={vi.fn()} trip={trip} onLeave={vi.fn()} />,
)
const leaveButton  = () => screen.queryByRole('button', { name: '退出此旅程' })
const manageButtons = () => screen.queryAllByRole('button', { name: /的操作$/ })

beforeEach(() => {
  harness.uid            = 'member-1'
  harness.updateRequired = false
})

describe('MembersModal write gating', () => {
  it('offers leave to a compatible non-owner member', () => {
    renderModal()

    expect(leaveButton()).not.toBeNull()
  })

  it('withdraws leave from a non-owner once the bundle is out of date', () => {
    harness.updateRequired = true
    renderModal()

    expect(leaveButton()).toBeNull()
  })

  it('never offers leave to the owner, blocked or not', () => {
    harness.uid = 'owner-1'
    const compatible = renderModal()
    expect(leaveButton()).toBeNull()
    compatible.unmount()

    // The regression this guards: folding compatibility into `isOwner` would
    // invert through `!isOwner` and hand a blocked owner a leave button that
    // the rules forbid.
    harness.updateRequired = true
    renderModal()
    expect(leaveButton()).toBeNull()
  })

  it('offers per-member management to a compatible owner', () => {
    harness.uid = 'owner-1'
    renderModal()

    // Positive control: without it the "hidden when blocked" case below would
    // pass on an empty list for the wrong reason.
    expect(manageButtons().length).toBeGreaterThan(0)
  })

  it('hides per-member management once the owner is blocked', () => {
    harness.uid            = 'owner-1'
    harness.updateRequired = true
    renderModal()

    expect(manageButtons()).toHaveLength(0)
  })
})
