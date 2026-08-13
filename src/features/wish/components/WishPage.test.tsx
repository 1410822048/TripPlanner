import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Wish } from '@/types'

const harness = vi.hoisted(() => ({
  closeModal: vi.fn(),
  setModalError: vi.fn(),
  createWish: vi.fn(),
  writeBlockReason: null as string | null,
}))

vi.mock('@/hooks/useFeatureListPage', () => ({
  useFeatureListPage: () => ({
    ctx: {
      status: 'cloud',
      trip: {
        id: 'trip-1',
        title: 'Tokyo',
        wishVotingDeadlineAt: null,
        wishVotingDeadlineNotifiedAt: null,
      },
    },
    uid: 'u1',
    cloudTripId: 'trip-1',
    mutationTripId: 'trip-1',
    isDemo: false,
    isOwner: false,
    modal: {
      isOpen: true,
      key: 'new',
      editTarget: null as Wish | null,
      saveError: null,
      openAdd: vi.fn(),
      openEdit: vi.fn(),
      close: harness.closeModal,
      setError: harness.setModalError,
    },
    signIn: { isOpen: false, open: vi.fn(), close: vi.fn() },
  }),
}))

vi.mock('../hooks/useWishes', async () => {
  const { createListOverlay } = await vi.importActual<typeof import('@/hooks/listOverlay')>(
    '@/hooks/listOverlay',
  )
  return {
    wishKeys: { all: (tripId: string, uid?: string) => ['wishes', tripId, uid ?? ''] },
    wishOverlay: createListOverlay({ insert: 'head', source: 'wishes-test' }),
    useWishes: () => ({ data: [], isLoading: false }),
    useCreateWish: () => ({ mutate: harness.createWish }),
    useUpdateWish: () => ({ mutate: vi.fn() }),
    useDeleteWish: () => ({ mutate: vi.fn() }),
    useToggleWishVote: () => ({ mutate: vi.fn() }),
  }
})

vi.mock('@/features/members/hooks/useMembers', () => ({ useMembers: () => ({ data: [] }) }))
vi.mock('@/features/members/utils', () => ({ membersToTripMembers: () => [] }))
vi.mock('@/features/trips/hooks/useTrips', () => ({
  useSetWishVotingDeadline: () => ({ mutate: vi.fn(), isPending: false }),
}))
vi.mock('@/services/clientCompatibility', () => ({
  getClientWriteBlockReason: () => harness.writeBlockReason,
}))

vi.mock('./WishFormModal', () => ({
  default: ({ onSave }: {
    onSave: (result: {
      input: { category: 'place'; title: string }
      attachment: null
    }) => void
  }) => (
    <div role="dialog" aria-label="wish-form">
      <button
        type="button"
        onClick={() => onSave({ input: { category: 'place', title: '淺草' }, attachment: null })}
      >
        mock wish save
      </button>
    </div>
  ),
}))
vi.mock('./WishCard', () => ({ default: () => null }))
vi.mock('./WishDetailSheet', () => ({ default: () => null }))
vi.mock('./WishVotingDeadlineBar', () => ({ default: () => null }))
vi.mock('./WishDeadlineSheet', () => ({ default: () => null }))
vi.mock('./WishListSkeleton', () => ({ default: () => null }))
vi.mock('./WishPageSkeleton', () => ({ default: () => null }))
vi.mock('@/components/ui/NoTripEmptyState', () => ({ default: () => null }))
vi.mock('@/components/ui/DemoBanner', () => ({ default: () => null }))
vi.mock('@/components/ui/PageHeader', () => ({ default: () => null }))
vi.mock('@/components/ui/ListEmptyCard', () => ({ default: () => <div /> }))
vi.mock('@/features/auth/components/SignInPromptModal', () => ({ default: () => null }))

import WishPage from './WishPage'

beforeEach(() => {
  harness.closeModal.mockReset()
  harness.setModalError.mockReset()
  harness.createWish.mockReset()
  harness.writeBlockReason = null
})

describe('WishPage write compatibility preflight', () => {
  it('keeps the optimistic-close form mounted and preserves its draft when blocked', () => {
    harness.writeBlockReason = '請先更新 App 才能儲存'

    render(<WishPage />)
    fireEvent.click(screen.getByRole('button', { name: 'mock wish save' }))

    expect(harness.setModalError).toHaveBeenCalledWith('請先更新 App 才能儲存')
    expect(harness.closeModal).not.toHaveBeenCalled()
    expect(harness.createWish).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'wish-form' })).toBeTruthy()
  })
})
