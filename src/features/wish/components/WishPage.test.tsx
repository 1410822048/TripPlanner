import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Wish } from '@/types'

const harness = vi.hoisted(() => ({
  closeModal: vi.fn(),
  setModalError: vi.fn(),
  createWish: vi.fn(),
  deleteWish: vi.fn(),
  setDeadline: vi.fn(),
  wishes: [] as Wish[],
  writeBlockReason: null as string | null,
  modalScopeChanged: false,
  cloudTripId: 'trip-1' as string | undefined,
  isDemo: false,
  // Non-null = a trip-level voting deadline; toMillis in the past closes voting.
  deadlineAt: null as { toMillis: () => number } | null,
}))

const toastMocks = vi.hoisted(() => ({
  error: vi.fn(), success: vi.fn(), info: vi.fn(), mutationError: vi.fn(),
}))
vi.mock('@/shared/toast', () => ({ toast: toastMocks }))

vi.mock('@/hooks/useFeatureListPage', () => ({
  useFeatureListPage: () => ({
    // ctx.status stays 'cloud' even for the demo-transition test: the
    // handler under test reads only the destructured isDemo/cloudTripId,
    // and a real 'demo' status would drag in the mock-data render pipeline
    // these mocks don't provide.
    ctx: {
      status: 'cloud',
      trip: {
        id: harness.cloudTripId ?? 'demo',
        title: 'Tokyo',
        wishVotingDeadlineAt: harness.deadlineAt,
        wishVotingDeadlineNotifiedAt: null,
      },
    },
    uid: 'u1',
    cloudTripId: harness.cloudTripId,
    mutationTripId: harness.cloudTripId ?? '',
    isDemo: harness.isDemo,
    isOwner: false,
    canOwnerWrite: false,
    writeCompatible: harness.writeBlockReason === null,
    modal: {
      isOpen: true,
      key: 'new',
      editTarget: null as Wish | null,
      saveError: null,
      scopeChanged: harness.modalScopeChanged,
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
    useWishes: () => ({ data: harness.wishes, isLoading: false }),
    useCreateWish: () => ({ mutate: harness.createWish }),
    useUpdateWish: () => ({ mutate: vi.fn() }),
    useDeleteWish: () => ({ mutate: harness.deleteWish }),
    useToggleWishVote: () => ({ mutate: vi.fn() }),
  }
})

vi.mock('@/features/members/hooks/useMembers', () => ({ useMembers: () => ({ data: [] }) }))
vi.mock('@/features/members/utils', () => ({ membersToTripMembers: () => [] }))
vi.mock('@/features/trips/hooks/useTrips', () => ({
  useSetWishVotingDeadline: () => ({ mutate: harness.setDeadline, isPending: false }),
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
vi.mock('./WishCard', () => ({
  // Surfaces the proposer/owner delete path plus the gate that decides whether
  // the menu item renders at all.
  default: ({ canDelete, onDelete }: { canDelete: boolean; onDelete: () => void }) =>
    canDelete
      ? <button type="button" onClick={onDelete}>mock wish delete</button>
      : null,
}))
vi.mock('./WishDetailSheet', () => ({ default: () => null }))
// Unconditional open button: the real bar gates on canSetDeadline, but these
// tests drive the sheet lifecycle, not the affordance gating.
vi.mock('./WishVotingDeadlineBar', () => ({
  default: ({ onOpenSheet }: { onOpenSheet: () => void }) => (
    <button type="button" onClick={onOpenSheet}>mock open deadline</button>
  ),
}))
vi.mock('./WishDeadlineSheet', () => ({
  default: ({ onSave }: { onSave: (d: Date | null) => void }) => (
    <div role="dialog" aria-label="deadline-sheet">
      <button type="button" onClick={() => onSave(null)}>mock deadline save</button>
    </div>
  ),
}))
vi.mock('./WishListSkeleton', () => ({ default: () => null }))
vi.mock('./WishPageSkeleton', () => ({ default: () => null }))
vi.mock('@/components/ui/NoTripEmptyState', () => ({ default: () => null }))
vi.mock('@/components/ui/DemoBanner', () => ({ default: () => null }))
vi.mock('@/components/ui/PageHeader', () => ({ default: () => null }))
vi.mock('@/components/ui/ListEmptyCard', () => ({ default: () => <div /> }))
vi.mock('@/features/auth/components/SignInPromptModal', () => ({ default: () => null }))

import WishPage from './WishPage'

const wish = (over: Partial<Wish> = {}): Wish => ({
  id: 'w-1', tripId: 'trip-1', category: 'place', title: '淺草',
  proposedBy: 'u1', votes: [], ...over,
} as Wish)

beforeEach(() => {
  harness.closeModal.mockReset()
  harness.setModalError.mockReset()
  harness.createWish.mockReset()
  harness.deleteWish.mockReset()
  harness.setDeadline.mockReset()
  harness.wishes = []
  harness.writeBlockReason = null
  harness.modalScopeChanged = false
  harness.cloudTripId = 'trip-1'
  harness.isDemo = false
  harness.deadlineAt = null
  toastMocks.error.mockReset()
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

  it('offers the proposer a delete while the bundle is current', () => {
    harness.wishes = [wish()]        // proposedBy === the signed-in uid

    render(<WishPage />)

    // Positive control: the hidden-when-blocked case below would otherwise
    // pass simply because nothing rendered.
    expect(screen.getByRole('button', { name: 'mock wish delete' })).toBeTruthy()
  })

  it('withdraws the proposer delete once the bundle is out of date', () => {
    harness.wishes = [wish()]
    harness.writeBlockReason = '請先更新 App 才能儲存'

    render(<WishPage />)

    // Proposer delete rides on neither canWrite nor canOwnerWrite, so
    // compatibility has to be checked in canDelete itself.
    expect(screen.queryByRole('button', { name: 'mock wish delete' })).toBeNull()
  })

  it('explains the stale bundle if a menu opened before the flip still submits', () => {
    harness.wishes = [wish()]

    const view = render(<WishPage />)
    harness.writeBlockReason = '請先更新 App 才能儲存'
    fireEvent.click(screen.getByRole('button', { name: 'mock wish delete' }))
    view.unmount()

    expect(harness.deleteWish).not.toHaveBeenCalled()
    expect(toastMocks.error).toHaveBeenCalledWith('請先更新 App 才能儲存')
  })
})

describe('WishPage cross-trip scope', () => {
  it('checks the scope BEFORE the live trip deadline so the draft survives', () => {
    // The form was opened on trip A; the live trip is now an already-closed
    // trip B. votingClosed-first would close the modal and eat the draft —
    // the scope refusal must win.
    harness.modalScopeChanged = true
    harness.deadlineAt = { toMillis: () => 1 }   // long past → votingClosed

    render(<WishPage />)
    fireEvent.click(screen.getByRole('button', { name: 'mock wish save' }))

    expect(harness.createWish).not.toHaveBeenCalled()
    expect(harness.setModalError).toHaveBeenCalledWith('旅程或帳號已切換，請關閉表單後重新開啟')
    expect(harness.closeModal).not.toHaveBeenCalled()
    expect(toastMocks.error).not.toHaveBeenCalledWith('投票已截止')
  })

  it('refuses to write a deadline into a trip the sheet was not opened on', () => {
    const view = render(<WishPage />)
    fireEvent.click(screen.getByRole('button', { name: 'mock open deadline' }))

    harness.cloudTripId = 'trip-2'
    view.rerender(<WishPage />)
    fireEvent.click(screen.getByRole('button', { name: 'mock deadline save' }))

    expect(harness.setDeadline).not.toHaveBeenCalled()
    expect(toastMocks.error).toHaveBeenCalledWith('旅程或帳號已切換，請關閉表單後重新開啟')
    // Sheet stays open — the owner closes and redoes it deliberately.
    expect(screen.getByRole('dialog', { name: 'deadline-sheet' })).toBeTruthy()
  })

  it('fails closed instead of going silent when the live trip vanishes', () => {
    const view = render(<WishPage />)
    fireEvent.click(screen.getByRole('button', { name: 'mock open deadline' }))

    // cloud → demo: cloudTripId is gone. The old `if (!cloudTripId) return`
    // was a silent no-op — the fail-closed copy must surface instead.
    harness.isDemo = true
    harness.cloudTripId = undefined
    view.rerender(<WishPage />)
    fireEvent.click(screen.getByRole('button', { name: 'mock deadline save' }))

    expect(harness.setDeadline).not.toHaveBeenCalled()
    expect(toastMocks.error).toHaveBeenCalledWith('旅程或帳號已切換，請關閉表單後重新開啟')
    expect(screen.getByRole('dialog', { name: 'deadline-sheet' })).toBeTruthy()
  })

  it('saves the deadline when the sheet scope still matches (positive control)', () => {
    render(<WishPage />)
    fireEvent.click(screen.getByRole('button', { name: 'mock open deadline' }))
    fireEvent.click(screen.getByRole('button', { name: 'mock deadline save' }))

    expect(harness.setDeadline).toHaveBeenCalledWith({ tripId: 'trip-1', deadlineAt: null })
  })
})
