import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlanItem } from '@/types'

const harness = vi.hoisted(() => ({
  canWrite: false,
  writeBlockReason: '請先更新 App 才能儲存' as string | null,
  deleteItem: vi.fn(),
}))

const item = {
  id: 'plan-1', tripId: 'trip-1', category: 'essentials', title: '護照',
  completedBy: {}, createdBy: 'u1', updatedBy: 'u1',
} as unknown as PlanItem

vi.mock('@/hooks/useFeatureListPage', () => ({
  useFeatureListPage: () => ({
    ctx: { status: 'cloud', trip: { id: 'trip-1', title: 'Tokyo' } },
    uid: 'u1',
    cloudTripId: 'trip-1',
    mutationTripId: 'trip-1',
    isDemo: false,
    canWrite: harness.canWrite,
    modal: {
      isOpen: false, key: 'closed', editTarget: null, saveError: null,
      openAdd: vi.fn(), openEdit: vi.fn(), close: vi.fn(),
      setError: vi.fn(), clearError: vi.fn(),
    },
    signIn: { isOpen: false, open: vi.fn(), close: vi.fn() },
  }),
}))
vi.mock('../hooks/usePlanning', () => ({
  usePlanning: () => ({ data: [item], isLoading: false }),
  useCreatePlanItem: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdatePlanItem: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useTogglePlanItem: () => ({ mutate: vi.fn() }),
  useDeletePlanItem: () => ({ mutateAsync: harness.deleteItem }),
}))
vi.mock('@/features/members/hooks/useMembers', () => ({
  useMembers: () => ({ data: [] }),
}))
vi.mock('@/services/clientCompatibility', () => ({
  getClientWriteBlockReason: () => harness.writeBlockReason,
}))

const toastMocks = vi.hoisted(() => ({ error: vi.fn() }))
vi.mock('@/shared/toast', () => ({ toast: toastMocks }))

// Expose the callback even though the current render already withdrew the
// affordance. This models a click dispatched from a row opened before the
// compatibility snapshot flipped.
vi.mock('./PlanningRow', () => ({
  default: ({ onDelete }: { onDelete: () => void }) => (
    <button type="button" onClick={onDelete}>stale-swipe-delete</button>
  ),
}))
vi.mock('./PlanningFormModal', () => ({ default: () => null }))
vi.mock('@/features/auth/components/SignInPromptModal', () => ({ default: () => null }))

import PlanningPage from './PlanningPage'

beforeEach(() => {
  harness.canWrite = false
  harness.writeBlockReason = '請先更新 App 才能儲存'
  harness.deleteItem.mockReset()
  toastMocks.error.mockReset()
})

describe('PlanningPage stale swipe preflight', () => {
  it('reports the Schema Epoch block before role permission', () => {
    render(<PlanningPage />)

    fireEvent.click(screen.getByRole('button', { name: 'stale-swipe-delete' }))

    expect(harness.deleteItem).not.toHaveBeenCalled()
    expect(toastMocks.error).toHaveBeenCalledWith('請先更新 App 才能儲存')
    expect(toastMocks.error).not.toHaveBeenCalledWith('你沒有刪除權限')
  })
})
